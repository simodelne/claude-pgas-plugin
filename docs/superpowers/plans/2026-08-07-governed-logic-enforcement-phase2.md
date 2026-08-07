# Governed-Logic Enforcement (Phase 2) Implementation Plan — full-family readiness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the foundry's governed-logic enforcement to *full-family readiness* while the pgas engine primitives are
still in flight — so that adopting each primitive (starting with #3 `keyed_by`) is a small, deliberate per-class flip, not
new build work.

**Architecture:** Expand the engine-primitive registry to the authoritative pgas 5-primitive family and the governance-gate
detector to the full construct taxonomy (both UNBLOCKED — no primitive needed). Wire enforcement + capability-refusal to be
per-class *activatable* from the registry, with only the already-shipped `compute_dedup` class active now. The remaining
classes stay detection-ready + refusal-ready but **inactive** until we deliberately activate them per the build order
`#3 → #1 → #2` as each primitive lands. Per-primitive adoption tasks are templates that fire on landing.

**Tech Stack:** TypeScript/Node; `typescript` AST (as Phase 1); Vitest; engine `@simodelne/pgas-server` (currently 3.27.2;
#1 shipped in 3.28.0 but not adopted — gated on #3).

## Global Constraints

- **Do NOT prematurely contract the envelope.** Only `compute_dedup` enforcement/refusal is active (Phase 1). All other
  classes are built detection-ready + refusal-ready but **inactive** until deliberately activated per build order. Turning
  on refusal for the whole family before primitives land would refuse almost every program — forbidden.
- **Build order `#3 → #1 → #2`** (pgas dependency finding): #3 `keyed_by` is the linchpin and must be adopted first; #1
  `first_item_where_field_ne` (shipped v3.28.0) is NOT usable until #3, so do not adopt it yet.
- **Registry is the single source of truth** for the family: per-class entry carries the pgas primitive name + index +
  `primitive_status` (shipped/building/asked) + pgas issue ref + `foundry_enforcement` (active/pending). Coordination doc:
  `docs/curator-requests/2026-08-07-declarative-consumer-convergence-alignment.md`.
- Engine boundary; fail-closed; no regression (full `npm test` + SOTA green); `apply_patch`; no `--no-verify`; don't touch
  `tests/sota/fixtures/body-cache/**` or `/home/simone/pgas-intelligence`. New/re-synthesized programs only.

## File Structure

- **Modify** `src/foundry-program/engine-primitive-registry.ts` — expand to the full #1–#5 family with the richer entry
  shape (`primitive_index`, `primitive_status`, `pgas_ref`, `foundry_enforcement`).
- **Modify** `src/foundry-program/governance-gate.ts` — add the missing construct kinds (`iteration_cursor`,
  `recovery_steer`; validation already via `adhoc_validation_throw`) to the taxonomy + detector; make the fatal
  enforced-construct set DERIVE from the registry's `foundry_enforcement: 'active'` entries instead of a hardcoded set.
- **Modify** `src/foundry-program/capability-registry.ts` — per-class refusal entries derived from the registry
  (`foundry_enforcement: 'active'` + `primitive_status != 'landed'` ⇒ refuse), only `compute_dedup` active now.
- **Modify** `src/foundry-program/domain-synthesis.ts` — `verifyGovernanceOfStageBody` reads the registry-derived active set
  (no hardcoded `PHASE1_ENFORCED_CONSTRUCTS`).
- **Tests:** extend `tests/unit/engine-primitive-registry.test.ts`, `tests/unit/governance-gate.test.ts`,
  `tests/unit/capability-governance-refusal.test.ts`, `tests/integration/governance-gate-synthesis-falsifier.test.ts`.

---

## Task 1: Expand the registry to the full pgas 5-primitive family (UNBLOCKED)

**Files:**
- Modify: `src/foundry-program/engine-primitive-registry.ts`
- Test: `tests/unit/engine-primitive-registry.test.ts`

**Interfaces (extend Phase-1 entry):**
```ts
export type PrimitiveStatus = 'shipped' | 'building' | 'asked';       // engine-side status
export type FoundryEnforcement = 'active' | 'pending';                // foundry-side activation (deliberate, build-order)
export interface EnginePrimitiveEntry {
  computation_class: GovernedConstructKind;
  primitive_index: 1 | 2 | 3 | 4 | 5;
  primitive_name: string;          // first_item_where_field_ne | all_items_field_eq | keyed_by | content_invariant_predicate | recovery_steer
  primitive_status: PrimitiveStatus;
  pgas_ref: string;                // pgas issue / roadmap ref
  request_ref: string;             // foundry curator-request doc path
  foundry_enforcement: FoundryEnforcement;
  build_order_note?: string;
}
export function activeEnforcedConstructs(): ReadonlySet<GovernedConstructKind>; // classes with foundry_enforcement==='active'
export function refusedConstructs(): ReadonlySet<GovernedConstructKind>;        // active && primitive_status!=='landed'... (see Task 3)
```

- [ ] **Step 1: Write the failing test** — the registry has 5 entries; `#3 keyed_by` is `compute_dedup` /
  `foundry_enforcement:'active'`; `#1 first_item_where_field_ne` is `primitive_status:'shipped'` but
  `foundry_enforcement:'pending'` with a build-order note ("gated on #3"); `activeEnforcedConstructs()` returns exactly
  `{compute_dedup}`.
```ts
it('models the full pgas 5-primitive family with only compute_dedup active', () => {
  expect(ENGINE_PRIMITIVE_REGISTRY.length).toBe(5);
  const dedup = primitiveForConstruct('compute_dedup')!;
  expect(dedup.primitive_name).toBe('keyed_by'); expect(dedup.primitive_index).toBe(3);
  expect(dedup.foundry_enforcement).toBe('active');
  const cursor = ENGINE_PRIMITIVE_REGISTRY.find(e => e.primitive_index === 1)!;
  expect(cursor.primitive_status).toBe('shipped'); expect(cursor.foundry_enforcement).toBe('pending');
  expect([...activeEnforcedConstructs()]).toEqual(['compute_dedup']);
});
```
- [ ] **Step 2: Run — FAIL.** `npx vitest run tests/unit/engine-primitive-registry.test.ts`
- [ ] **Step 3: Implement** the 5-entry registry per the coordination doc's table (#1 first_item_where_field_ne shipped/
  pending; #2 all_items_field_eq building/pending → maps to a completion construct kind; #3 keyed_by building/active →
  compute_dedup; #4 content_invariant_predicate asked/pending → adhoc_validation_throw; #5 recovery_steer asked/pending),
  each with `pgas_ref` (#829 for #1, #831 for #4/#5, the roadmap for #2/#3) + `activeEnforcedConstructs()`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: `npm run typecheck && npm test` green; commit.**
  `git commit -m "feat(governance): model the full pgas 5-primitive family in the registry (only compute_dedup active)"`

---

## Task 2: Registry-derived enforcement + full-family detection (UNBLOCKED)

Make the gate's fatal set + capability refusal DERIVE from `activeEnforcedConstructs()` (single source of truth), and add
the missing construct kinds to the detector so the classifier is complete for the whole family. Behavior is byte-identical
today (only `compute_dedup` active) — this is pure readiness.

**Files:**
- Modify: `governance-gate.ts` (add `iteration_cursor`, `recovery_steer` kinds + detectors; the fatal-policy already takes
  an `enforcedConstructs` set — no change to its signature), `domain-synthesis.ts` (`verifyGovernanceOfStageBody` uses
  `activeEnforcedConstructs()` instead of the hardcoded `PHASE1_ENFORCED_CONSTRUCTS`), `capability-registry.ts` (refusal
  detector reads the registry).
- Test: extend `governance-gate.test.ts`, `capability-governance-refusal.test.ts`,
  `governance-gate-synthesis-falsifier.test.ts`.

- [ ] **Step 1: Write failing tests** — (a) the detector flags an `iteration_cursor` (a manual join/loop over two
  collections by id) and a `recovery_steer` (a `steer*`/guidance-string emitter reading a typed flag); (b)
  `verifyGovernanceOfStageBody` still refuses ONLY `compute_dedup` today (derived from `activeEnforcedConstructs()`), and a
  synthetic registry with `completion` flipped to active would refuse a completion construct (prove derivation, e.g. via a
  test seam that injects the enforced set).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the two new detectors; change `verifyGovernanceOfStageBody` to
  `fatalGovernanceViolations(detectGovernedConstructs(src), kind, activeEnforcedConstructs())`; make the capability refusal
  detector iterate the registry's active-and-not-landed classes. Confirm today's active set is unchanged (`{compute_dedup}`)
  so no new refusals fire.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: FULL regression** — `npm run typecheck && npx vitest run tests/sota/harness.test.ts && npm test`. CRITICAL:
  confirm NO new program/benchmark now refuses (only `compute_dedup` active). Commit.
  `git commit -m "feat(governance): derive enforcement/refusal from the primitive registry + full-family detection (compute_dedup only active)"`

---

## Tasks 3+ (GATED — templates that fire when each primitive lands, in order #3 → #1 → #2 → #4/#5)

Each is a small deliberate flip; do NOT execute until the named primitive ships and its declarative API is known.

- [ ] **Task 3 — adopt #3 `keyed_by` (FIRST):** bump engine pin to the release that ships `keyed_by`; add the declarative
  keyed-collection emission path in the persistence/collection-hygiene emitter (replace the imperative dedup body with the
  engine `keyed_by` declaration); in the registry flip `#3` `primitive_status → 'landed'`; flip the persist/dedup
  capability from `refuses` to `synthesizes`; keep `foundry_enforcement:'active'` so the gate now requires the declaration
  (imperative dedup stays fatal). Falsifier: a re-rendered persist program declares `keyed_by` (no imperative dedup) and
  synthesizes; a hand-written imperative dedup body is still refused. THEN retrofit lead-research persist + re-render
  (Phase 4 proof).
- [ ] **Task 4 — adopt #1 `first_item_where_field_ne` (usable now that #3 landed):** flip `#1` `foundry_enforcement →
  'active'` + add the `derived_paths first_item_where_field_ne` emission for iteration-cursor logic; flip the cursor
  capability to `synthesizes`.
- [ ] **Task 5 — adopt #2 `all_items_field_eq`:** completion-predicate declaration emission; flip completion capability.
- [ ] **Task 6 — adopt #4 content-invariant + #5 recovery-steer** as they ship (pgas #831).

Each gated task: 5 bite-sized steps (bump/adopt-emitter/flip-registry/flip-capability/falsifier-re-render), authored when
the primitive's API is published.

## Self-Review

- **Spec/roadmap coverage:** the coordination doc's 5-primitive table → Task 1 registry; build-order `#3→#1→#2` → Tasks 3–5
  order + the `#1 pending until #3` note; "don't contract envelope" → only `compute_dedup` active (Tasks 1–2), rest
  pending. ✓
- **Placeholder scan:** Tasks 1–2 (unblocked) are fully specified with real interfaces + test code. Tasks 3+ are explicitly
  GATED templates (dependent on unpublished primitive APIs) — flagged as such, not placeholders in the executable set. ✓
- **Type consistency:** `EnginePrimitiveEntry` extension, `activeEnforcedConstructs`/`refusedConstructs`,
  `GovernedConstructKind` additions (`iteration_cursor`, `recovery_steer`) consistent across Tasks 1–2 + their tests. ✓
- **No-regression invariant:** Tasks 1–2 keep today's active set = `{compute_dedup}` → byte-identical enforcement; proven by
  the full `npm test`. ✓
