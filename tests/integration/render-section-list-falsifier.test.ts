import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  loadProgramByConvention,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import type { PgasServerConfig } from '@simodelne/pgas-server/create-server.js';
import { describe, expect, it } from 'vitest';

import { startRouteHarness } from './foundry-test-utils.js';
import { createDeclarativeRenderProvider } from './fixtures/render-provider.golden.js';

// ─────────────────────────────────────────────────────────────────────────────
// pgas#1045 `RenderSectionList` HERMETIC falsifier — the 0-TS docx migration
// for the foundry's PER-APPROVED-ITEM deliverable class.
//
// The class the foundry actually generates is: N multi-paragraph prose sections,
// one per APPROVED collection item, where N is only known at runtime. Before
// 5.7.1 that shape had no declarative expression, so the foundry emitted the
// imperative `approvedContentSectionsFromDomain` / `sectionsFromDomain`
// shape-mapping stage-body TS. #1045 shipped `RenderSectionList`, so this
// falsifier proves the whole chain WITHOUT that TS:
//
//   program-owned approval (item.status)
//     → ENGINE-derived approved bucket (derived_paths items_where_field_eq)
//     → declarative `render:` TOP-LEVEL section_list over that bucket
//     → engine `buildProviderRenderRequest` projection
//     → the ONE generic consumer RenderProvider (pure IR→OOXML serializer)
//     → engine ArtifactStore → first-class artifactType:"render" record.
//
// Approval FILTERING stays PROGRAM-OWNED and UPSTREAM (the engine-derived
// bucket); `render:` never filters.
//
// KILL PROOFS (both must be observed to actually kill):
//   K-1  rebind the section_list `from` to a DIFFERENT world path ⇒ the approved
//        prose VANISHES from the produced docx bytes.
//   K-2  an EMPTY approved bucket ⇒ ZERO sections and NO fabricated
//        scaffold/placeholder content in the bytes.
//
// G-1 pins the REMAINING BLOCKER. The foundry's export stage is an AUTHOR-LESS
// `decision_only` mode (pgas-new #253) that fires an `OnTransition` integration
// hook — deliberately no LLM round. But `capability: render`'s declarative
// projection only fires for an EffectAction payload whose OWN keys are exactly
// the `{artifact_id}` selector, and the engine's hook envelope is
// `{action, event, domain}` — so the projection is skipped and the RAW envelope
// reaches the RenderProvider. G-1 pins that observed failure. See
// docs/curator-requests/2026-08-24-declarative-render-dispatch-author-less-stage.md.
// When the engine ships a declared hook payload G-1 FAILS — that is the signal to
// complete the emission migration and delete the shape-mapping TS.
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM = 'render-section-list-falsifier';
const ARTIFACT_ID = 'opinion_docx';
const APPROVED_BUCKET = 'summary.approve.status_buckets.accepted';
const REJECTED_BUCKET = 'summary.approve.status_buckets.rejected';
const HOOK_PROGRAM = 'render-section-list-hook-gap';
const HOOK_EXPORT_MODE = 'render_export';

interface StoredArtifact {
  artifactId: string;
  payloadRef: string;
  userId: string;
  sessionId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  bytes: Uint8Array;
}

/** In-memory ArtifactStore injected via `adapters.artifactStore` (hermetic). */
class InMemoryArtifactStore {
  readonly puts: StoredArtifact[] = [];
  private readonly byRef = new Map<string, StoredArtifact>();

  async put(userId: string, sessionId: string, bytes: Uint8Array, contentType: string, filename?: string): Promise<{
    artifactId: string;
    payloadRef: string;
    userId: string;
    sessionId: string;
    filename: string;
    contentType: string;
    size: number;
    createdAt: number;
  }> {
    const artifactId = randomUUID();
    const payloadRef = `mem://${randomUUID()}`;
    const record: StoredArtifact = {
      artifactId,
      payloadRef,
      userId,
      sessionId,
      filename: filename ?? 'artifact.bin',
      contentType,
      size: bytes.byteLength,
      createdAt: Date.now(),
      bytes: bytes.slice(),
    };
    this.puts.push(record);
    this.byRef.set(payloadRef, record);
    const { bytes: _omit, ...ref } = record;
    return ref;
  }

  async get(payloadRef: string): Promise<Uint8Array | null> {
    return this.byRef.get(payloadRef)?.bytes.slice() ?? null;
  }

  async delete(payloadRef: string): Promise<boolean> {
    return this.byRef.delete(payloadRef);
  }

  async deleteBySession(sessionId: string): Promise<number> {
    let n = 0;
    for (const [ref, rec] of this.byRef) {
      if (rec.sessionId === sessionId) {
        this.byRef.delete(ref);
        n += 1;
      }
    }
    return n;
  }

  async deleteByUser(userId: string): Promise<number> {
    let n = 0;
    for (const [ref, rec] of this.byRef) {
      if (rec.userId === userId) {
        this.byRef.delete(ref);
        n += 1;
      }
    }
    return n;
  }
}

interface SeedItem {
  id: string;
  title: string;
  proposed_text: string;
  status: string;
}

describe('pgas#1045 RenderSectionList per-approved-item hermetic falsifier', () => {
  it('S-1 (positive): engine-derived approved bucket → top-level section_list → one docx section per approved item', async () => {
    const approvedA = `APPROVED-A-${randomUUID()}`;
    const approvedB = `APPROVED-B-${randomUUID()}`;
    const rejected = `REJECTED-C-${randomUUID()}`;
    const headingA = `Heading A ${randomUUID()}`;
    const headingB = `Heading B ${randomUUID()}`;
    const headingC = `Heading C ${randomUUID()}`;

    const drive = await runRenderDrive({
      listFrom: APPROVED_BUCKET,
      items: [
        { id: 'sec-1', title: headingA, proposed_text: approvedA, status: 'accepted' },
        { id: 'sec-2', title: headingC, proposed_text: rejected, status: 'rejected' },
        { id: 'sec-3', title: headingB, proposed_text: approvedB, status: 'accepted' },
      ],
    });

    expect(drive.finalMode, 'session reached terminal').toBe('complete');
    // the engine's items_where_field_eq derivation is the PROGRAM-OWNED approval
    // filter — render never filters.
    expect(drive.approvedBucket, 'engine-derived approved bucket holds exactly the accepted items')
      .toHaveLength(2);

    expect(drive.store.puts.length, 'one ArtifactRef.put by the render capability').toBe(1);
    const stored = drive.store.puts[0]!;
    expect(stored.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const record = drive.artifactRecords.find((r) => r.payloadRef === stored.payloadRef);
    expect(record?.artifactType, 'first-class artifactType:"render" record').toBe('render');

    const bytes = await drive.store.get(stored.payloadRef);
    expect(bytes, 'artifact bytes retrievable from ArtifactStore').toBeTruthy();
    expect([bytes![0], bytes![1], bytes![2], bytes![3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const docXml = extractEntryText(bytes!, 'word/document.xml');

    // one section per APPROVED item, each carrying that item's authored prose.
    expect(docXml, 'approved item A prose present').toContain(approvedA);
    expect(docXml, 'approved item B prose present').toContain(approvedB);
    expect(docXml, 'approved item A heading present').toContain(escapeXmlLike(headingA));
    expect(docXml, 'approved item B heading present').toContain(escapeXmlLike(headingB));
    // the REJECTED item never reaches the deliverable — because it is not in the
    // program-owned approved bucket the section_list reads.
    expect(docXml, 'rejected item prose absent').not.toContain(rejected);
    expect(docXml, 'rejected item heading absent').not.toContain(escapeXmlLike(headingC));
    expect(countOccurrences(docXml, '<w:p>'), 'section count scales with the bucket').toBeGreaterThan(0);
  });

  it('K-1 (KILL): rebinding the section_list `from` to another world path makes the approved prose vanish', async () => {
    const approvedA = `APPROVED-A-${randomUUID()}`;
    const rejected = `REJECTED-C-${randomUUID()}`;
    const headingA = `Heading A ${randomUUID()}`;
    const headingC = `Heading C ${randomUUID()}`;

    // identical world; the ONLY change is the declared `from` path.
    const drive = await runRenderDrive({
      listFrom: REJECTED_BUCKET,
      items: [
        { id: 'sec-1', title: headingA, proposed_text: approvedA, status: 'accepted' },
        { id: 'sec-2', title: headingC, proposed_text: rejected, status: 'rejected' },
      ],
    });

    expect(drive.store.puts.length, 'render still produced a docx').toBe(1);
    const stored = drive.store.puts[0]!;
    const bytes = await drive.store.get(stored.payloadRef);
    const docXml = extractEntryText(bytes!, 'word/document.xml');

    // THE KILL: the approved prose can only reach the bytes through the declared
    // `from` binding. Rebound off the approved bucket, it is gone.
    expect(docXml, 'approved prose absent once `from` is rebound').not.toContain(approvedA);
    expect(docXml, 'approved heading absent once `from` is rebound').not.toContain(escapeXmlLike(headingA));
    // the rebound path DID flow through — the kill is a binding break, not a crash.
    expect(docXml, 'the rebound bucket flowed through').toContain(rejected);
    expect([bytes![0], bytes![1], bytes![2], bytes![3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('K-2 (KILL): an empty approved bucket renders ZERO sections and fabricates nothing', async () => {
    const rejected = `REJECTED-ONLY-${randomUUID()}`;
    const headingC = `Heading C ${randomUUID()}`;

    const drive = await runRenderDrive({
      listFrom: APPROVED_BUCKET,
      items: [
        { id: 'sec-1', title: headingC, proposed_text: rejected, status: 'rejected' },
      ],
    });

    expect(drive.approvedBucket, 'approved bucket is empty').toHaveLength(0);
    expect(drive.store.puts.length, 'render still produced a docx').toBe(1);
    const stored = drive.store.puts[0]!;
    const bytes = await drive.store.get(stored.payloadRef);
    const docXml = extractEntryText(bytes!, 'word/document.xml');

    // THE KILL: zero sections. The renderer never materialises an item, and no
    // placeholder / scaffold / "no content available" prose is fabricated.
    expect(countOccurrences(docXml, '<w:p>'), 'zero paragraphs — zero sections').toBe(0);
    expect(docXml, 'the non-approved item is not smuggled in').not.toContain(rejected);
    expect(docXml, 'no fabricated scaffold heading').not.toContain(escapeXmlLike(headingC));
    expect(docXml.toLowerCase(), 'no fabricated placeholder prose').not.toContain('no accumulated');
    // still a real, valid OOXML container — an empty deliverable, not a crash.
    expect([bytes![0], bytes![1], bytes![2], bytes![3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(hasSignature(bytes!, [0x50, 0x4b, 0x05, 0x06]), 'EOCD present').toBe(true);
  });
});

describe('pgas#1045 author-less dispatch gap guard', () => {
  it('G-1 (GAP): a decision_only stage CANNOT dispatch capability: render — the OnTransition hook envelope is not the {artifact_id} selector', async () => {
    const outcome = await runHookDispatchDrive();

    // OBSERVED (engine 5.7.1): the capability binding DOES route the hook to the
    // render capability handler, but `{action, event, domain}` fails the exact
    // `{artifact_id}` selector test, so `buildProviderRenderRequest` never runs
    // and the raw hook envelope is handed to the generic RenderProvider, which
    // correctly refuses it. No artifact is written and the session fails.
    expect(outcome.puts, 'no artifact minted from an author-less decision-only stage').toBe(0);
    expect(outcome.error, 'the generic provider refused the raw hook envelope').toContain(
      'request.format must be "docx"',
    );

    // The world was fully ready: the render would have had real content to emit
    // had the selector reached it. The blocker is DISPATCH, not the grammar
    // (S-1/K-1/K-2 above prove the grammar).
    expect(outcome.seededItems, 'the collection the render would have read was populated').toBe(1);
  });
});

// ───────────────────────────── engine drive ─────────────────────────────

interface RenderDriveResult {
  store: InMemoryArtifactStore;
  finalMode: string | null;
  approvedBucket: unknown[];
  artifactRecords: Array<{ artifactType?: string; payloadRef?: string }>;
}

async function runRenderDrive(input: { listFrom: string; items: SeedItem[] }): Promise<RenderDriveResult> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-section-list-falsifier-'));
  const programDir = path.join(tempDir, 'programs', PROGRAM);
  mkdirSync(programDir, { recursive: true });
  writeFileSync(path.join(programDir, 'specs.yml'), renderSpecYaml(input.listFrom), 'utf8');

  const store = new InMemoryArtifactStore();
  const entry = createConventionEntry(tempDir);

  const author = scriptedAuthor([
    ...input.items.map((item) => effect('seed_section', { item }, 'stage_output')),
    effect('finish_seeding', {}, 'stage_output'),
    effect('render_document', { artifact_id: ARTIFACT_ID }, 'render_out'),
  ]);

  const { client, close } = await startRouteHarness({
    programs: [{ name: PROGRAM, entry }],
    authorHandle: author,
    observerModelId: 'section-list-falsifier-observer',
    renderProvider: createDeclarativeRenderProvider(),
    artifactStore: store as unknown as NonNullable<PgasServerConfig['adapters']>['artifactStore'],
    storage: { uploadsDir: path.join(tempDir, 'uploads') },
  });

  try {
    const created = await client.sessions.create({ program: PROGRAM });
    for (let i = 0; i < input.items.length; i += 1) {
      await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: `seed ${String(i)}` });
    }
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'finish seeding' });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'render the docx' });
    const finalSession = await client.sessions.get(created.sessionId);
    let artifactRecords: Array<{ artifactType?: string; payloadRef?: string }> = [];
    try {
      const raw = await client.sessions.systemArtifacts({ program: PROGRAM });
      artifactRecords = extractArtifactRecords(raw);
    } catch {
      artifactRecords = [];
    }
    return {
      store,
      finalMode: modeOf(finalSession),
      approvedBucket: bucketOf(finalSession, APPROVED_BUCKET),
      artifactRecords,
    };
  } finally {
    await close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

interface HookDispatchOutcome {
  puts: number;
  error: string;
  seededItems: number;
}

/**
 * Drive the SAME declarative render artifact, but dispatched the way the foundry
 * actually exports today: an AUTHOR-LESS `decision_only` stage firing an
 * `OnTransition` integration hook on the `capability: render` channel.
 */
async function runHookDispatchDrive(): Promise<HookDispatchOutcome> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-section-list-hook-'));
  const programDir = path.join(tempDir, 'programs', HOOK_PROGRAM);
  mkdirSync(programDir, { recursive: true });
  writeFileSync(path.join(programDir, 'specs.yml'), hookDispatchSpecYaml(), 'utf8');

  const store = new InMemoryArtifactStore();
  const loaded = loadProgramByConvention(HOOK_PROGRAM, {
    programsRoot: tempDir,
    additionalHandlers: {
      async seed_section() {
        return { seeded: true };
      },
      async finish_seeding() {
        return { done: true };
      },
    },
  });
  // Engine inconsistency the foundry already shims (`withDecisionOnlyRegistryPrompts`):
  // the spec compiler FORBIDS a prompt on a decision-only mode while the program
  // registry REQUIRES one for every mode. Swap `spec` IN PLACE — the convention
  // capability recipe is a WeakMap keyed by ENTRY IDENTITY, so the foundry's
  // `{ ...loaded.entry, spec }` spread would silently unbind the render provider.
  {
    const spec = loaded.entry.spec as unknown as Record<string, unknown>;
    const prompts = new Map(spec.prompts as Map<string, string>);
    prompts.set(HOOK_EXPORT_MODE, 'Decision-only auto-transition mode.');
    const descriptors = Object.getOwnPropertyDescriptors(spec);
    delete (descriptors as Record<string, unknown>).prompts;
    const clone = Object.create(Object.getPrototypeOf(spec) as object) as Record<string, unknown>;
    Object.defineProperties(clone, descriptors);
    Object.defineProperty(clone, 'prompts', { value: prompts, enumerable: true, configurable: true });
    Object.defineProperty(loaded.entry, 'spec', { value: clone, enumerable: true, configurable: true, writable: true });
  }

  const author = scriptedAuthor([
    effect('seed_section', { item: { id: 'sec-1', title: 'T1', proposed_text: 'BODY-1', status: 'accepted' } }, 'stage_output'),
    effect('finish_seeding', {}, 'stage_output'),
  ]);

  const { client, close } = await startRouteHarness({
    programs: [{ name: HOOK_PROGRAM, entry: loaded.entry }],
    authorHandle: author,
    observerModelId: 'section-list-hook-observer',
    renderProvider: createDeclarativeRenderProvider(),
    artifactStore: store as unknown as NonNullable<PgasServerConfig['adapters']>['artifactStore'],
    storage: { uploadsDir: path.join(tempDir, 'uploads') },
  });

  try {
    const created = await client.sessions.create({ program: HOOK_PROGRAM });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'seed' });
    let error = '';
    try {
      await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'finish' });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const session = await client.sessions.get(created.sessionId);
    return {
      puts: store.puts.length,
      error,
      seededItems: bucketOf(session, 'work.sections.items').length,
    };
  } finally {
    await close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createConventionEntry(programsRoot: string): ProgramEntry {
  const loaded = loadProgramByConvention(PROGRAM, {
    programsRoot,
    additionalHandlers: {
      // pure sentinel handlers — no shape mapping, no content authoring.
      async seed_section() {
        return { seeded: true };
      },
      async finish_seeding() {
        return { done: true };
      },
    },
  });
  return loaded.entry;
}

// ───────────────────────────── spec ─────────────────────────────

function renderSpecYaml(listFrom: string): string {
  // Root keys are grouped in the engine's CANONICAL blueprint block order
  // (identity → domain → lifecycle → channels → actions → guidance → validation
  // → view → render → policy) so the fixture is strict-clean and demonstrates the
  // canonical `render:` slot: AFTER `projection`/`view`, BEFORE any policy block.
  return `name: "${PROGRAM}"
features:
  - base
pure: true
termination: BoundedSession
topology: CyclicTopology

schema:
  inputs.user_text: string
  work.sections: object
  work.sections.items: array
  work.sections.items.*: object
  work.sections.items.*.id: string
  work.sections.items.*.title: string
  work.sections.items.*.proposed_text: string
  work.sections.items.*.status: string
  work.seeding: object
  work.seeding.done: boolean
  summary.approve: object
  summary.approve.status_buckets: object
  ${APPROVED_BUCKET}: array
  ${APPROVED_BUCKET}.*: object
  ${APPROVED_BUCKET}.*.id: string
  ${APPROVED_BUCKET}.*.title: string
  ${APPROVED_BUCKET}.*.proposed_text: string
  ${APPROVED_BUCKET}.*.status: string
  ${REJECTED_BUCKET}: array
  ${REJECTED_BUCKET}.*: object
  ${REJECTED_BUCKET}.*.id: string
  ${REJECTED_BUCKET}.*.title: string
  ${REJECTED_BUCKET}.*.proposed_text: string
  ${REJECTED_BUCKET}.*.status: string
  export: object
  export.artifact: object

# PROGRAM-OWNED approval, engine-derived. The render: block below reads these
# buckets; it never filters. render: has no filter/predicate grammar by design.
derived_paths:
  - target: ${APPROVED_BUCKET}
    when: { kind: FieldTruthy, path: work.seeding.done }
    set:
      kind: items_where_field_eq
      params:
        collection_path: work.sections.items
        field: status
        value: accepted
  - target: ${REJECTED_BUCKET}
    when: { kind: FieldTruthy, path: work.seeding.done }
    set:
      kind: items_where_field_eq
      params:
        collection_path: work.sections.items
        field: status
        value: rejected

initial: bootstrap
terminal: [complete]

modes:
  bootstrap:
    vocabulary: [seed_section, finish_seeding]
    channels: [user_text, stage_output]
    transitions:
      - target: render_export
        when: { kind: FieldTruthy, path: work.seeding.done }
  render_export:
    vocabulary: [render_document]
    channels: [user_text, render_out]
    transitions:
      - target: complete
        when: { kind: FieldTruthy, path: export.artifact }
  complete:
    vocabulary: []
    channels: [stage_output]

proceeds_to:
  finish_seeding: render_export
  render_document: complete

channels:
  user_text: { direction: In, sync: Async }
  stage_output: { direction: Out, sync: Sync }
  render_out: { direction: Out, sync: Sync, capability: render }

fallback:
  channel: stage_output
  payload: { ok: false }

ingestion:
  user_text:
    - inputs.user_text

action_map:
  seed_section:
    description: "Append one authored section record to the collection."
    mutations:
      - op: MAppend
        path: work.sections.items
        from_arg: item
    channel: stage_output
  finish_seeding:
    description: "Mark seeding complete."
    mutations: []
    channel: stage_output
    result_path: work.seeding
  render_document:
    description: "Dispatch the declarative docx render (payload selects the artifact)."
    mutations: []
    channel: render_out
    result_path: export

preamble: |
  Hermetic pgas#1045 RenderSectionList per-approved-item falsifier.

prompts:
  bootstrap: "Call seed_section for each item, then finish_seeding."
  render_export: "Call render_document to render the declarative docx."
  complete: "Terminal."

repair_bound: 2

projection:
  bootstrap:
    include: [inputs.user_text]
    exclude: []
  render_export:
    include: [${APPROVED_BUCKET}]
    exclude: []
  complete:
    include: [${APPROVED_BUCKET}, export.artifact]
    exclude: []

render:
  artifacts:
    - id: ${ARTIFACT_ID}
      format: docx
      provider_request: true
      sections:
        # TOP-LEVEL section_list: a nested one is not representable in the
        # generic provider request (the engine throws). Refs inside template
        # are ITEM-RELATIVE.
        - kind: section_list
          from: { from: ${listFrom} }
          template:
            kind: section
            heading: { from: title }
            nodes:
              - { kind: paragraph, text: { from: proposed_text } }
`;
}

/**
 * The SAME render artifact, dispatched the way the foundry exports today: an
 * author-less `decision_only` mode + an `OnTransition` integration hook bound to
 * the `capability: render` channel.
 */
function hookDispatchSpecYaml(): string {
  return `name: "${HOOK_PROGRAM}"
features:
  - base
  - decision_only
  - integrations
pure: false
termination: BoundedSession
topology: CyclicTopology

schema:
  inputs.user_text: string
  work.sections: object
  work.sections.items: array
  work.sections.items.*: object
  work.sections.items.*.id: string
  work.sections.items.*.title: string
  work.sections.items.*.proposed_text: string
  work.sections.items.*.status: string
  work.seeding: object
  work.seeding.done: boolean
  export: object
  export.artifact: object

initial: bootstrap
terminal: [complete]

modes:
  bootstrap:
    vocabulary: [seed_section, finish_seeding]
    channels: [user_text, stage_output]
    transitions:
      - target: ${HOOK_EXPORT_MODE}
        when: { kind: FieldTruthy, path: work.seeding.done }
  ${HOOK_EXPORT_MODE}:
    decision_only: true
    vocabulary: []
    channels: []
    transitions:
      - target: complete
  complete:
    vocabulary: []
    channels: [stage_output]

proceeds_to:
  finish_seeding: ${HOOK_EXPORT_MODE}

channels:
  user_text: { direction: In, sync: Async }
  stage_output: { direction: Out, sync: Sync }
  render_out: { direction: Out, sync: Sync, capability: render }

fallback:
  channel: stage_output
  payload: { ok: false }

ingestion:
  user_text:
    - inputs.user_text

# The ONLY outbound seam an author-less decision_only mode has. The engine builds
# this hook payload as {action, event, domain} -- there is no IntegrationHook
# payload field -- so the {artifact_id} selector can never be supplied here.
integrations:
  render_hooks:
    channel: render_out
    hooks:
      - action: render_document
        event: OnTransition
        result_path: export

action_map:
  seed_section:
    description: "Append one authored section record to the collection."
    mutations:
      - op: MAppend
        path: work.sections.items
        from_arg: item
    channel: stage_output
  finish_seeding:
    description: "Mark seeding complete."
    mutations: []
    channel: stage_output
    result_path: work.seeding
  render_document:
    description: "Dispatch the declarative docx render."
    mutations: []
    channel: render_out
    result_path: export

preamble: |
  Author-less decision-only render dispatch gap guard.

prompts:
  bootstrap: "Call seed_section for each item, then finish_seeding."
  complete: "Terminal."

repair_bound: 2

render:
  artifacts:
    - id: ${ARTIFACT_ID}
      format: docx
      provider_request: true
      sections:
        - kind: section_list
          from: { from: work.sections.items }
          template:
            kind: section
            heading: { from: title }
            nodes:
              - { kind: paragraph, text: { from: proposed_text } }
`;
}

// ───────────────────────────── scripted author ─────────────────────────────

function effect(name: string, payload: Record<string, unknown>, channel: string): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scriptedAuthor(responses: Array<Record<string, unknown>>): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'section-list-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no section-list falsifier author response scripted for call ${String(index - 1)}`);
      }
      return JSON.stringify(response);
    },
  };
}

// ───────────────────────────── zip / helpers ─────────────────────────────

function parseStoreZip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && dv.getUint32(offset, true) === 0x04034b50) {
    const method = dv.getUint16(offset + 8, true);
    const compSize = dv.getUint32(offset + 18, true);
    const nameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (method !== 0) {
      throw new Error(`zip entry ${name} is not STORE method (method=${String(method)})`);
    }
    const dataStart = nameStart + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    entries.push({ name, data });
    offset = dataStart + compSize;
  }
  return entries;
}

function extractEntryText(bytes: Uint8Array, name: string): string {
  const entry = parseStoreZip(bytes).find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`zip entry ${name} not found`);
  }
  return decode(entry.data);
}

function hasSignature(bytes: Uint8Array, sig: number[]): boolean {
  for (let i = 0; i + sig.length <= bytes.length; i += 1) {
    let match = true;
    for (let j = 0; j < sig.length; j += 1) {
      if (bytes[i + j] !== sig[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeXmlLike(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function extractArtifactRecords(raw: unknown): Array<{ artifactType?: string; payloadRef?: string }> {
  const container = isRecord(raw) && Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw) ? raw : [];
  return container.filter(isRecord).map((r) => ({
    artifactType: typeof r.artifactType === 'string' ? r.artifactType : undefined,
    payloadRef: typeof r.payloadRef === 'string' ? r.payloadRef : undefined,
  }));
}

function modeOf(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  if (typeof envelope.mode === 'string') return envelope.mode;
  if (isRecord(envelope.state) && typeof envelope.state.mode === 'string') return envelope.state.mode;
  return null;
}

/**
 * The session envelope serialises `state.domain` as an ordered list of
 * `[path, value]` entry pairs (the engine's `Map` wire form); older shapes used
 * a plain record. Read both.
 */
function bucketOf(envelope: unknown, bucketPath: string): unknown[] {
  if (!isRecord(envelope)) return [];
  const state = isRecord(envelope.state) ? envelope.state : envelope;
  const domain = state.domain;
  if (Array.isArray(domain)) {
    for (const entry of domain) {
      if (Array.isArray(entry) && entry[0] === bucketPath) {
        return Array.isArray(entry[1]) ? entry[1] as unknown[] : [];
      }
    }
    return [];
  }
  if (isRecord(domain)) {
    const direct = domain[bucketPath];
    return Array.isArray(direct) ? direct : [];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
