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
// AUTHOR-LESS DISPATCH, engine 6.0.0 — half the blocker is GONE, half remains.
//
// P-1 (was G-1, now INVERTED into a positive assertion). pgas#1054 shipped
// `IntegrationHook.payload` in 6.0.0, so an AUTHOR-LESS `decision_only` stage
// (pgas-new #253 — the author is never called for the export stage) CAN now
// dispatch `capability: render`: the engine's `dispatchHook` builds
// `{action, event, domain, payload}` and `createServerOutputAdapter.dispatch`
// forwards ONLY `envelope.payload` for a non-EffectAction that carries one, so
// the exact `{artifact_id}` selector reaches `renderCapability` and a first-class
// `artifactType:"render"` docx IS minted with the approved prose in its bytes.
// P-1 asserts that, so the old failure story cannot rot back in.
//
// G-2 pins the REMAINING BLOCKER: an `IntegrationHook` has no transition/mode
// scope, and `runOnTransitionHooks` fires the whole hook batch on EVERY mode
// change. The SAME declaration therefore mints ONE ARTIFACT PER TRANSITION,
// including content-INCOMPLETE ones rendered before the deliverable collection
// exists — so "exactly one deliverable at export time" is still not expressible.
// The two candidate `AfterMutation` scopings are also dead (a derived-path target
// never fires; the collection append path fires per item, not per deliverable).
// See docs/curator-requests/2026-08-25-integration-hook-transition-scoping.md.
// When the engine ships hook scoping G-2 FAILS — that is the signal to complete
// the emission migration and delete the shape-mapping TS.
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM = 'render-section-list-falsifier';
const ARTIFACT_ID = 'opinion_docx';
const APPROVED_BUCKET = 'summary.approve.status_buckets.accepted';
const REJECTED_BUCKET = 'summary.approve.status_buckets.rejected';
const HOOK_PROGRAM = 'render-section-list-hook-dispatch';
const HOOK_EXPORT_MODE = 'render_export';
/** Same engine-derived approved bucket as S-1/K-1/K-2 — only the DISPATCH differs. */
const HOOK_APPROVED_BUCKET = APPROVED_BUCKET;
/** bootstrap→gather, gather→review, review→render_export, render_export→complete. */
const HOOK_TRANSITION_COUNT = 4;
const HOOK_SEEDED_ITEMS = 2;

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

describe('pgas#1054 author-less dispatch — the unlock, and the scope gap that remains', () => {
  it('P-1 (positive): a static IntegrationHook payload lets an AUTHOR-LESS decision_only stage mint a render artifact', async () => {
    const outcome = await runHookDispatchDrive(ON_TRANSITION_HOOK);

    // OBSERVED (engine 6.0.0): the hook envelope now carries the declared static
    // payload, `createServerOutputAdapter.dispatch` forwards ONLY that payload for
    // a non-EffectAction that owns one, so `renderCapability`'s exact
    // `{artifact_id}` selector matches, `buildProviderRenderRequest` runs, and the
    // generic RenderProvider is handed a real DeclarativeRenderRequest.
    expect(outcome.error, 'author-less dispatch no longer fails the session').toBe('');
    expect(outcome.finalMode, 'the session still reaches terminal').toBe('complete');
    expect(outcome.puts, 'the author-less decision-only stage DID mint artifacts').toBeGreaterThan(0);
    expect(outcome.seededItems, 'the collection the render reads was populated').toBe(HOOK_SEEDED_ITEMS);

    // the minted bytes are a real docx carrying the APPROVED item's authored prose
    // — the same chain S-1 proves, now driven with no author round at all.
    const withProse = outcome.documents.filter((docXml) => docXml.includes(outcome.approvedProse));
    expect(withProse.length, 'at least one minted docx carries the approved prose').toBeGreaterThan(0);
    for (const docXml of outcome.documents) {
      expect(docXml, 'the rejected item never reaches any minted deliverable')
        .not.toContain(outcome.rejectedProse);
    }
    expect(outcome.renderRecordCount, 'first-class artifactType:"render" records').toBeGreaterThan(0);
  });

  it('G-2 (GAP): an OnTransition hook has no transition scope, so it mints ONE ARTIFACT PER TRANSITION', async () => {
    const outcome = await runHookDispatchDrive(ON_TRANSITION_HOOK);

    // OBSERVED (engine 6.0.0): `runOnTransitionHooks` pushes every declared hook
    // into the batch on EVERY `session.mode !== previousMode`, with no mode /
    // target-mode / predicate filter anywhere in `IntegrationHook`. The export
    // deliverable is therefore re-minted on each hop instead of exactly once at
    // export time.
    expect(outcome.puts, 'one artifact minted per mode transition').toBe(HOOK_TRANSITION_COUNT);

    // and the extras are NOT harmless duplicates: the hops that happen before the
    // deliverable collection exists mint content-INCOMPLETE docx files.
    const withoutProse = outcome.documents.filter((docXml) => !docXml.includes(outcome.approvedProse));
    expect(withoutProse.length, 'at least one minted docx is content-incomplete').toBeGreaterThan(0);

    // Today the foundry suppresses exactly these extra fires with a consumer-side
    // `<stage>.render_pending` gate inside `createExportHookAdapter`. On a
    // `capability: render` channel the engine owns the handler, so that gate cannot
    // exist — and re-adding a dispatch filter on the render path would be the
    // forbidden consumer stopgap.
  });

  it('G-2a (GAP): AfterMutation scoped to a DERIVED bucket path never fires', async () => {
    const outcome = await runHookDispatchDrive(`      - action: render_document
        event: AfterMutation
        path: ${HOOK_APPROVED_BUCKET}
        payload: { artifact_id: "${ARTIFACT_ID}" }
        result_path: export`);

    // OBSERVED: `runAfterMutationHooks` matches only `instructionSet.mutations`.
    // Derived-path writes are not instruction-set mutations, so the completion
    // guard the foundry's confirmation-loop class actually uses
    // (`derived_paths[all_items_field_eq]`) cannot drive a hook at all.
    expect(outcome.puts, 'a derived-path write does not trigger an AfterMutation hook').toBe(0);
    expect(outcome.error, 'and the session still completes').toBe('');
  });

  it('G-2b (GAP): AfterMutation scoped to the collection path fires PER ITEM, not per deliverable', async () => {
    const outcome = await runHookDispatchDrive(`      - action: render_document
        event: AfterMutation
        path: work.sections.items
        payload: { artifact_id: "${ARTIFACT_ID}" }
        result_path: export`);

    // OBSERVED: one dispatch per MAppend. A deliverable is not per-item, so this
    // scoping mints N partial documents instead of one complete one.
    expect(outcome.puts, 'one artifact minted per appended item').toBe(HOOK_SEEDED_ITEMS);
    expect(outcome.error, 'and the session still completes').toBe('');
  });

  // ── EXISTING-GRAMMAR ROUTE AUDIT ────────────────────────────────────────
  // Before asking for new grammar, prove the behaviour cannot be expressed with
  // what already ships. The candidate G-2a/G-2b missed: AfterMutation scoped to
  // the ONE-SHOT SCALAR GUARD whose flip is what causes entry into the export
  // mode. That guard is not extra bookkeeping — the transition already declares
  // it (`review -> render_export when FieldTruthy work.review.done`), so hooking
  // it reuses an existing declaration rather than inventing one.
  it('E-1 (EXISTING ROUTE): AfterMutation on the one-shot export-entry guard mints EXACTLY ONE complete deliverable', async () => {
    const outcome = await runHookDispatchDrive(`      - action: render_document
        event: AfterMutation
        path: work.review.done
        payload: { artifact_id: "${ARTIFACT_ID}" }
        result_path: export`);

    expect(outcome.error, 'the session still completes cleanly').toBe('');
    expect(outcome.finalMode, 'and reaches terminal').toBe('complete');

    // exactly-once: the guard is MSet by a single action, in a single round.
    expect(outcome.puts, 'EXACTLY ONE artifact minted').toBe(1);

    // and it is CONTENT-COMPLETE: `execute()` applies every instruction-set
    // mutation BEFORE runAfterMutationHooks, and the collection was populated in
    // earlier rounds, so the approved prose is present and the rejected item is
    // absent — the same content property S-1 and P-1 assert.
    expect(outcome.documents).toHaveLength(1);
    expect(outcome.documents[0], 'the single deliverable carries the approved prose')
      .toContain(outcome.approvedProse);
    expect(outcome.documents[0], 'and never the rejected item')
      .not.toContain(outcome.rejectedProse);
    expect(outcome.renderRecordCount, 'first-class artifactType:"render" record').toBe(1);
  });

  it('E-2 (EXISTING ROUTE, REJECTED): AfterRound is the only other dispatching event and has no filter at all', async () => {
    const outcome = await runHookDispatchDrive(`      - action: render_document
        event: AfterRound
        payload: { artifact_id: "${ARTIFACT_ID}" }
        result_path: export`);

    // OBSERVED: `runAfterRoundHooks` batches every AfterRound hook with no mode,
    // path, or predicate filter — strictly worse than OnTransition. Recorded so
    // the audit covers the WHOLE dispatch surface: integration hooks dispatch on
    // exactly three events (AfterMutation / AfterRound / OnTransition).
    // `AfterIngestion` is a REACTION-only event — the engine has no
    // `runAfterIngestionHooks`, so it cannot drive a hook at all.
    expect(outcome.puts, 'AfterRound mints one artifact per ROUND').toBeGreaterThan(1);
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
  finalMode: string | null;
  seededItems: number;
  documents: string[];
  renderRecordCount: number;
  approvedProse: string;
  rejectedProse: string;
}

/** The declaration P-1/G-2 exercise: the pgas#1054 static payload on OnTransition. */
const ON_TRANSITION_HOOK = `      - action: render_document
        event: OnTransition
        payload: { artifact_id: "${ARTIFACT_ID}" }
        result_path: export`;

/**
 * Drive the SAME declarative render artifact, dispatched the way the foundry
 * actually exports: an AUTHOR-LESS `decision_only` stage on a `capability: render`
 * channel, with no EffectAction anywhere. The hook declaration is the variable —
 * everything else (world, collection, render: block) is held fixed.
 *
 * The program makes FOUR mode transitions and seeds the deliverable collection
 * only in the SECOND mode, so a dispatch that is not transition-scoped is
 * observable both by COUNT and by CONTENT.
 */
async function runHookDispatchDrive(hookDeclaration: string): Promise<HookDispatchOutcome> {
  const approvedProse = `APPROVED-HOOK-${randomUUID()}`;
  const rejectedProse = `REJECTED-HOOK-${randomUUID()}`;
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-section-list-hook-'));
  const programDir = path.join(tempDir, 'programs', HOOK_PROGRAM);
  mkdirSync(programDir, { recursive: true });
  writeFileSync(path.join(programDir, 'specs.yml'), hookDispatchSpecYaml(hookDeclaration), 'utf8');

  const store = new InMemoryArtifactStore();
  const loaded = loadProgramByConvention(HOOK_PROGRAM, {
    programsRoot: tempDir,
    additionalHandlers: {
      async begin_gathering() {
        return { started: true };
      },
      async seed_section() {
        return { seeded: true };
      },
      async finish_gathering() {
        return { done: true };
      },
      async finish_review() {
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
    effect('begin_gathering', {}, 'stage_output'),
    effect('seed_section', { item: { id: 'sec-1', title: 'Approved Heading', proposed_text: approvedProse, status: 'accepted' } }, 'stage_output'),
    effect('seed_section', { item: { id: 'sec-2', title: 'Rejected Heading', proposed_text: rejectedProse, status: 'rejected' } }, 'stage_output'),
    effect('finish_gathering', {}, 'stage_output'),
    effect('finish_review', {}, 'stage_output'),
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
    let error = '';
    for (const text of ['begin', 'seed one', 'seed two', 'finish gathering', 'finish review']) {
      try {
        await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: text });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        break;
      }
    }
    const session = await client.sessions.get(created.sessionId);
    let renderRecordCount = 0;
    try {
      const raw = await client.sessions.systemArtifacts({ program: HOOK_PROGRAM });
      renderRecordCount = extractArtifactRecords(raw).filter((r) => r.artifactType === 'render').length;
    } catch {
      renderRecordCount = 0;
    }
    const documents: string[] = [];
    for (const stored of store.puts) {
      const bytes = await store.get(stored.payloadRef);
      documents.push(bytes ? extractEntryText(bytes, 'word/document.xml') : '');
    }
    return {
      puts: store.puts.length,
      error,
      finalMode: modeOf(session),
      seededItems: bucketOf(session, 'work.sections.items').length,
      documents,
      renderRecordCount,
      approvedProse,
      rejectedProse,
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

initial: bootstrap

terminal: [complete]

topology: CyclicTopology

termination: BoundedSession

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
 * The SAME render artifact, dispatched the way the foundry exports: an
 * author-less `decision_only` mode on a `capability: render` channel. The hook
 * declaration is injected so P-1/G-2/G-2a/G-2b vary ONLY the dispatch scoping.
 *
 * Four mode transitions; the deliverable collection is seeded only in `gather`,
 * so an unscoped dispatch is observable by BOTH count and content.
 */
function hookDispatchSpecYaml(hookDeclaration: string): string {
  return `name: "${HOOK_PROGRAM}"

features:
  - base
  - decision_only
  - integrations

pure: false

schema:
  inputs.user_text: string
  work.sections: object
  work.sections.items: array
  work.sections.items.*: object
  work.sections.items.*.id: string
  work.sections.items.*.title: string
  work.sections.items.*.proposed_text: string
  work.sections.items.*.status: string
  work.gathering: object
  work.gathering.started: boolean
  work.gathering.done: boolean
  work.review: object
  work.review.done: boolean
  summary.approve: object
  summary.approve.status_buckets: object
  ${HOOK_APPROVED_BUCKET}: array
  ${HOOK_APPROVED_BUCKET}.*: object
  ${HOOK_APPROVED_BUCKET}.*.id: string
  ${HOOK_APPROVED_BUCKET}.*.title: string
  ${HOOK_APPROVED_BUCKET}.*.proposed_text: string
  ${HOOK_APPROVED_BUCKET}.*.status: string
  export: object
  export.artifact: object

# PROGRAM-OWNED approval, engine-derived and always live — so a render that fires
# on the WRONG transition is incomplete for a content reason, not a timing race.
derived_paths:
  - target: ${HOOK_APPROVED_BUCKET}
    when: { kind: Always }
    set:
      kind: items_where_field_eq
      params:
        collection_path: work.sections.items
        field: status
        value: accepted

modes:
  bootstrap:
    vocabulary: [begin_gathering]
    channels: [user_text, stage_output]
    transitions:
      - target: gather
        when: { kind: FieldTruthy, path: work.gathering.started }
  gather:
    vocabulary: [seed_section, finish_gathering]
    channels: [user_text, stage_output]
    transitions:
      - target: review
        when: { kind: FieldTruthy, path: work.gathering.done }
  review:
    vocabulary: [finish_review]
    channels: [user_text, stage_output]
    transitions:
      - target: ${HOOK_EXPORT_MODE}
        when: { kind: FieldTruthy, path: work.review.done }
  ${HOOK_EXPORT_MODE}:
    decision_only: true
    vocabulary: []
    channels: []
    transitions:
      - target: complete
  complete:
    vocabulary: []
    channels: [stage_output]

initial: bootstrap

terminal: [complete]

topology: CyclicTopology

termination: BoundedSession

proceeds_to:
  begin_gathering: gather
  finish_gathering: review
  finish_review: ${HOOK_EXPORT_MODE}

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

# The ONLY outbound seam an author-less decision_only mode has. Since pgas#1054
# (engine 6.0.0) an IntegrationHook MAY declare a static \`payload\`, and the
# adapter forwards ONLY that payload for a non-EffectAction — so the exact
# \`{artifact_id}\` selector DOES reach capability: render (P-1). What the hook
# still cannot declare is WHEN: there is no mode / target-mode / predicate scope,
# and OnTransition hooks fire on every mode change (G-2).
integrations:
  render_hooks:
    channel: render_out
    hooks:
${hookDeclaration}

action_map:
  begin_gathering:
    description: "Start gathering."
    mutations:
      - op: MSet
        path: work.gathering.started
        value: true
    channel: stage_output
  seed_section:
    description: "Append one authored section record to the collection."
    mutations:
      - op: MAppend
        path: work.sections.items
        from_arg: item
    channel: stage_output
  finish_gathering:
    description: "Mark gathering complete."
    mutations:
      - op: MSet
        path: work.gathering.done
        value: true
    channel: stage_output
  finish_review:
    description: "Mark review complete."
    mutations:
      - op: MSet
        path: work.review.done
        value: true
    channel: stage_output
  render_document:
    description: "Dispatch the declarative docx render."
    mutations: []
    channel: render_out
    result_path: export

preamble: |
  Author-less decision-only render dispatch guard.

prompts:
  bootstrap: "Call begin_gathering."
  gather: "Call seed_section for each item, then finish_gathering."
  review: "Call finish_review."
  complete: "Terminal."

repair_bound: 2

render:
  artifacts:
    - id: ${ARTIFACT_ID}
      format: docx
      provider_request: true
      sections:
        - kind: section_list
          from: { from: ${HOOK_APPROVED_BUCKET} }
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
