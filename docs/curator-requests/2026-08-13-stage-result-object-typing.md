# Curator request → pgas engine: stage-result OBJECT-typing (the pervasive blocker for view:/render:/reactions)

**From:** pgas-new curator  **To:** pgas engine curator  **Date:** 2026-08-13  **Priority:** HIGH — escalated to PRIMARY (blocks view:/render:/sub-field reactions across the 0-`.ts` campaign)

## Escalation
This was filed as a "secondary residual" in `2026-08-13-per-item-delegation-fanout-primitive.md` (the JSON-string
explode). A Phase-B baseline measuring the foundry's actual `view:` migration surface **escalates it to a primary
blocker**: it gates `view:` (#884), `render:` (#901), AND the sub-field mirror/settle reactions — i.e. blueprint blocks
9, 10, and much of 8.

## The measurement (why it's primary)
Migrating the foundry's projection builders to `view:` (which reads ONE domain path VERBATIM → `derived.<key>`):
**0 of 41 projection-builder outputs are `view:`-clean** (fee-proposal `projection.ts` 0/22; simoneos governed-attach
inline projection 0/19). Every output is presentation shaping over **`parseJsonObject(result_json)`** — the builders
PARSE a stringified-JSON stage result to reach any field. Because the value lives inside a JSON *string*, there is no
verbatim domain path for `view:`/`render:` to read; the consumer must parse. The same holds for `report-data.ts`
(`render:`) and the sub-field mirror/settle reactions (`documentArtifactMutations`, JSON-audit mirrors).

## The ask: stage results as typed OBJECTS, not stringified JSON
Make a stage's/tool's/child's result land in the world as a **typed object at declared sub-paths** (e.g.
`fee_modelling.result.fixed_quote: number`, `remediation_summary.result.decision: string`) rather than a single
`result_json` STRING that consumers must `JSON.parse`. Then:
- `view:` sections read verbatim typed paths (`derived.fixed_quote from fee_modelling.result.fixed_quote`).
- `render:` reads typed fields directly.
- mirror/settle reactions become `derived_paths[field_value]` (whole-value copies) with no parse step.

The reasoning-contract `result_schema` ALREADY declares the field types + the foundry already mirrors contract fields
into typed `*.result.*` paths — so the shape exists; the ask is to make the engine land results **as** those typed
paths natively (killing the `result_json` string round-trip), and extend it beyond contract fields to arbitrary
declared result sub-paths (incl nested, e.g. `parameters_json`). Your gap audit
(`docs/superpowers/specs/2026-08-11-zero-consumer-ts-gap-audit.md`) already flags this (Tier-3 #7) and notes "most of
pgas-new's `.ts` disappears" if done upstream — this measurement confirms it's the higher-leverage of the two 0-`.ts`
blockers (alongside #1 per-item delegation-fan-out).

## What the foundry does on this shipping
Phases B (`view:`) + C (`render:`) unblock: the foundry emits `view:`/`render:` reading verbatim typed paths, deletes the
parsing projection/report builders, and the sub-field reactions collapse to `derived_paths`. Combined with #1 (fan-out)
and the already-shipped #912 (registerProgramByConvention / web_search / policies), fan-out programs reach `pure:strict` /
1-`specs.yml`-0-`.ts`. Until then the foundry executes the structural Phase E (11-block + policies + registration-by-
convention) + Phase D-partial (web_search + #902/#903 + whole-value reactions), and tracks B/C as blocked on this ask.

Full plan: pgas-new `docs/superpowers/specs/2026-08-13-foundry-blueprint-convergence-design.md`.
