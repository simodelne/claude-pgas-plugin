# Curator request: nested array-of-object parameter schema in native tool emission

- **Date:** 2026-08-06
- **Upstream:** `@simodelne/pgas-server` (engine monorepo `simodelne/pgas`); filed as `simodelne/pgas#825`
- **Origin:** pgas-new graduated program `lead-research-agent` (v3.26.0); curator repo
  `/home/simone/pgas-intelligence`, flag **F-1** in that repo's `docs/handover/FOUNDRY-FLAGS.md`.
- **pgas-new version:** 3.26.0 · engine 3.26.0

## Why this is upstream (engine boundary)
Native tool schema emission (`buildUnifiedTools`) and the tool-arg → state mutation path (MSet / `from_arg`
sentinels, the `action_map` surface, and the `S-11` MSet gate) are engine-owned in `@simodelne/pgas-server`.
pgas-new is a read-only consumer of public exports and cannot change how a reasoning-stage `result_json` field
becomes a provider tool-parameter JSON schema. This request asks the engine curator to add the surface needed to
express a **repeated structured record** (array of objects) as a tool parameter.

## The capability that needs it
pgas-new v3.26.0 shipped `config_driven_extraction_schema`: a stage's `domain_spec.produces.result_json.<field>`
may be a **repeated-record schema** — an array containing exactly one object, e.g.:

```jsonc
"leads": [{ "name": "string", "role": "string", "company": "string",
            "email": "string", "profile_url": "string", "notes": "string",
            "relevance_score": "number" }]
```

The intended semantics: the LLM emits `leads` as an **array of structured records**, which then flow through
aggregate → persist (dedupe by a record key such as `email`) → report. This is the core of the
`lead-research-agent` program (and any extraction/CRM-shaped program).

## Observed (static + dynamic trace, engine 3.26.0)
The foundry can declare the field, but the engine cannot emit a usable provider schema for it:

1. **`buildUnifiedTools` maps only top-level JSON types and sets `items: {}` for arrays.** A minimal public-engine
   spec with nested schema paths and `from_arg: leads` produced:
   ```json
   { "description": "Structured leads array.", "type": "array", "items": {} }
   ```
   The array item shape is empty, so the provider is never shown the record structure and cannot reliably emit
   structured records.
2. **`action_map` supports `arg_descriptions`, not parameter schemas** — there is no way to attach an item schema
   to an array-typed argument via the action map.
3. **An array-typed MSet target path is rejected before tool emission** with
   `S-11: ... MSet path ... is array-typed`.

Net: there is no public-engine path to present an LLM with `{ type: "array", items: { type: "object",
properties: { ... } } }` for a stage argument, so a repeated-record `produces` field degrades to a scalar
`string` in the synthesized reasoning contract (`reasoning-contract.ts domainSpecFieldType` has no record-array
type to map it to). A real drive then emits `leads` as a summary string and the `persist` stage throws
`persistence stage requires a non-empty records/leads/contacts/items array`.

## Requested change
Add one of the following public surfaces so a repeated-record stage field can be emitted as a nested
array-of-object tool parameter:

1. **Nested JSON-schema derivation in `buildUnifiedTools`** — derive `items: { type: "object", properties: {...} }`
   (and requiredness) from a declared nested schema path / `result_json` sub-schema, instead of `items: {}`; and
   allow the corresponding array-typed MSet target (lift the `S-11` rejection for a schema-declared
   array-of-object write), OR
2. **An `action_map` parameter-schema override** — let a `from_arg` sentinel argument carry an explicit JSON
   Schema (including `items` for arrays), which `buildUnifiedTools` passes through to the provider tool schema and
   the gate layer accepts for the array-typed write.

Either lets the foundry express "the LLM emits an array of structured records" natively.

## Impact
Blocks the **live run** of any generated program that extracts a collection of structured records (leads,
contacts, line items, findings) — including `lead-research-agent` (the CRM-foundation program). Programs still
reach `complete` against mocks and the deterministic drive, but a real provider cannot emit the structured
collection. This affects the whole `config_driven_extraction_schema` capability class, not just one program.

## Notes
- The owner has chosen **engine request only** (2026-08-06): no interim foundry workaround (e.g. string-encoded
  records via `items_json` + deterministic parse) will be shipped; the durable fix is this upstream surface.
- pgas-new-side, `reasoning-contract.ts` is ready to add a `record_array` field type the moment the engine can
  carry a nested item schema through to the provider tool; that foundry change is gated on this request.
