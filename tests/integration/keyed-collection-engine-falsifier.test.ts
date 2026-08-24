import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { loadProgramByConvention, type ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';

import { startRouteHarness } from './foundry-test-utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// pgas#993 KEYED-COLLECTION upsert HERMETIC falsifier (engine 5.7.x).
//
// For a KEYED `record_array` reasoning field the foundry emits a REPEATABLE
// element-append action `append_<stage>_<field>` whose `from_arg` is the ELEMENT
// (object) type, and REMOVES the field from the one-shot terminal action. This
// fixture mirrors that emitted shape (see the synthesized-spec assertions in
// tests/unit/keyed-record-array-emission.test.ts and
// tests/unit/keyed-collection-live-scenario.test.ts) and pins the ENGINE
// properties the live drive's keyed verdict rests on:
//
//   K-1 (POSITIVE)  three element-appends over TWO distinct keys yield TWO
//                   elements, and the re-appended key carries the SECOND
//                   payload — upsert-by-key REPLACED, it did not duplicate.
//   K-2 (KILL)      rebind `keyed_collections.key` to a field that is DISTINCT
//                   across all three records and the SAME appends yield THREE
//                   elements. The collapse in K-1 is the declared KEY's doing;
//                   without this, K-1 would be proving nothing.
//   K-3 (KILL)      the pgas#993 degradation itself: passing the whole BATCH as
//                   one array arg silently upserts NOTHING. This is why the
//                   record_array field had to move off the terminal action.
//   K-4 (ENGINE-FORCED) the element-typed `arg_schema` is only admissible when
//                   the MAppend target IS a declared keyed collection — the spec
//                   loader rejects it otherwise. The foundry's keyed/non-keyed
//                   branch is engine-enforced, not a style choice.
//
// Round-shape note: the engine enforces exactly-one-EffectAction-per-round
// (I-1 Terminal Singularity), so each element-append IS its own round's
// `result.terminal` — which is precisely how the live-drive runner harvests the
// per-call append evidence the keyed verdict consumes.
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM = 'keyed-collection-engine-falsifier';
const STAGE = 'extract_records';
const FIELD = 'records';
const KEY = 'record_id';
const COLLECTION = `${STAGE}.result.${FIELD}`;
const APPEND_ACTION = `append_${STAGE}_${FIELD}`;
const TERMINAL_ACTION = `complete_${STAGE}`;

/** The SAME three appends in every drive: two distinct record_ids, distinct labels. */
function threeAppends(firstDetail: string, correctedDetail: string, betaDetail: string): Array<Record<string, unknown>> {
  return [
    { [FIELD]: { [KEY]: 'rec-alpha', label: 'Alpha', detail: firstDetail } },
    { [FIELD]: { [KEY]: 'rec-beta', label: 'Beta', detail: betaDetail } },
    { [FIELD]: { [KEY]: 'rec-alpha', label: 'Alpha (corrected)', detail: correctedDetail } },
  ];
}

interface KeyedDriveResult {
  finalMode: string | null;
  collection: Array<Record<string, unknown>>;
  /** per-round `result.terminal` — the same shape the live-drive runner reads. */
  terminalActions: Array<{ name: string; payload: unknown }>;
  error: string;
}

describe('pgas#993 keyed-collection upsert hermetic falsifier', () => {
  it('K-1 (positive): repeatable element-appends upsert BY KEY — the re-appended key replaces, never duplicates', async () => {
    const firstDetail = `FIRST-${randomUUID()}`;
    const correctedDetail = `CORRECTED-${randomUUID()}`;

    const drive = await runKeyedDrive({
      keyField: KEY,
      appends: threeAppends(firstDetail, correctedDetail, `BETA-${randomUUID()}`),
    });

    expect(drive.error, 'drive completed without engine error').toBe('');
    expect(drive.finalMode, 'session reached terminal').toBe('complete');

    // THE PROPERTY: three appends, two distinct keys, TWO elements.
    expect(drive.collection, 'upsert-by-key collapsed the repeated key').toHaveLength(2);
    const alpha = drive.collection.filter((record) => record[KEY] === 'rec-alpha');
    expect(alpha, 'exactly one element for the repeated key').toHaveLength(1);
    // REPLACED, not dropped: the SECOND payload won.
    expect(alpha[0]?.detail, 're-append replaced the earlier payload').toBe(correctedDetail);
    expect(alpha[0]?.label).toBe('Alpha (corrected)');
    expect(drive.collection.every((record) => typeof record[KEY] === 'string' && (record[KEY] as string).length > 0))
      .toBe(true);

    // Round-shape evidence the live-drive verdict depends on: every append is
    // its own round's terminal action, carrying its single element arg.
    const appendTerminals = drive.terminalActions.filter((action) => action.name === APPEND_ACTION);
    expect(appendTerminals, 'each element-append is its own round terminal').toHaveLength(3);
    for (const terminal of appendTerminals) {
      const arg = (terminal.payload as Record<string, unknown> | null)?.[FIELD];
      expect(Array.isArray(arg), 'element-append arg is an OBJECT, never a batch array').toBe(false);
      expect(arg !== null && typeof arg === 'object').toBe(true);
    }
    // …and the terminal completion action never carried the collection as a batch.
    const completion = drive.terminalActions.find((action) => action.name === TERMINAL_ACTION);
    expect(completion, 'terminal completion action fired').toBeTruthy();
    expect((completion?.payload as Record<string, unknown> | null)?.[FIELD]).toBeUndefined();
  });

  it('K-2 (KILL): rebinding the declared key to a distinct-per-record field stops the collapse — three elements', async () => {
    const firstDetail = `FIRST-${randomUUID()}`;
    const correctedDetail = `CORRECTED-${randomUUID()}`;

    // Identical world, identical appends, identical action shape. The ONLY
    // change is the declared `keyed_collections.key`: `label` is distinct across
    // all three records where `record_id` repeats.
    const drive = await runKeyedDrive({
      keyField: 'label',
      appends: threeAppends(firstDetail, correctedDetail, `BETA-${randomUUID()}`),
    });

    expect(drive.error, 'drive completed without engine error').toBe('');
    // THE KILL: three elements. The collapse in K-1 is caused by the DECLARED
    // KEY resolving to the same value twice — not by the append shape and not by
    // any implicit content dedupe.
    expect(drive.collection, 'rebinding the key stops the collapse').toHaveLength(3);
    expect(drive.collection.filter((record) => record[KEY] === 'rec-alpha')).toHaveLength(2);
  });

  it('K-3 (KILL): a BATCH array arg silently upserts nothing (the pgas#993 degradation)', async () => {
    const drive = await runKeyedDrive({
      keyField: KEY,
      appends: [
        {
          [FIELD]: [
            { [KEY]: 'rec-alpha', label: 'Alpha', detail: `A-${randomUUID()}` },
            { [KEY]: 'rec-beta', label: 'Beta', detail: `B-${randomUUID()}` },
            { [KEY]: 'rec-gamma', label: 'Gamma', detail: `G-${randomUUID()}` },
          ],
        },
      ],
    });

    // THE KILL, observed on engine 5.7.1: one batch call carrying three records
    // leaves the keyed collection EMPTY. A wrapping array never resolves the
    // top-level key, so the upsert no-ops — no error, no records. That silent
    // no-op is exactly the livelock pgas#993 describes, and exactly why the
    // foundry emits a repeatable per-element append instead of a batch arg.
    expect(drive.error, 'the batch call did not raise — it silently did nothing').toBe('');
    expect(drive.collection, 'batch arg upserted no keyed elements at all').toHaveLength(0);
  });

  it('K-4 (ENGINE-FORCED): the element-typed arg is inadmissible when the MAppend target is not a declared keyed collection', () => {
    // Same action shape as K-1 (arg_schema.<field>.type: object) but with NO
    // keyed_collections declaration: the spec loader infers `array` from the
    // MAppend target's schema and REFUSES the element type. The foundry's
    // keyed-vs-#825-batch branch is therefore engine-enforced.
    const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-keyed-collection-unkeyed-'));
    try {
      const programDir = path.join(tempDir, 'programs', PROGRAM);
      mkdirSync(programDir, { recursive: true });
      writeFileSync(path.join(programDir, 'specs.yml'), keyedSpecYaml(null), 'utf8');
      expect(() => loadProgramByConvention(PROGRAM, { programsRoot: tempDir }))
        .toThrow(/arg_schema\.records\.type "object" conflicts with the schema-inferred type "array"/u);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

// ───────────────────────────── engine drive ─────────────────────────────

async function runKeyedDrive(input: {
  /** declared `keyed_collections.key`; null omits the declaration entirely. */
  keyField: string;
  appends: Array<Record<string, unknown>>;
}): Promise<KeyedDriveResult> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-keyed-collection-falsifier-'));
  const programDir = path.join(tempDir, 'programs', PROGRAM);
  mkdirSync(programDir, { recursive: true });
  writeFileSync(path.join(programDir, 'specs.yml'), keyedSpecYaml(input.keyField), 'utf8');

  const author = scriptedAuthor([
    ...input.appends.map((payload) => effect(APPEND_ACTION, payload, 'widget_output')),
    effect(TERMINAL_ACTION, { record_count: input.appends.length, extraction_notes: 'done' }, 'stage_output'),
  ]);

  const { client, close } = await startRouteHarness({
    programs: [{ name: PROGRAM, entry: createConventionEntry(tempDir) }],
    authorHandle: author,
    observerModelId: 'keyed-collection-falsifier-observer',
  });

  try {
    const created = await client.sessions.create({ program: PROGRAM });
    let error = '';
    for (let i = 0; i <= input.appends.length; i += 1) {
      try {
        await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: `round ${String(i)}` });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        break;
      }
    }
    const session = await client.sessions.get(created.sessionId);
    const roundsResponse = await client.sessions.rounds(created.sessionId);
    const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
    return {
      finalMode: modeOf(session),
      collection: collectionOf(session, COLLECTION),
      terminalActions: rounds.flatMap((round) => terminalActionOf(round)),
      error,
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
      // pure sentinel handler — no shape mapping, no content authoring.
      async [TERMINAL_ACTION]() {
        return { done: true };
      },
    },
  });
  return loaded.entry;
}

// ───────────────────────────── spec ─────────────────────────────

/**
 * Mirrors the foundry's emitted keyed shape: an element-typed repeatable
 * `append_<stage>_<field>` on `widget_output`, and a terminal completion action
 * carrying ONLY the scalar summary fields. `keyField: null` omits the
 * `keyed_collections` declaration (K-4).
 */
function keyedSpecYaml(keyField: string | null): string {
  const keyedBlock = keyField === null
    ? ''
    : `keyed_collections:
  - collection: ${COLLECTION}
    key: ${keyField}
`;
  const features = keyField === null ? '  - base\n' : '  - base\n  - keyed_collection\n';
  return `name: "${PROGRAM}"
features:
${features}pure: true
termination: BoundedSession
topology: CyclicTopology

schema:
  inputs.user_text: string
  ${STAGE}.done: boolean
  ${STAGE}.result: object
  ${COLLECTION}: array
  ${COLLECTION}.*: object
  ${COLLECTION}.*.${KEY}: string
  ${COLLECTION}.*.label: string
  ${COLLECTION}.*.detail: string
  ${STAGE}.raw_result_fields: object
  ${STAGE}.raw_result_fields.record_count: any
  ${STAGE}.raw_result_fields.extraction_notes: any
  ${STAGE}.output: object

${keyedBlock}
initial: ${STAGE}
terminal: [complete]

modes:
  ${STAGE}:
    vocabulary: [${APPEND_ACTION}, ${TERMINAL_ACTION}]
    channels: [user_text, widget_output, stage_output]
    transitions:
      - target: complete
        when: { kind: FieldTruthy, path: ${STAGE}.done }
  complete:
    vocabulary: []
    channels: [stage_output]

proceeds_to:
  ${TERMINAL_ACTION}: complete

channels:
  user_text: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Async }
  stage_output: { direction: Out, sync: Sync }

fallback:
  channel: stage_output
  payload: { ok: false }

ingestion:
  user_text:
    - inputs.user_text

action_map:
  ${APPEND_ACTION}:
    description: "Append ONE record to ${COLLECTION}; it is upserted by ${KEY}."
    arg_schema:
      ${FIELD}: { type: object, required: true }
    mutations:
      - op: MAppend
        path: ${COLLECTION}
        value: {}
        from_arg: ${FIELD}
    channel: widget_output
  ${TERMINAL_ACTION}:
    description: "Record the summary fields and advance."
    arg_schema:
      record_count: { type: number, required: true }
      extraction_notes: { type: string, required: true }
    result_path: ${STAGE}.output
    mutations:
      - op: MSet
        path: ${STAGE}.done
        value: true
      - op: MSet
        path: ${STAGE}.raw_result_fields.record_count
        from_arg: record_count
      - op: MSet
        path: ${STAGE}.raw_result_fields.extraction_notes
        from_arg: extraction_notes
    channel: stage_output

preamble: |
  Hermetic pgas#993 keyed-collection upsert falsifier.

prompts:
  ${STAGE}: "Append one record at a time, then record the summary fields."
  complete: "Terminal."

repair_bound: 2

projection:
  ${STAGE}:
    include: [inputs.user_text, ${COLLECTION}]
    exclude: []
  complete:
    include: [${COLLECTION}]
    exclude: []
`;
}

// ───────────────────────────── scripted author ─────────────────────────────

function effect(name: string, payload: Record<string, unknown>, channel: string): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scriptedAuthor(responses: Array<Record<string, unknown>>): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'keyed-collection-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no keyed-collection falsifier author response scripted for call ${String(index - 1)}`);
      }
      return JSON.stringify(response);
    },
  };
}

// ───────────────────────────── readers ─────────────────────────────

function terminalActionOf(round: unknown): Array<{ name: string; payload: unknown }> {
  if (!isRecord(round)) return [];
  const result = round.result;
  if (!isRecord(result)) return [];
  const terminal = result.terminal;
  if (!isRecord(terminal)) return [];
  const name = terminal.name;
  if (typeof name !== 'string' || name.length === 0) return [];
  return [{ name, payload: terminal.payload ?? null }];
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
function collectionOf(envelope: unknown, collectionPath: string): Array<Record<string, unknown>> {
  if (!isRecord(envelope)) return [];
  const state = isRecord(envelope.state) ? envelope.state : envelope;
  const domain = state.domain;
  let raw: unknown;
  if (Array.isArray(domain)) {
    for (const entry of domain) {
      if (Array.isArray(entry) && entry[0] === collectionPath) {
        raw = entry[1];
        break;
      }
    }
  } else if (isRecord(domain)) {
    raw = domain[collectionPath];
  }
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
