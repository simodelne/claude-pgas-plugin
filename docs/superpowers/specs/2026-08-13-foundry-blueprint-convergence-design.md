# Foundry ↔ Consumer-Spec-Blueprint Convergence — design + phased plan

**Date:** 2026-08-13  **Status:** design (feasibility-verified), phased execution starting

## v4.5.0 UPDATE (2026-08-13, #912 GAP-6/7/8 shipped) — resolves 2 of 3 engine asks
pgas-server **v4.5.0** (additive/byte-identical over 4.4.0) ships: declarative **`policies:`** (blueprint block 11 — many
`*Policy` interfaces incl RetryBudget/RoundBudget/Query/DenialTracking/ContentScan/Risk/ProgramQuery), engine **`web_search`
capability** (deletes the per-program web-navigation CONNECTOR), and **`registerProgramByConvention`** (builds ProgramEntry
from `programs/<name>/`: specs.yml + view/render/policies/capability + frontend.spec.yml — **deletes `registration.ts`** =
my ask #3). So "1 specs.yml, 0 `.ts`" is reachable WHEN handlers are engine-capabilities only. **Pin target is now `^4.5.0`.**
Mapping updates: `registration.ts` → registerProgramByConvention (SHIPPED); web-navigation connector → `web_search`
capability (SHIPPED); block-11 policy → declarative `policies:` (SHIPPED). **Engine asks now: only #1 (per-item
delegation-fan-out primitive — CONFIRMED still absent in 4.5.0; only engine-internal event-bus fan-out exists) + #2
(JSON-string explode, likely upstream tool-param-object-typing) remain.** #915 blueprint triaged → **#917 filed** (compiler
enforcement / multi-file import).

---

**Drivers:** simoneos 0-consumer-`.ts` campaign; pgas v4.4.0 (`view:`#884, `render:`#901, `requires_delegations`#902,
conversational delegation #903, `pure_strict` feature, `merge_collection`); consumer-spec BLUEPRINT pgas#915 +
`simoneos .worktrees/fee-blueprint/docs/superpowers/specs/2026-08-13-consumer-spec-blueprint-design.md`.

## PHASE B FINDING (2026-08-13) — view:/render: BLOCKED on stage-result object-typing (ask #2 → PRIMARY)
Phase B baseline (worker STOP-gate): **0 of 41 projection-builder outputs are `view:`-clean.** Every one is presentation
shaping over `parseJsonObject(result_json)` — the foundry's projection/report builders PARSE stringified-JSON stage
results, not verbatim domain paths, so `view:` (reads ONE path verbatim) cannot express them. Emitter boundary:
`projection.ts` only for existing-repo `curator_request` attach + simoneos governed-attach inline; generic standalone =
`report-data.ts` (no projection.ts); `spec.projection` already declarative WorldView. **Consequence: ask #2 (stage-result
object-typing) is the PERVASIVE PRIMARY blocker for `view:`(B) + `render:`(C) + sub-field mirror/settle reactions(D)** —
until stage results are typed OBJECTS the builders MUST parse, so they can't become verbatim declarations. **Re-sequence:**
B+C HELD on ask #2; achievable-now = **E** (11-block org + `policies:` + `registerProgramByConvention`, structural) +
**D-partial** (`web_search` + `#902`/`#903` + whole-value reactions). **F** (`pure:strict`) needs asks #1(fan-out)+#2(typing).
The two highest-leverage engine asks — #1 per-item delegation-fan-out + #2 stage-result object-typing — BOTH block 0-`.ts`.

## 1. Target shape (the unified blueprint)
A foundry-synthesized/graduated program is BORN as its spec — an 11-block canonical spec, no per-program logic `.ts`:

| # | Block | Foundry emits |
|---|---|---|
| 1 identity | name, version, description, kind, metadata |
| 2 domain | schema (world shape) + engine-owned/derived path decls |
| 3 lifecycle | modes, initial, terminal, transitions |
| 4 channels | user IO + delegation channels |
| 5 actions | action_map (vocabulary + mutations + arg_schema) |
| 6 guidance | per-mode prompts / $ref fragments |
| 7 delegation | #903 conversational, #902 requires_delegations, result_schema |
| 8 validation | preconditions, invariants, recovery_steers, no_action_escapes, bounds |
| 9 view | #884 `view:` + derived_paths |
| 10 render | #901 `render:` deliverable profile |
| 11 policy | declarative policies (delegation/continuation/reliability/artifact/query, #912) |

Interim (until #915 own-spec `import:` ships): ONE `specs.yml` with the 11 blocks in canonical order + section-header
comments; empty blocks = comment only. Target: root manifest `import:` per-block YAML files.

## 2. Current foundry output → target mapping
| Current per-program artifact | Target | Reachable with v4.4.0? |
|---|---|---|
| `specs.yml` (flat) | 11-block ordered (interim single-file + headers) | **YES** — structural re-org |
| `projection.ts` | block 9 `view:` (#884) | **YES** — adopt `view:`, DELETE `projection.ts` |
| `report-data.ts` | block 10 `render:` (#901) | **YES** — adopt `render:`, DELETE `report-data.ts` (retires the `numeric_aggregate` projection-debt) |
| `handlers.ts` — output-mirror reactions | declarative reactions / `derived_paths[field_value]` | **YES** (whole-value); DELETE these bodies |
| `handlers.ts` — delegation-settle (flags) | `derived_paths[from_predicate]`; result lands at `result_path` mechanically | **YES** (flags); result delivery is engine glue |
| `handlers.ts` — **delegation FAN-OUT-advance** | per-item cursor-driven child dispatch | **NO — residual engine ask (the one blocker)** |
| `handlers.ts` — settle/mirror JSON-string sub-field reshape | `explode_json_result` OR upstream tool-param typing | **NO — residual (likely upstream fix)** |
| `tools.ts` / `connectors/*.ts` | shared `$ref` tools + host connectors (NOT per-program) | shared-tools ask (I/O legitimately consumer-owned but shared) |
| `stages/*.ts` (LLM-reasoning / pure-compute bodies) | domain compute — separate question (may legitimately stay as shared/engine-run) | out of blueprint scope (spec is declarative; compute is domain) |
| `registration.ts` | block-11 policy / #912 registration-bundle | #912 (designed, not in v4.4.0) |
| `contracts.ts` | types (engine-derivable from block-2 domain schema) | later |

## 3. Feasibility verdict — is `pure:strict` / 0-`.ts` reachable on v4.4.0?
**Reactions-declarative: YES for non-fan-out programs. `pure:strict` + delete-`handlers.ts`: NO for fan-out programs.**
`pure_strict` (Feature :141, contract :1910-1917) forbids effect-less reactions — every reaction must carry declarative
`mutations`/`guidance`. Today every foundry reaction is effect-less (body in `handlers.ts`). Per-class:
- **output-mirror (whole-value)** → `derived_paths[field_value]` + `when:path_truthy` = **DECLARATIVE-NOW**.
- **delegation-settle (flags)** → `derived_paths[from_predicate]`; raw result lands at `result_path` = engine glue.
- **cursor + completion** → `first_item_where_field_ne` + `all_items_field_eq` = **DECLARATIVE-NOW** (already emitted).
- **delegation FAN-OUT-advance** → **NO construct.** #902 = single dispatch obligation gating mode-exit; #903 =
  parent-as-user binding; #844 = data bucketing; `decision_targeting` = single-item target. None is the
  cursor-driven *dispatch→advance→harvest-per-slot→repeat-until-complete* loop. **← the one true blocker.**
- **JSON-string sub-field reshape** (settle/mirror plucking from a stringified-JSON result) → `derived_paths[field_value]`
  copies whole values only; sub-field pluck has no construct = Tier-3 #7 `explode_json_result`; **likely resolved
  UPSTREAM** by typing tool params as objects (kills the string round-trip) — higher leverage than a reaction primitive.
- **domain tool handlers** (`ToolHandler`s: begin_work/complete_*/notebook/session_*) → **legitimately consumer-owned**
  per #912; NOT the pure:strict blocker (pure:strict forbids reaction/projection/ingestion callbacks, not tool handlers).

Corroborated by the engine's own audit `/home/simone/pgas/docs/superpowers/specs/2026-08-11-zero-consumer-ts-gap-audit.md`
(names pgas-new's generator as load-bearing). Literal-zero-`.ts` (incl registration/shared-tools) additionally needs #912.

**Net endpoint:** with v4.4.0, the foundry can delete `projection.ts` + `report-data.ts` and make ALL reactions
declarative → `pure:strict` reachable for **non-fan-out** programs. **Fan-out programs (e.g. lead-research) cannot reach
`pure:strict` until a per-item delegation-fan-out primitive ships.** Two engine asks (below) close the gap.

## 4. Engine asks to file (coordinate w/ pgas — curator already has the gap audit)
1. **Per-item delegation-fan-out primitive** (THE blocker): a declarative binding of a delegation channel to
   `{collection, cursor=first_item_where_field_ne, per-item keyed result-sink, completion=all_items_field_eq}` that the
   engine drives (dispatch → advance cursor → harvest per slot → repeat until complete). Highest-leverage.
2. **JSON-string sub-field extraction** (Tier-3 #7): prefer the UPSTREAM fix — type delegation/tool result params as
   objects so no stringified-JSON round-trip exists (audit: "most of pgas-new's .ts disappears" if done upstream);
   only if that's rejected, ask for an `explode_json_result` reaction primitive.
3. **(tracking)** #912 registration-bundle + shared-`$ref` tools for literal-zero-`.ts` (designed; not in v4.4.0).

## 5. Phased plan (each phase deletes `.ts` / advances the shape; merge-on-green, falsifier-first)
- **Phase A — bump v4.4.0 + awareness.** Pin ^4.4.0 + lockstep; update ENGINE_DECLARATION_AWARENESS/catalog (view/
  render/#902/#903/pure_strict/merge_collection: available→adopt_backlog; note the fan-out blocker for pure:strict).
- **Phase B — adopt `view:` (#884).** Emit block-9 `view:` from the projection data; DELETE `projection.ts`; migrate via
  the projectionBuilderMigration coexist/merge ratchet (#911/#913). Falsifier: generated program projects via `view:`,
  no `projection.ts`, spec-loads on 4.4.0. *Retires the `numeric_aggregate` projection-debt* (the sum becomes a view/
  derived declaration).
- **Phase C — adopt `render:` (#901).** Emit block-10 `render:` deliverable profile; DELETE `report-data.ts`/renderers;
  never-fabricate. Falsifier: deliverable rendered from `render:`, no `report-data.ts`.
- **Phase D — declarative reactions + delegation (#902/#903).** Migrate output-mirror + settle-flag reaction bodies to
  `derived_paths`/declarative reaction `mutations`; adopt `requires_delegations` (review≠drafting) + conversational
  delegation where the manifest maps. Delete the migrated `handlers.ts` reaction bodies. Falsifier: reactions carry
  declarative effects; delegation dispatch/gating declarative.
- **Phase E — 11-block organization.** Restructure emitted `specs.yml` into the 11 canonical blocks (interim single-file
  + section headers; wire `import:` manifest when #915 lands). Falsifier: emitted spec passes the #915 loader/compiler
  block-organization validation (once available); structural test meanwhile.
- **Phase F — `pure:strict` (gated).** For programs whose reactions are fully declarative AND with NO fan-out, emit the
  `pure_strict` feature + delete the (now-empty) `handlers.ts`. Fan-out programs stay non-strict until ask #1 ships;
  the purity-ratchet declarative-debt registry tracks each blocked program to ask #1. Falsifier: non-fan-out generated
  program emits `pure_strict`, has no `handlers.ts`, loads on 4.4.0; fan-out program correctly does NOT claim strict.

## 6. Relationship to prior work
This is the convergence endpoint of governance PRs #292–#311: the purity ratchet (no logic sneaks back) + awareness
catalog + v4.2.0 primitives were the on-ramp; `view:`/`render:` are the projection-DSL/render-DSL filed 2026-08-11 now
shipped. The declarative-debt registry (program-purity.ts) becomes the tracker for which programs are `pure:strict`-blocked
on ask #1. Phases A–E are unblocked now; F is per-program-gated on the fan-out primitive.
