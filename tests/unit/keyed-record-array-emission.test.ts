import { describe, expect, it } from 'vitest';
import { actionMapEntryFor } from '../../src/foundry-program/synthesizer/topology.js';
import { applyKeyedRecordArrayAppendActions } from '../../src/foundry-program/synthesizer.js';
import { REASONING_CONTRACT_VERSION, type ReasoningStageContract } from '../../src/foundry-program/reasoning-contract.js';
import type { MutableRecord, TransitionAction } from '../../src/foundry-program/synthesizer/types.js';

/**
 * pgas#993 / pgas-server v5.6.0 — GENERAL keyed-awareness of the record_array
 * emission, proven at the emission-function level (not special-cased to
 * lead-research/leads/email — the field here is `records`, the key `contact_id`):
 *
 * - A record_array field whose MAppend target IS a declared keyed/merge collection
 *   is presented as the ELEMENT (object) type and appended ONE record per call
 *   through a dedicated repeatable append action (upsert-by-key), and is REMOVED
 *   from the one-shot terminal action's arg_schema/mutations. A keyed MAppend
 *   upserts a single element by key, so a batch array never resolves the key.
 * - A record_array field whose MAppend target is NOT keyed keeps the #825 whole-
 *   array (type: array) batch shape on the terminal action (engine fans it out).
 */

function recordArrayContract(): ReasoningStageContract {
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'extract',
    reasoning_prompt: 'Extract every relevant entity from the aggregated material and record each one, then report the count.',
    result_schema: {
      fields: [
        {
          name: 'records',
          type: 'record_array',
          description: 'The extracted entity records.',
          record_fields: { contact_id: 'string', name: 'string', score: 'number' },
        },
        { name: 'record_count', type: 'number', description: 'How many records were extracted.' },
      ],
      allow_extra_fields: true,
    },
    items_schema: { templates: ['record:<contact_id>'], description: 'Key:value item strings.' },
    canned_example: {
      result: { records: [{ contact_id: 'c-1', name: 'Example', score: 1 }], record_count: 1 },
      items: ['record:c-1'],
    },
    contract_source: 'meta_llm',
  };
}

const extractAction: TransitionAction = {
  name: 'complete_extract',
  source: 'extract',
  target: 'persist',
  archetype: 'llm-reasoning',
  guardField: 'extract.done',
};

const KEYED_PATH = 'extract.result.records';

describe('keyed record_array emission is keyed-aware and general (pgas#993)', () => {
  it('non-keyed record_array → batch array arg (#825) stays on the terminal action', () => {
    const entry = actionMapEntryFor(extractAction, 'intake', undefined, recordArrayContract(), undefined);
    const argSchema = entry.arg_schema as Record<string, { type?: string }> | undefined;
    const mutations = entry.mutations as Array<Record<string, unknown>>;

    // The engine fans a non-keyed record-array MAppend out element-wise, so the
    // whole-array (type: array) shape is correct and is kept on the terminal action.
    expect(argSchema?.records?.type).toBe('array');
    expect(mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'MAppend', path: KEYED_PATH, value: {}, from_arg: 'records' }),
    ]));
  });

  it('keyed record_array → removed from the terminal action (moved to element append)', () => {
    const entry = actionMapEntryFor(extractAction, 'intake', undefined, recordArrayContract(), new Set([KEYED_PATH]));
    const argSchema = entry.arg_schema as Record<string, { type?: string }> | undefined;
    const mutations = entry.mutations as Array<Record<string, unknown>>;

    // The keyed record_array field is no longer a terminal-action arg…
    expect(argSchema?.records).toBeUndefined();
    // …but the scalar summary field remains on the terminal action.
    expect(argSchema?.record_count?.type).toBe('number');
    // …and the batch MAppend is gone from the terminal action.
    expect(mutations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'MAppend', path: KEYED_PATH }),
    ]));
  });

  it('keyed record_array → repeatable element (object) append action + loop guidance', () => {
    const actionMap: MutableRecord = {
      complete_extract: { mutations: [], channel: 'stage_output' },
    };
    const modes: MutableRecord = {
      extract: { vocabulary: ['complete_extract'], channels: ['user_text', 'widget_output', 'stage_output'] },
    };
    const guidance: MutableRecord = {};
    const reasoningContractsBySlug = new Map([['extract', recordArrayContract()]]);
    const keyedCollections = [{ collection: KEYED_PATH, key: 'contact_id' }];
    const transitionActionsBySource = new Map([['extract', [extractAction]]]);

    applyKeyedRecordArrayAppendActions(
      actionMap,
      modes,
      guidance,
      reasoningContractsBySlug,
      keyedCollections,
      transitionActionsBySource,
    );

    const append = actionMap.append_extract_records as {
      arg_schema?: Record<string, { type?: string }>;
      mutations?: Array<Record<string, unknown>>;
    } | undefined;

    // The from_arg is presented as the ELEMENT (object) type — a single upsertable
    // record carrying the key — not the #825 whole-array shape.
    expect(append?.arg_schema?.records?.type).toBe('object');
    expect(append?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'MAppend', path: KEYED_PATH, value: {}, from_arg: 'records' }),
    ]));

    // The append action joins the stage vocabulary and the mode gets loop guidance
    // instructing one record per call, upserted by the declared key.
    expect(modes.extract as { vocabulary: string[] }).toMatchObject({
      vocabulary: expect.arrayContaining(['append_extract_records']),
    });
    const stageGuidance = (guidance.extract as string[]).join('\n');
    expect(stageGuidance).toContain('append_extract_records');
    expect(stageGuidance).toContain('contact_id');
  });
});
