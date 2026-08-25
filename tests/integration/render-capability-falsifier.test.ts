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
// #992 render-capability HERMETIC MECHANISM falsifier (Phase-2, v5.6.0).
//
// Proves the FULL declarative render path with NO LLM and NO network:
//   authored world state → `render:` provider_request projection
//   (engine `buildProviderRenderRequest`) → the generic consumer `RenderProvider`
//   → engine `ArtifactStore.put` → a first-class `artifactType: "render"` record.
//
// The engine does the world→IR projection + persistence; the ONLY consumer code
// is the generic byte serializer (render-provider.golden.ts). The scripted author
// authors the memo content (carrying a per-run nonce) into declared world paths,
// then emits a `{ artifact_id }` selector EffectAction to the `capability: render`
// channel.
//
// KILL TEST (R-2): rebind the render artifact's body paragraph `{from}` to a
// DIFFERENT authored path that does NOT carry the nonce. The projection then
// reads the wrong world path and the run-nonce MUST vanish from the rendered
// word/document.xml — proving the nonce reaches the bytes ONLY via the declared
// render:→world-path binding (never fabricated, never smuggled through the
// provider).
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM = 'render-capability-falsifier';
const ARTIFACT_ID = 'memo_docx';

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
      // copy the bytes — the engine owns the passed buffer's lifecycle.
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

describe('#992 render-capability hermetic falsifier', () => {
  it('R-1 (positive): authored world → render: → ProviderRenderRequest → RenderProvider → ArtifactStore, nonce present', async () => {
    const nonce = `RENDER-NONCE-${randomUUID()}`;
    const heading = `Memo Heading ${randomUUID()}`;
    const body = `${nonce} ${'declarative render body '.repeat(40)} ${nonce}`;

    const drive = await runRenderDrive({ bodyFrom: 'memo.body', heading, body });

    // exactly one durable artifact minted by the engine render capability.
    expect(drive.store.puts.length, 'one ArtifactRef.put by the render capability').toBe(1);
    const stored = drive.store.puts[0]!;
    expect(stored.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    // the engine persisted a first-class artifactType:"render" metadata record
    // pointing payloadRef at the store handle (NOT base64-in-domain).
    const record = drive.artifactRecords.find((r) => r.payloadRef === stored.payloadRef);
    expect(record, 'render artifactType record present').toBeTruthy();
    expect(record?.artifactType).toBe('render');

    // retrieve bytes via the injected store (ArtifactStore.get) and open the docx.
    const bytes = await drive.store.get(stored.payloadRef);
    expect(bytes, 'artifact bytes retrievable from ArtifactStore').toBeTruthy();
    expect([bytes![0], bytes![1], bytes![2], bytes![3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const docXml = extractEntryText(bytes!, 'word/document.xml');

    // (a) the per-run nonce is verbatim in the bytes — it could only get there via
    //     the render:→world-path binding the engine projected from memo.body.
    expect(docXml, 'nonce present in document.xml').toContain(nonce);
    // (b) the authored heading also flowed through (section heading {from: memo.heading}).
    expect(docXml, 'heading present in document.xml').toContain(escapeXmlLike(heading));
    // (c) STORE-method OOXML with a valid EOCD (never a stub / empty artifact).
    expect(hasSignature(bytes!, [0x50, 0x4b, 0x05, 0x06]), 'EOCD present').toBe(true);
    expect(drive.finalMode, 'session reached terminal').toBe('complete');
  });

  it('R-2 (KILL): rebinding render:→{from} to a nonce-free path makes the nonce vanish', async () => {
    const nonce = `RENDER-NONCE-${randomUUID()}`;
    const heading = `Memo Heading ${randomUUID()}`;
    const body = `${nonce} body carrying the nonce`;

    // Same authored world (memo.body still carries the nonce), but the render
    // artifact's body paragraph now reads memo.heading (which has NO nonce).
    const drive = await runRenderDrive({ bodyFrom: 'memo.heading', heading, body });

    expect(drive.store.puts.length, 'render still produced a docx').toBe(1);
    const stored = drive.store.puts[0]!;
    const bytes = await drive.store.get(stored.payloadRef);
    expect(bytes, 'artifact bytes present').toBeTruthy();
    const docXml = extractEntryText(bytes!, 'word/document.xml');

    // THE KILL: the nonce lives in memo.body; the render now reads memo.heading,
    // so the nonce cannot appear. A regression that ignored the {from} binding
    // (e.g. a provider that read raw world state, or a fabricating renderer)
    // would leak the nonce here and FAIL this assertion.
    expect(docXml, 'nonce absent when render:→{from} rebound off memo.body').not.toContain(nonce);
    // the docx is still real and non-empty — the kill is a content binding break,
    // not a crash.
    expect([bytes![0], bytes![1], bytes![2], bytes![3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(docXml, 'the rebound heading path did flow through').toContain(escapeXmlLike(heading));
  });
});

// ───────────────────────────── engine drive ─────────────────────────────

interface RenderDriveResult {
  store: InMemoryArtifactStore;
  finalMode: string | null;
  artifactRecords: Array<{ artifactType?: string; payloadRef?: string }>;
}

async function runRenderDrive(input: { bodyFrom: string; heading: string; body: string }): Promise<RenderDriveResult> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-render-falsifier-'));
  const programDir = path.join(tempDir, 'programs', PROGRAM);
  mkdirSync(programDir, { recursive: true });
  writeFileSync(path.join(programDir, 'specs.yml'), renderSpecYaml(input.bodyFrom), 'utf8');

  const store = new InMemoryArtifactStore();
  const entry = createConventionEntry(tempDir);

  const author = scriptedAuthor([
    // round 1 (bootstrap): author the memo content into world state.
    effect('author_memo', { heading: input.heading, body: input.body }, 'stage_output'),
    // round 2 (render_export): dispatch the declarative render via the exact selector.
    effect('render_document', { artifact_id: ARTIFACT_ID }, 'render_out'),
  ]);

  const { client, close } = await startRouteHarness({
    programs: [{ name: PROGRAM, entry }],
    authorHandle: author,
    observerModelId: 'render-falsifier-observer',
    renderProvider: createDeclarativeRenderProvider(),
    artifactStore: store as unknown as NonNullable<PgasServerConfig['adapters']>['artifactStore'],
    storage: { uploadsDir: path.join(tempDir, 'uploads') },
  });

  try {
    const created = await client.sessions.create({ program: PROGRAM });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'author the memo' });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'render the docx' });
    const finalSession = await client.sessions.get(created.sessionId);
    let artifactRecords: Array<{ artifactType?: string; payloadRef?: string }> = [];
    try {
      const raw = await client.sessions.systemArtifacts({ program: PROGRAM });
      artifactRecords = extractArtifactRecords(raw);
    } catch {
      artifactRecords = [];
    }
    return { store, finalMode: modeOf(finalSession), artifactRecords };
  } finally {
    await close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createConventionEntry(programsRoot: string): ProgramEntry {
  const loaded = loadProgramByConvention(PROGRAM, {
    programsRoot,
    additionalHandlers: {
      // content-authoring handler — echoes the authored fields to result_path
      // `memo`. This is the ordinary LLM/consumer content-authoring stage; it is
      // NOT the export path being migrated (the render is 100% engine-native).
      async author_memo(payload: unknown) {
        const args = isRecord(payload) ? payload : {};
        return {
          heading: typeof args.heading === 'string' ? args.heading : '',
          body: typeof args.body === 'string' ? args.body : '',
        };
      },
    },
  });
  return loaded.entry;
}

// ───────────────────────────── spec ─────────────────────────────

function renderSpecYaml(bodyFrom: string): string {
  return `name: "${PROGRAM}"

features:
  - base

pure: true

schema:
  inputs.user_text: string
  memo: object
  memo.heading: string
  memo.body: string
  export: object
  export.artifact: object

modes:
  bootstrap:
    vocabulary: [author_memo]
    channels: [user_text, stage_output]
    transitions:
      - target: render_export
        when: { kind: FieldTruthy, path: memo.body }
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
  author_memo: render_export
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
  author_memo:
    description: "Author the memo heading + body into world state."
    mutations: []
    channel: stage_output
    result_path: memo
  render_document:
    description: "Dispatch the declarative docx render (payload selects the artifact)."
    mutations: []
    channel: render_out
    result_path: export

preamble: |
  Hermetic #992 render-capability docx falsifier.

prompts:
  bootstrap: "Call author_memo with the memo heading and body."
  render_export: "Call render_document to render the declarative docx."
  complete: "Terminal."

repair_bound: 2

projection:
  bootstrap:
    include: [inputs.user_text]
    exclude: []
  render_export:
    include: [memo.heading, memo.body]
    exclude: []
  complete:
    include: [memo.heading, memo.body, export.artifact]
    exclude: []

render:
  artifacts:
    - id: ${ARTIFACT_ID}
      format: docx
      provider_request: true
      sections:
        - kind: section
          heading: { from: memo.heading }
          nodes:
            - { kind: paragraph, text: { from: ${bodyFrom} } }
`;
}

// ───────────────────────────── scripted author ─────────────────────────────

function effect(name: string, payload: Record<string, unknown>, channel: string): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scriptedAuthor(responses: Array<Record<string, unknown>>): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'render-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no render falsifier author response scripted for call ${String(index - 1)}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
