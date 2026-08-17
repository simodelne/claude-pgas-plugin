# Remaining 0-TS Reaction Gaps

Status: confirmed against `@simodelne/pgas-server@5.2.0`.

## Stage-Output Result Schema Materialization

The foundry still emits parsed-result-field mirror reaction handlers for stage outputs whose runtime payload is a JSON string plus typed subfields:

- deterministic/external stage outputs at `<stage>.output.result_json` into `<stage>.result.<field>`
- LLM reasoning raw mirrors from `<stage>.raw_result_json` / `<stage>.raw_result_fields.*` into `<stage>.result.<field>`

v5.2.0 includes pgas#921 `materializeResultSchemaFields`, but the public surface is delegation-channel scoped:

- `Channel.resultSchema?: Record<string, string>` / raw `channels.*.result_schema`
- `DelegationSettlementInput.resultSchema`
- settlement writes through `materializeResultSchemaFields(session, resultPath, result, resultSchema, alreadyFlat)`

There is no corresponding public declaration on `ActionSemantics` / raw `action_map` for a stage-output `result_schema`, and ordinary `action_map.result_path` writes do not receive a result schema argument.

## Ask

Add a stage-output result-schema materialization primitive for sync effect results:

- allow an action-map result schema declaration for `action_map.<action>.result_path`
- validate result-object-relative field paths against declared schema leaves
- materialize typed subpaths under the action `result_path`, matching the delegation-channel behavior where possible

Falsifier for pgas-new adoption: a generated LLM-reasoning stage can declare the result schema, drive a stage action, and land `<stage>.result.<field>` typed domain state without a `mirror_<stage>_result_fields` reaction handler.

Until that surface exists, the mirror reactions remain a genuine engine gap rather than a consumer stopgap.
