import { describe, expect, it } from 'vitest';
import {
  assessKeyedCollectionEngagement,
  type GeneratedLiveDriveKeyedCollectionAssessmentInput,
  type GeneratedLiveDriveKeyedCollectionReport,
} from '../../src/pgas-new/generated-live-drive.js';

/**
 * pgas#993 keyed-collection LIVE-drive verdict — fail-closed, per failure mode.
 *
 * The verdict must NOT settle for "the program completed". It proves the keyed
 * semantics actually fired on the live run:
 *   - the element-append action was called MORE THAN ONCE (one record per call);
 *   - a key was genuinely RE-APPENDED and the upsert REPLACED it (one element,
 *     carrying the LAST payload) — the property that separates a working keyed
 *     collection from a silent no-op or a first-write-wins store;
 *   - the terminal action never carried the record_array as a batch arg;
 *   - the collection is non-empty and every element carries the declared key.
 *
 * The engine-level ground truth these expectations mirror is pinned hermetically
 * in tests/integration/keyed-collection-engine-falsifier.test.ts (K-1..K-4).
 */

const COLLECTION = 'extract_records.result.records';
const KEY = 'record_id';
const FIELD = 'records';
const APPEND_ACTION = 'append_extract_records_records';
const TERMINAL_ACTION = 'complete_extract_records';
const STAGE = 'extract_records';

/**
 * The happy shape: four element-appends over three distinct keys, with `r-1001`
 * re-appended under a CORRECTED payload, three elements landing, and the
 * terminal action carrying no record_array arg.
 */
function goodReport(): GeneratedLiveDriveKeyedCollectionReport {
  return {
    collection_path: COLLECTION,
    key_field: KEY,
    append_action: APPEND_ACTION,
    terminal_action: TERMINAL_ACTION,
    field: FIELD,
    append_calls: [
      { round: 2, arg_kind: 'object', key: 'r-1001', record: { record_id: 'r-1001', label: 'Halogen Lamp Assembly', unit_price: 42 } },
      { round: 3, arg_kind: 'object', key: 'r-1002', record: { record_id: 'r-1002', label: 'Copper Bus Bar', unit_price: 17 } },
      { round: 4, arg_kind: 'object', key: 'r-1003', record: { record_id: 'r-1003', label: 'Ceramic Insulator Set', unit_price: 9 } },
      { round: 5, arg_kind: 'object', key: 'r-1001', record: { record_id: 'r-1001', label: 'Halogen Lamp Assembly (Rev B)', unit_price: 46 } },
    ],
    terminal_calls: [{ round: 6, arg_kind: 'absent' }],
    collection: [
      { record_id: 'r-1001', label: 'Halogen Lamp Assembly (Rev B)', unit_price: 46 },
      { record_id: 'r-1002', label: 'Copper Bus Bar', unit_price: 17 },
      { record_id: 'r-1003', label: 'Ceramic Insulator Set', unit_price: 9 },
    ],
    collection_size: 3,
  };
}

function assess(
  report: GeneratedLiveDriveKeyedCollectionReport | null,
  overrides: Partial<GeneratedLiveDriveKeyedCollectionAssessmentInput> = {},
) {
  return assessKeyedCollectionEngagement({
    report,
    finalMode: 'complete',
    providerHits: 12,
    hostStage: STAGE,
    ...overrides,
  });
}

describe('assessKeyedCollectionEngagement (pgas#993 live-drive verdict)', () => {
  it('passes only when every keyed criterion holds', () => {
    const verdict = assess(goodReport());
    expect(verdict.notes).toEqual([]);
    expect(verdict.reason).toBeNull();
    expect(verdict.keyed_collection_engaged).toBe(true);
    expect(verdict.append_call_count).toBe(4);
    expect(verdict.distinct_key_count).toBe(3);
    expect(verdict.collection_size).toBe(3);
  });

  it('FAIL: no report at all', () => {
    const verdict = assess(null);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('keyed_collection_report_absent');
    expect(verdict.reason).toBe('keyed_collection_report_absent');
  });

  it('FAIL: the element-append action fired only once (a batch, not a repeat)', () => {
    const report = goodReport();
    report.append_calls = [report.append_calls[0]!];
    report.collection = [report.collection[0]!];
    report.collection_size = 1;
    const verdict = assess(report);
    expect(verdict.append_action_repeated).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('append_action_not_repeated:1');
  });

  it('FAIL: the element-append action never fired', () => {
    const report = goodReport();
    report.append_calls = [];
    const verdict = assess(report);
    expect(verdict.append_action_repeated).toBe(false);
    expect(verdict.one_record_per_call).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('append_action_not_repeated:0');
  });

  it('FAIL: an append carried a BATCH array instead of a single element', () => {
    const report = goodReport();
    report.append_calls[1] = { round: 3, arg_kind: 'array', key: null, record: null };
    const verdict = assess(report);
    expect(verdict.one_record_per_call).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('batch_arg_on_append:round=3:kind=array');
  });

  it('FAIL: an appended record carried no value for the declared key', () => {
    const report = goodReport();
    report.append_calls[2] = { round: 4, arg_kind: 'object', key: null, record: { label: 'Unkeyed' } };
    const verdict = assess(report);
    expect(verdict.every_append_keyed).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('append_missing_key:round=4');
  });

  it('FAIL: no key was ever re-appended — the dedupe property is UNTESTED, not passed', () => {
    const report = goodReport();
    // Four distinct keys: every append is an insert, so upsert-by-key never fired.
    report.append_calls[3] = {
      round: 5,
      arg_kind: 'object',
      key: 'r-1004',
      record: { record_id: 'r-1004', label: 'Brass Ferrule', unit_price: 4 },
    };
    report.collection = [
      ...report.collection,
      { record_id: 'r-1004', label: 'Brass Ferrule', unit_price: 4 },
    ];
    report.collection.splice(0, 1, { record_id: 'r-1001', label: 'Halogen Lamp Assembly', unit_price: 42 });
    report.collection_size = 4;
    const verdict = assess(report);
    expect(verdict.duplicate_key_reappended).toBe(false);
    expect(verdict.upsert_replaced_latest).toBe(false);
    // Everything else is green — the verdict must still refuse.
    expect(verdict.upsert_deduped).toBe(true);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('dedupe_property_untested:calls=4:distinct=4');
  });

  it('FAIL: the re-appended key DUPLICATED instead of upserting', () => {
    const report = goodReport();
    report.collection = [
      { record_id: 'r-1001', label: 'Halogen Lamp Assembly', unit_price: 42 },
      { record_id: 'r-1002', label: 'Copper Bus Bar', unit_price: 17 },
      { record_id: 'r-1003', label: 'Ceramic Insulator Set', unit_price: 9 },
      { record_id: 'r-1001', label: 'Halogen Lamp Assembly (Rev B)', unit_price: 46 },
    ];
    report.collection_size = 4;
    const verdict = assess(report);
    expect(verdict.upsert_deduped).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('upsert_not_deduped:collection=4:distinct_keys=3');
  });

  it('FAIL: the keyed upsert silently NO-OPPED (empty collection)', () => {
    const report = goodReport();
    report.collection = [];
    report.collection_size = 0;
    const verdict = assess(report);
    expect(verdict.collection_non_empty).toBe(false);
    expect(verdict.every_element_keyed).toBe(false);
    expect(verdict.upsert_deduped).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('collection_empty');
  });

  it('FAIL: a landed element carries no value for the declared key', () => {
    const report = goodReport();
    report.collection[1] = { label: 'Copper Bus Bar', unit_price: 17 };
    const verdict = assess(report);
    expect(verdict.every_element_keyed).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('element_missing_key:index=1');
  });

  it('FAIL: first-write-wins — the element kept the SUPERSEDED payload', () => {
    const report = goodReport();
    // Deduped to three elements, but r-1001 still holds the pre-correction values:
    // that is a store that ignores the re-append, not an upsert-by-key.
    report.collection[0] = { record_id: 'r-1001', label: 'Halogen Lamp Assembly', unit_price: 42 };
    const verdict = assess(report);
    expect(verdict.upsert_deduped).toBe(true);
    expect(verdict.upsert_replaced_latest).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('replacement_stale:key=r-1001:field=label');
  });

  it('FAIL: the re-append was byte-identical, so replacement is not observable', () => {
    const report = goodReport();
    report.append_calls[3] = {
      round: 5,
      arg_kind: 'object',
      key: 'r-1001',
      record: { record_id: 'r-1001', label: 'Halogen Lamp Assembly', unit_price: 42 },
    };
    report.collection[0] = { record_id: 'r-1001', label: 'Halogen Lamp Assembly', unit_price: 42 };
    const verdict = assess(report);
    expect(verdict.duplicate_key_reappended).toBe(true);
    expect(verdict.upsert_deduped).toBe(true);
    // Replacement and first-write-wins are indistinguishable here — refuse.
    expect(verdict.upsert_replaced_latest).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('replacement_not_observable:r-1001');
  });

  it('FAIL: the terminal completion action carried the record_array as a batch arg', () => {
    const report = goodReport();
    report.terminal_calls = [{ round: 6, arg_kind: 'array' }];
    const verdict = assess(report);
    expect(verdict.terminal_batch_arg_absent).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('terminal_carried_record_array_arg:round=6:kind=array');
  });

  it('FAIL: the terminal completion action never fired, so batch-absence is untested', () => {
    const report = goodReport();
    report.terminal_calls = [];
    const verdict = assess(report);
    expect(verdict.terminal_batch_arg_absent).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('terminal_action_never_fired');
  });

  it('FAIL: the program did not reach its completion stage', () => {
    const verdict = assess(goodReport(), { finalMode: 'persist_records' });
    expect(verdict.parent_complete).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('parent_not_complete:expected=complete:actual=persist_records');
  });

  it('FAIL: fewer provider round trips than appends — the appends cannot all be live decisions', () => {
    const verdict = assess(goodReport(), { providerHits: 3 });
    expect(verdict.provider_hits_ok).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes).toContain('provider_hits_below_append_rounds:min=5:actual=3');
  });

  it('FAIL: executed-path stub markers in the produced state', () => {
    const verdict = assess(goodReport(), { stubFindings: ['extract_records.result_json: "todo"'] });
    expect(verdict.no_stub_markers).toBe(false);
    expect(verdict.keyed_collection_engaged).toBe(false);
    expect(verdict.notes[0]).toContain('stub_markers_present');
  });

  it('tolerates the host stage empty items_json false positive, like the other verdicts', () => {
    const verdict = assess(goodReport(), { stubFindings: [`${STAGE}.items_json: empty_array`] });
    expect(verdict.no_stub_markers).toBe(true);
    expect(verdict.keyed_collection_engaged).toBe(true);
  });
});
