# pgas#1048 acceptance case (from pgas-new)

**From:** pgas-new · 2026-08-24
**Pin:** `feat/v57-render-sectionlist` @ `7b0fe97e`, engine `@simodelne/pgas-server` 5.7.1
**Provenance:** shapes below are the REAL foundry emission, dumped from
`applyKeyedRecordArrayAppendActions` + `actionMapEntryFor`, not hand-written.
Reproducible from the fixture in `tests/unit/keyed-record-array-emission.test.ts`
(field `records`, key `contact_id` — deliberately NOT the lead-research names, to show it is general).

## 1. Exact generated action

Emitted for any stage whose `record_array` result field targets a DECLARED keyed/merge collection
(here `keyed_collections: [{ collection: 'extract.result.records', key: 'contact_id' }]`):

```json
{
  "description": "Append ONE record record to extract.result.records; it is upserted by contact_id (re-appending the same contact_id REPLACES that record, never duplicates). Call once per record, then call complete_extract to record the summary fields and advance. The extracted entity records.",
  "arg_descriptions": {
    "records": "A single record record (object) with fields: {\"contact_id\":\"string\",\"name\":\"string\",\"score\":\"number\"}. Provide exactly ONE record per call; it is upserted into extract.result.records by contact_id."
  },
  "arg_schema": {
    "records": { "type": "object", "required": true }
  },
  "mutations": [
    { "op": "MAppend", "path": "extract.result.records", "value": {}, "from_arg": "records" }
  ],
  "channel": "widget_output"
}
```

Action name: `append_extract_records` (general form `append_<stage>_<field>`).

## 2. The gap, stated exactly

`arg_schema.records` can say **only** `{"type":"object","required":true}`. The record's inner shape —
`{contact_id: string, name: string, score: number}` — is expressible **only as PROSE** in
`arg_descriptions`. Nothing structural constrains it, so **any** object satisfies the gate and reaches
the capability unvalidated. This is #1048's exact shape.

**Why it is worse than a generic unvalidated arg here:** the un-constrainable property `contact_id` IS
the declared **upsert key** of a keyed collection. Per pgas#993 a keyed `MAppend` upserts ONE element
BY KEY, so a record arriving without `contact_id` cannot resolve its key. The write degrades to a
nondeterministic upsert no-op, which surfaces to the author as a per-item drafting **livelock** (the
model appends, observes no state change, appends again). That is the same failure class the #993
alignment was cut to eliminate — and today the ONLY thing preventing it is prose the model may ignore.

## 3. Acceptance case

**Missing required property:** `contact_id` (the `keyed_collections` key for the MAppend target path).

**RED — must be REJECTED pre-dispatch.** Tool call to `append_extract_records`:

```json
{ "records": { "name": "Example", "score": 1 } }
```

Expected: rejection BEFORE the capability/mutation is dispatched, with a message naming BOTH the arg
and the missing property, e.g.
`append_extract_records: arg "records" is missing required property "contact_id"`.

Two properties we care about in the rejection:
1. it names the **arg** (`records`) and the **property** (`contact_id`) — so repair steering can act on it;
2. it fires **pre-dispatch** — no partial/no-op `MAppend` against `extract.result.records` is attempted.

**GREEN — valid-dispatch control, must dispatch UNCHANGED:**

```json
{ "records": { "contact_id": "c-1", "name": "Example", "score": 1 } }
```

Expected: dispatches exactly as today; `MAppend extract.result.records from_arg records` upserts by
`contact_id`; no behaviour change vs 5.7.1 for well-formed calls.

**Additional control — do not over-reject.** `allow_extra_fields: true` is set on this result schema,
so an extra unpaired property must still be ACCEPTED:

```json
{ "records": { "contact_id": "c-2", "name": "Example", "score": 2, "notes": "extra" } }
```

## 4. What pgas-new would emit once #1048 lands

Given an object-shape constraint we would emit the record shape structurally (property types +
`required: ["contact_id"]`) instead of encoding it in `arg_descriptions` prose, and drop the prose to a
human-readable summary only. We are happy to pin that emission against your loader/runtime/bundle
acceptance once the grammar is fixed — tell us the shape and we will match it.

## 5. Note on scope

This is a **generalization** ask, not a pgas-new special case: it applies to every `record_array` field
whose MAppend target is a declared keyed collection, for any stage/field/key names. No consumer-side
workaround is proposed or wanted — validating an object arg in consumer code would be exactly the
"consumer heuristic that validates what the engine should" drift we avoid.
