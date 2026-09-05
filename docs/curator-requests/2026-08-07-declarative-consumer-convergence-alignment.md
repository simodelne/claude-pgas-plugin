# Coordination: foundry governed-logic enforcement ↔ pgas declarative-consumer-convergence roadmap

- **Date:** 2026-08-07
- **Upstream roadmap:** `simodelne/pgas` #831 (+ the tmux roadmap
  `/home/simone/pgas-ask-declarative-consumer-convergence.md`), P1 — the owner's *"declarative consumers, zero logic"*
  objective.
- **Foundry side:** `docs/superpowers/specs/2026-08-06-governed-logic-enforcement-design.md` (Phase 1 shipped, PRs
  #292–#295). This doc records the alignment so the foundry's fail-closed refusals + engine-primitive registry cite the
  real pgas roadmap and honor its build order.

## The three coordinated halves of one program
1. **Engine (pgas):** ship the primitive family that lets consumers be declarative.
2. **simoneos:** migrate every program to declarations, delete ~417 units of consumer logic (Fable-gated → UAT).
3. **pgas-new (this foundry):** enforce that GENERATED programs are declarative — the governed-logic gate (Phase 1 shipped)
   + fail-closed refusal + engine requests. Same objective, generation side.

## The 5-primitive engine family (authoritative; foundry registry must mirror)
Consumer imperative logic clusters into 6 recurring patterns; 5 need new engine primitives (NL-interpretation adopts
typed-field + GKType). Foundry construct-class ↔ pgas primitive ↔ status:

| # | pgas primitive | logic pattern (programs) | foundry construct class | status |
|---|---|---|---|---|
| 1 | `first_item_where_field_ne` | iteration-cursor (9) | (iteration-cursor — add in P2) | **SHIPPED v3.28.0** (pgas #829); *usable only after #3* |
| 2 | `all_items_field_eq` (completion-predicate) | completion-guard (15) | completion branching | **building** (foundry active ask) |
| 3 | `keyed_by` (keyed/idempotent collection) | collection-hygiene (14) | `compute_dedup` | **building — LINCHPIN, largest class** (foundry active ask) |
| 4 | content-invariant / finalization predicate over authored fields | validation-governance (13) | `adhoc_validation_throw` | **asked** (pgas #831; `schemaInvariants` does NOT exist in the sealed bundle) |
| 5 | mode-scoped AfterRound recovery-steer | approval-gating / recovery loops (11) | (recovery-steer — add in P2) | **asked** (pgas #831) |

NL-interpretation (17 programs) → **adopt existing**: LLM writes a typed schema field + GKType/GKStructural + observer
repair; for governance-critical facts add structured intake + confirmation_pairing. No new primitive (only discrete
typed-fact capture is truly adopt-now, ~1 unit/program).

## Build order (from the dependency finding — HONOR THIS)
**#3 → #1(usable) → #2.** `first_item_where_field_ne` (#1) scans one collection reading a per-item `status`, but real
programs keep items and their status in DISJOINT collections; only #3's keyed by-id upsert can put a per-item `status` on
the scanned collection. #3 is both the linchpin and the largest gated class. Prioritize by unit-count:
**#3 + #4 + #2 unblock the most.**

## Foundry implications
- **engine-primitive-registry.ts** currently maps only #2/#3 (the two active asks). In **Phase 2** it expands to the full
  family: add #1 (iteration-cursor, mark SHIPPED-but-gated-on-#3), #4 (content-invariant → `adhoc_validation_throw`), #5
  (recovery-steer), each with its pgas issue ref + status. The gate's enforced-construct set expands per primitive as each
  lands (fail-closed: refuse the class until its primitive ships).
- **Do NOT adopt #1 yet** despite it shipping in engine 3.28.0 — the dependency finding says it is not usable until #3
  lands. Register it as shipped-but-gated; adopt when #3 is available.
- The foundry's `governed_compute_pending_primitive` refusal (Phase 1) is correct and now traceable to this roadmap:
  a generated program needing dedup/completion/validation/recovery refuses + links here until #2/#3/#4/#5 land.
- **NL-interpretation** in generated programs: the canonical declarative shape is typed-field capture + GKType (+ structured
  intake + confirmation_pairing for governance-critical facts) — the foundry already has confirmation-loop synthesis; no
  new primitive needed for that class.

## Status
Phase 1 enforcement SHIPPED (the mechanism). Phase 2 (migrate emitters declare-or-refuse + expand the registry/gate to the
full family) and Phase 3 (adopt each primitive as it lands, flip capabilities to `synthesizes`) are gated on the pgas
5-primitive family. Coordinate cadence: #3 first, then #4/#2, then #1(usable)/#5.

**Footer (2026-09-05): ALL FIVE PRIMITIVES LANDED.** The table above is a historical coordination record; the
"building"/"asked" cells are stale. simodelne/pgas#831 CLOSED completed 2026-08-07 (closing comment: "Shipped in
pgas-server v3.30.0 … #4 = numeric-comparison predicates … #5 = recovery_steers"); #2/#3 landed in 3.29.0 and #4/#5
in 3.30.0 per `src/foundry-program/engine-primitive-registry.ts` (`since_engine_version`), which marks every row
`landed`. Current engine pin: 6.6.1.
