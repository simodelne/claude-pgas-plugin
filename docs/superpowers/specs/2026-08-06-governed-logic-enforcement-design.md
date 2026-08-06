# Governed-Logic Enforcement — Design Spec

**Date:** 2026-08-06
**Status:** Approved direction (four foundational decisions made by owner), design for Phase 1
**Owner:** pgas-new foundry
**Authority:** Simone/Hermes mandate 2026-08-06T21:05Z — proceed to implementation planning without waiting; do not ask
unless a destructive/security decision is required.

## 1. The invariant (what must be strictly enforced)

Foundry-generated PGAS programs must contain **no governable business/control logic outside the engine**. Governable
logic — control flow, validation, state writes, derived views, reads, and computation — must be expressed as
**engine-governed declarations or engine primitives**. Where the engine has no primitive for a needed governable
computation, the foundry is **fail-closed**: it **refuses** that capability (emitting no imperative fallback) and files/links
an **engine-primitive request**. The only code allowed outside the engine is a fixed, fenced set of *unavoidable* glue
(host connectors behind typed contracts, deterministic byte-generators, server/REPL bootstrap).

This extends the existing honest-refusal pattern (`export_docx_trackchange` refuses; #825 was an engine request) from
"capabilities the engine can't do" to "logic the engine can't *govern*."

## 2. Foundational decisions (owner-selected)

1. **Push governable logic into the engine** — the deep fix; stage bodies + handlers shrink to thin glue.
2. **Add declarative engine primitives** for computation the engine can't yet declare (dedup/aggregate/score/…) — via
   upstream requests to `@simodelne/pgas-server`.
3. **Fail-closed: refuse + engine request** when no primitive exists — zero brittle governable logic ever ships.
4. **Rollout: new synthesis forward + reference program** — the gate strictly governs all new/re-synthesized programs; the
   foundry's own lead-research program is retrofitted as proof; already-graduated external repos (pgas-intelligence) are
   grandfathered until their next re-render.

## 3. Enforcement approach (selected: C — Hybrid)

- **Construction half ("push into engine"):** migrate the synthesis emitters so governable logic is assembled from engine
  declarations/primitives (control flow → modes/transition-guards/enum_router; state writes → action_map mutations +
  reactions; validation → GK gates; derived views → projections; reads → inline_world_query; computation → engine
  primitives).
- **Fail-closed backstop ("strictly enforced"):** a synthesis-time **Governance Gate** — an AST classifier over every
  emitted stage body, reaction handler, resolver, and projection — that **blocks artifact write** if it finds governable
  logic expressed imperatively. This guarantees the invariant even for hand-authored code that construction can't prove
  clean.
- **Refusal path:** when governable logic has no engine declaration/primitive, the capability-registry marks it `refuses`
  with a linked engine-primitive request; synthesis stops before emitting imperative code.

Rejected: pure construction (A) can't *prove* hand-authored handlers/projection clean and is an unbounded upfront rewrite;
pure AST-lint (B) enforces but never moves logic into the engine. C does both and is the only genuinely fail-closed option.

## 4. The governed-logic taxonomy (the standard the gate encodes)

For each governable logic kind: its **engine-declared form** (allowed destination) and its **forbidden imperative shape**
(what the gate flags).

| Logic kind | Engine-declared form (allowed) | Forbidden imperative shape (gate flags) |
|---|---|---|
| Control flow / branching | modes + transition guards + `enum_router` | `if`/`switch`/ternary that decides behavior from domain/state values or presence |
| Multi-source value selection | a single declared read path / projection field | fallback chains (`domain.x ?? domain.y ?? domain.z`), field-name heuristics |
| Validation | `GK*` gates / transition preconditions | `throw`/branch on invalid domain inside a stage/handler |
| State write / reshape | `action_map` mutations (+ `from_arg`) + reactions | reshaping/normalizing/merging domain objects in TS; JSON re-parse to restructure |
| Derived view | projection declarations | ad-hoc derived-state computation with fallback reads |
| Reads | `inline_world_query` | manual deep domain-path walking |
| Computation (dedup/aggregate/score/group/sort) | an **engine primitive** (see §6) or **refuse** | `.reduce`/`.filter`/`Set`-based dedup, aggregation, scoring loops |
| Error handling | engine gates/preconditions decide reachability | `try/catch` that swallows; runtime `throw` on domain shape |

**Allowed thin glue in a stage body (the whitelist):** (1) read declared inputs at a single declared path; (2) invoke
**exactly one** governed operation — a typed host-connector call, an engine primitive, or a fenced deterministic
byte-generator; (3) write the declared `result_json`/`items_json` output shape. No domain-shape branching, no multi-path
navigation, no computation, no ad-hoc validation, no silent catch.

**Allowed *unavoidable* (explicitly fenced + declared, not flagged):** host connectors (browser/DB/PDF) behind typed
contracts; deterministic byte-generators (OOXML/HTML/DEFLATE) whose only domain contact is marshalling declared sections;
server bootstrap + REPL (outside the program's governed stages). These are enumerated in an allowlist the gate consults, so
"unavoidable" is a closed, reviewed set — not an escape hatch.

## 5. The Governance Gate (mechanism)

- **Where:** a new synthesis-time gate in the foundry, run after stage-body/handler synthesis and *before* artifact write —
  alongside the existing `scanSafety` (imports/shell/network) and `runBehavioralGate` (no-stub/shape). It plugs into the
  `branch_write` transition (`gates.ts` `canEnterBranchWrite` / `write_scaffold_artifacts`) as a hard precondition.
- **What it does:** parses each emitted stage body, reaction handler, `_resolver.ts`, and `projection.ts` (TypeScript AST,
  reusing the `ts.createSourceFile` approach `scanSafety` already uses), classifies constructs against §4, and **fails
  closed** on any forbidden governable-imperative construct. The failure names the construct, the file:line, and the
  required engine-declared destination (or the missing primitive → the linked engine request).
- **Allowlist consult:** constructs inside a fenced *unavoidable* artifact (per §4) are exempt; the allowlist is explicit
  and reviewed (no wildcard).
- **Fail-closed semantics:** a violation is a hard synthesis stop, not a warning. The foundry does not write a program that
  would ship governable-imperative logic. (This is the bootstrapping consequence: until the emitters are migrated
  (Phase 2) and primitives land (Phase 3), some current program shapes will *refuse* — that is the intended strict
  behavior, per decision #3.)

## 6. Engine-primitive registry + coordination with pgas

A foundry-side registry maps each **computation class** to its engine-primitive status. Seeded with the owner-provided
active asks:

| Computation class | Engine primitive | Status (2026-08-06) |
|---|---|---|
| Keyed dedup / idempotent upsert (persist) | **keyed/idempotent collection** | **active ask** (coordinate with pgas) |
| Completion condition / terminal predicate | **completion-predicate** | **active ask** (coordinate with pgas) |
| Aggregate / group / score | (to inventory) | request-as-discovered |
| Sort / rank | (to inventory) | request-as-discovered |

Wiring:
- The capability-registry (`src/foundry-program/capability-registry.ts`) gains, for each capability whose governable logic
  depends on a not-yet-landed primitive, a `refuses` entry linking the engine request (mirrors the `record_array`/#825
  precedent). Example: the persist/dedup capability `refuses` (linked to the keyed/idempotent-collection ask) until that
  primitive ships — the foundry emits no imperative dedup in the meantime.
- Engine requests are filed as `docs/curator-requests/*.md` + upstream issues (the established mechanism), and referenced
  from the registry.
- As a primitive lands: bump the engine pin, add the declarative emission path (construction), flip the capability to
  `synthesizes`, and the gate stays green.

## 7. Decomposition into phases

This is a multi-phase program. **This spec's implementation plan covers Phase 1 only**; later phases get their own
spec/plan cycles.

- **Phase 1 (this plan): Standard + Gate + Registry + proof-of-fail.** Encode the §4 taxonomy; build the fail-closed
  Governance Gate (§5) with the unavoidable-allowlist; seed the engine-primitive registry (§6) with the two active asks;
  wire capability-registry refusal; prove — falsifier-first — that the gate **fails closed on a representative brittle
  stage body** (e.g. a persist-shaped dedup loop) and **passes a conformant thin-glue body**, and that a no-primitive
  capability **refuses with a linked request**. Do NOT yet migrate all emitters.
- **Phase 2: Migrate emitters to declare-or-refuse.** Turn each emitter (web-navigation, persistence, export, report-data,
  reasoning, handlers, projection) conformant: express its governable logic as engine declarations, or refuse pending a
  primitive. Driven by making the now-fail-closed gate green (or intentionally red→refuse).
- **Phase 3: Engine-primitive pipeline.** Land completion-predicate + keyed/idempotent-collection (coordinate with pgas),
  inventory + request the rest; flip capabilities to `synthesizes` as each lands.
- **Phase 4: Retrofit lead-research + re-render** as the reference proof; grandfather external repos until re-render.

## 8. Scope & non-goals

- **In scope (Phase 1):** the standard, the fail-closed gate, the unavoidable-allowlist, the engine-primitive registry +
  capability-registry refusal wiring, and the falsifier proof. Applies to new/re-synthesized programs.
- **Non-goals (Phase 1):** migrating every emitter (Phase 2); landing the engine primitives (Phase 3, upstream); retrofitting
  lead-research (Phase 4); touching already-graduated external repos (grandfathered).
- The gate governs the foundry's *generated program* artifacts, not the foundry's own source.

## 9. Testing / success bar (falsifier-first)

- **Gate fails closed (the kill test):** a stage body containing a dedup/aggregate loop, a domain-shape `if`, or a
  multi-path fallback chain MUST fail synthesis with a precise, actionable message. If the offending construct is removed
  the same body passes — proving the gate discriminates, not blanket-rejects.
- **Conformant body passes:** a thin-glue body (single declared read → one governed op → declared write) passes.
- **Unavoidable allowlist honored:** a deterministic OOXML byte-generator's section-marshalling passes; a host-connector
  call passes.
- **Refusal path:** a domain whose governable computation has no primitive yields a capability `refuses` result linking the
  engine request — not an emitted imperative body.
- **No regression:** existing foundry suites + SOTA harness green; the gate does not fire on the *unavoidable* set.

## 10. Risks

- **Bootstrapping / capability contraction:** every current emitter produces some governable-imperative logic, so turning
  the gate fail-closed across all of them on day one would block all synthesis. Mitigation is **build order, not a
  weakening of strictness**: the gate is fail-closed with *expanding coverage*. Phase 1 turns it strict immediately for the
  two computation classes with active engine asks — keyed/idempotent-collection (persist/dedup) and completion-predicate —
  which therefore **refuse now** (satisfying the mandate's "avoid brittle stage/handler logic in the meantime"). Phase 2
  then migrates each remaining emitter and turns the gate strict for its constructs *as that emitter is made conformant*
  (declare-or-refuse). At no point is a covered class allowed to emit governable-imperative logic — there is **no
  temporary-allow** (the option the owner explicitly rejected); a class is either engine-declared or refused. The strict
  end-state is reached when the last emitter is migrated and the last primitive lands.
- **AST false negatives/positives:** pattern-based detection can miss cleverly-shaped brittleness or over-flag benign code.
  Mitigation: the construction half narrows what emitters produce (reducing the surface the AST must police); the
  unavoidable-allowlist is explicit; the falsifier suite is expanded whenever a gap is found.
- **Upstream dependency:** strictness is gated on engine primitives landing. Mitigation: the registry + refusal path make
  the dependency explicit and honest (refuse + request), never brittle.
