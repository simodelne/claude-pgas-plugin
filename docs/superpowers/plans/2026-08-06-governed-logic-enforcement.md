# Governed-Logic Enforcement (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pgas-new foundry a fail-closed synthesis-time **Governance Gate** that refuses to emit governable
business/control logic as imperative code in generated programs, plus the engine-primitive registry + capability-refusal
wiring that turns "no engine primitive yet" into an honest refusal instead of brittle code.

**Architecture:** A pure AST classifier (`governance-gate.ts`) detects the governed-logic constructs from the spec's §4
taxonomy in emitted stage bodies/handlers/projection; a policy layer marks a subset fatal (Phase 1: the computation classes
with active engine asks) while exempting an explicit unavoidable-artifact allowlist. An engine-primitive registry maps each
computation class to its upstream primitive request; the capability-registry refuses any capability whose governable
computation depends on a not-yet-landed primitive (seeded with `keyed/idempotent-collection` and `completion-predicate`).
The gate is wired into the stage-body verification path as a hard precondition of artifact write.

**Tech Stack:** TypeScript/Node; `typescript` compiler API (`ts.createSourceFile`, already used by `scanSafety`); Vitest;
engine `@simodelne/pgas-server@3.27.2` (read-only, public exports).

## Global Constraints

- **Fail-closed, never temporary-allow:** for an enforced construct class, the foundry either engine-declares it or
  **refuses** it (+ links the engine request). It never emits imperative governable logic for an enforced class.
- **Phase-1 enforced construct set = the active-ask computation classes** (`compute_dedup`, completion-predicate branching);
  detection covers the full taxonomy but only these are *fatal* in Phase 1. Phase 2 expands the fatal set per migrated
  emitter. This is build-order, not a weakening (spec §10).
- **Unavoidable allowlist is closed + explicit:** host connectors (behind typed contracts), deterministic byte-generators
  (OOXML/HTML/DEFLATE), server bootstrap, REPL, tests — exempt. No wildcard escape hatch.
- **Engine boundary:** import only public `@simodelne/pgas-server` exports; missing surfaces → curator/upstream request.
- **No regression:** existing foundry suites + `tests/sota/harness.test.ts` stay green; the gate must NOT fire on the
  unavoidable set or on already-conformant emitters. Run the FULL `npm test` before declaring any task done.
- Scope: the gate governs *generated program* artifacts, not the foundry's own source. New/re-synthesized programs only.
- `apply_patch` for edits; no `--no-verify`; no classifier bypass; do not touch `tests/sota/fixtures/body-cache/**` or
  `/home/simone/pgas-intelligence`.

## File Structure

- **Create** `src/foundry-program/governance-gate.ts` — the taxonomy constants, the pure AST detector
  (`detectGovernedConstructs`), the unavoidable allowlist, and the fatal-policy filter (`fatalGovernanceViolations`) +
  `GovernanceRefusalError`.
- **Create** `src/foundry-program/engine-primitive-registry.ts` — computation-class → engine-primitive-request registry
  (`primitiveForConstruct`), seeded with the two active asks.
- **Create** `docs/curator-requests/2026-08-06-keyed-idempotent-collection.md` and
  `docs/curator-requests/2026-08-06-completion-predicate.md` — foundry-side records linking pgas's active asks.
- **Modify** `src/foundry-program/capability-registry.ts` — refuse capabilities whose governable computation maps to an
  `active_ask` primitive; wire into `detectRequestedCapabilities`.
- **Modify** `src/foundry-program/domain-synthesis.ts` — call the governance gate in the stage-body verification path
  (mirror where `scanSafety`/`verifyStageBody` runs, ~`:452`/`:876`), fail-closed.
- **Tests:** `tests/unit/governance-gate.test.ts`, `tests/unit/engine-primitive-registry.test.ts`,
  `tests/unit/capability-governance-refusal.test.ts`, `tests/integration/governance-gate-synthesis-falsifier.test.ts`.

---

## Task 1: Governed-logic AST classifier (`governance-gate.ts`)

The keystone detection unit — a pure library, no I/O, unit-tested against snippets. Mirrors `scanSafety`'s
`ts.createSourceFile` AST-walk approach (read it first: `src/foundry-program/domain-synthesis.ts:~876-946`).

**Files:**
- Create: `src/foundry-program/governance-gate.ts`
- Test: `tests/unit/governance-gate.test.ts`

**Interfaces:**
- Produces:
```ts
export type GovernedConstructKind =
  | 'domain_shape_branch'    // if/switch/ternary deciding behavior from domain values/presence
  | 'multi_path_fallback'    // a ?? b ?? c chains / field-name heuristics over domain
  | 'compute_dedup'          // Set-based or reduce/filter dedup over records
  | 'compute_aggregate'      // reduce/sum/group over collections
  | 'compute_score'          // per-item scoring/ranking loops
  | 'compute_sort'           // .sort() with a domain comparator
  | 'adhoc_validation_throw' // throw on invalid domain shape inside a stage/handler
  | 'silent_catch'           // try/catch that swallows (empty/return-only catch)
  | 'json_reshape';          // JSON.parse of a domain value to restructure it
export interface GovernanceFinding {
  kind: GovernedConstructKind;
  line: number;              // 1-based
  column: number;            // 1-based
  snippet: string;           // the offending source text (trimmed, <=120 chars)
}
export type GovernedArtifactKind =
  | 'stage_body' | 'reaction_handler' | 'resolver' | 'projection'
  | 'byte_generator' | 'connector' | 'server' | 'repl' | 'test';
export const UNAVOIDABLE_ARTIFACT_KINDS: ReadonlySet<GovernedArtifactKind>;   // byte_generator, connector, server, repl, test
export function detectGovernedConstructs(sourceText: string): GovernanceFinding[];
export interface GovernanceViolation extends GovernanceFinding { message: string; }
export function fatalGovernanceViolations(
  findings: readonly GovernanceFinding[],
  artifactKind: GovernedArtifactKind,
  enforcedConstructs: ReadonlySet<GovernedConstructKind>,
): GovernanceViolation[];   // [] if artifactKind is unavoidable; else findings whose kind ∈ enforcedConstructs, each with an actionable message
export class GovernanceRefusalError extends Error {
  readonly kind = 'governance_refusal';
  readonly violations: readonly GovernanceViolation[];
  constructor(artifact: string, violations: readonly GovernanceViolation[]);
}
```

- [ ] **Step 1: Write the failing detector test**

```ts
// tests/unit/governance-gate.test.ts
import { describe, it, expect } from 'vitest';
import { detectGovernedConstructs, fatalGovernanceViolations, UNAVOIDABLE_ARTIFACT_KINDS } from '../../src/foundry-program/governance-gate.js';

const DEDUP_BODY = `
export async function runStage(input, runtime) {
  const seen = new Set();
  const records = input.domain['persist.records'] ?? input.domain['aggregate.leads'] ?? [];
  const deduped = records.filter((r) => { if (seen.has(r.email)) return false; seen.add(r.email); return true; });
  return { result_json: JSON.stringify({ deduped }), items_json: '[]', digest: '' };
}`;
const THIN_GLUE_BODY = `
export async function runStage(input, runtime) {
  const report = assembleStructuredReport(input.domain);
  const bytes = await runtime.connectors.pdf_report.render_report(report);
  return { result_json: JSON.stringify({ pdf_bytes: bytes.length }), items_json: '[]', digest: '' };
}`;

describe('detectGovernedConstructs', () => {
  it('flags a Set-based dedup and a multi-path fallback', () => {
    const f = detectGovernedConstructs(DEDUP_BODY);
    const kinds = f.map((x) => x.kind);
    expect(kinds).toContain('compute_dedup');
    expect(kinds).toContain('multi_path_fallback');
  });
  it('finds nothing governable in a thin-glue pass-through body', () => {
    expect(detectGovernedConstructs(THIN_GLUE_BODY)).toEqual([]);
  });
});

describe('fatalGovernanceViolations', () => {
  it('is fatal for an enforced compute_dedup in a stage body, with an actionable message', () => {
    const findings = detectGovernedConstructs(DEDUP_BODY);
    const fatal = fatalGovernanceViolations(findings, 'stage_body', new Set(['compute_dedup']));
    expect(fatal.length).toBeGreaterThan(0);
    expect(fatal[0].message).toMatch(/dedup|keyed.?idempotent|engine primitive/i);
  });
  it('exempts the unavoidable set (byte_generator not policed even with a dedup)', () => {
    const findings = detectGovernedConstructs(DEDUP_BODY);
    expect(fatalGovernanceViolations(findings, 'byte_generator', new Set(['compute_dedup']))).toEqual([]);
    expect(UNAVOIDABLE_ARTIFACT_KINDS.has('byte_generator')).toBe(true);
  });
  it('does not make a detected-but-unenforced kind fatal (Phase-1 scoping)', () => {
    const findings = detectGovernedConstructs(DEDUP_BODY); // also has multi_path_fallback
    const fatal = fatalGovernanceViolations(findings, 'stage_body', new Set(['compute_dedup']));
    expect(fatal.every((v) => v.kind === 'compute_dedup')).toBe(true); // multi_path_fallback detected but not enforced yet
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `npx vitest run tests/unit/governance-gate.test.ts` → FAIL.

- [ ] **Step 3: Implement `governance-gate.ts`**

Read `scanSafety` (`domain-synthesis.ts:~876`) for the `ts.createSourceFile` + `forEachChild` walk pattern and reuse it.
Implement `detectGovernedConstructs` to walk the AST and emit a `GovernanceFinding` for:
- `compute_dedup`: a `new Set(...)` used as a membership filter, OR a `.filter(...)`/`.reduce(...)` whose callback
  references a `Set.has`/`Set.add` or builds a uniqueness map keyed by a field.
- `compute_aggregate`/`compute_score`/`compute_sort`: `.reduce(...)` accumulating a number/object, `.map(...)` computing a
  score field, `.sort(compareFn)` with a body comparator.
- `multi_path_fallback`: a `??`/`||` chain of length ≥2 whose operands are member-access expressions on `input.domain`/
  `domain` (a fallback over domain paths).
- `domain_shape_branch`: an `if`/`switch`/conditional whose test reads `input.domain`/`domain` member access or `in`/
  `typeof`/`=== undefined` presence checks on domain values.
- `adhoc_validation_throw`: a `throw` statement whose reachability depends on a domain value test.
- `silent_catch`: a `catch` clause with an empty body or a body that only `return`s a default (swallows).
- `json_reshape`: `JSON.parse(...)` applied to a `domain`/`input.domain` member access.
`UNAVOIDABLE_ARTIFACT_KINDS = new Set(['byte_generator','connector','server','repl','test'])`.
`fatalGovernanceViolations`: return `[]` if `UNAVOIDABLE_ARTIFACT_KINDS.has(artifactKind)`; else map findings whose `kind ∈
enforcedConstructs` to `GovernanceViolation` with `message` naming the construct + its engine-declared destination (from
the §4 table) or, for a computation kind, the required engine primitive (look it up via the registry in Task 2 — for Task 1
use a static message string; Task 2 wires the registry reference). Keep detection conservative (favor precision over
recall) to avoid false positives on thin glue — the falsifier suite grows when a real gap is found.

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run tests/unit/governance-gate.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/foundry-program/governance-gate.ts tests/unit/governance-gate.test.ts
git commit -m "feat(governance): AST classifier for governed-logic constructs (detect + fatal-policy + unavoidable allowlist)"
```

---

## Task 2: Engine-primitive registry (`engine-primitive-registry.ts`) + curator-request records

Maps each computation class to its engine-primitive request status. Seeded with the two active asks so the foundry knows
which computations must refuse-pending-primitive.

**Files:**
- Create: `src/foundry-program/engine-primitive-registry.ts`
- Create: `docs/curator-requests/2026-08-06-keyed-idempotent-collection.md`
- Create: `docs/curator-requests/2026-08-06-completion-predicate.md`
- Test: `tests/unit/engine-primitive-registry.test.ts`

**Interfaces:**
- Consumes: `GovernedConstructKind` (Task 1).
- Produces:
```ts
import type { GovernedConstructKind } from './governance-gate.js';
export type PrimitiveStatus = 'active_ask' | 'landed' | 'unavailable';
export interface EnginePrimitiveEntry {
  computation_class: GovernedConstructKind;
  primitive_name: string;          // 'keyed_idempotent_collection'
  status: PrimitiveStatus;
  request_ref: string;             // curator-request doc path
  since_engine_version?: string;   // set when status: 'landed'
}
export const ENGINE_PRIMITIVE_REGISTRY: readonly EnginePrimitiveEntry[];
export function primitiveForConstruct(kind: GovernedConstructKind): EnginePrimitiveEntry | undefined;
```

- [ ] **Step 1: Write the failing registry test**

```ts
// tests/unit/engine-primitive-registry.test.ts
import { describe, it, expect } from 'vitest';
import { primitiveForConstruct, ENGINE_PRIMITIVE_REGISTRY } from '../../src/foundry-program/engine-primitive-registry.js';

describe('engine-primitive-registry', () => {
  it('maps compute_dedup to the keyed/idempotent-collection active ask', () => {
    const e = primitiveForConstruct('compute_dedup');
    expect(e).toBeDefined();
    expect(e!.primitive_name).toBe('keyed_idempotent_collection');
    expect(e!.status).toBe('active_ask');
    expect(e!.request_ref).toContain('keyed-idempotent-collection');
  });
  it('every entry references an existing curator-request doc path', () => {
    for (const e of ENGINE_PRIMITIVE_REGISTRY) expect(e.request_ref).toMatch(/^docs\/curator-requests\/.+\.md$/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run tests/unit/engine-primitive-registry.test.ts` → FAIL.

- [ ] **Step 3: Write the two curator-request docs + implement the registry**

Write `docs/curator-requests/2026-08-06-keyed-idempotent-collection.md` and
`docs/curator-requests/2026-08-06-completion-predicate.md` in the established curator-request format (mirror
`docs/curator-requests/2026-08-06-nested-array-of-object-tool-schema.md`): each states the governable computation the
foundry must not emit imperatively, the requested declarative engine primitive, and that these are **active asks**
coordinated with pgas. Then implement the registry:
```ts
export const ENGINE_PRIMITIVE_REGISTRY = [
  { computation_class: 'compute_dedup', primitive_name: 'keyed_idempotent_collection', status: 'active_ask',
    request_ref: 'docs/curator-requests/2026-08-06-keyed-idempotent-collection.md' },
  // completion-predicate maps to the completion/terminal branching class:
  { computation_class: 'domain_shape_branch', primitive_name: 'completion_predicate', status: 'active_ask',
    request_ref: 'docs/curator-requests/2026-08-06-completion-predicate.md' },
] as const;
```
`primitiveForConstruct` returns the first entry matching `kind`. (Note: `domain_shape_branch` is broad; the completion
mapping is the terminal-predicate subset — document that Phase 2 will refine the class granularity. For Phase 1 the entry
existing is enough to drive refusal.)

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run tests/unit/engine-primitive-registry.test.ts` → PASS.

- [ ] **Step 5: Wire the message in governance-gate to cite the primitive + commit**

In `governance-gate.ts` `fatalGovernanceViolations`, when a violation kind has a registry entry, append the primitive +
request_ref to the `message` (e.g. `"...move to engine primitive 'keyed_idempotent_collection' (see
docs/curator-requests/2026-08-06-keyed-idempotent-collection.md)"`). Import `primitiveForConstruct`. Keep Task-1 tests
green (adjust the regex expectation only if needed — it already matches `/keyed.?idempotent/`).

Run: `npm run typecheck && npx vitest run tests/unit/governance-gate.test.ts tests/unit/engine-primitive-registry.test.ts`
```bash
git add src/foundry-program/engine-primitive-registry.ts src/foundry-program/governance-gate.ts docs/curator-requests/2026-08-06-*.md tests/unit/engine-primitive-registry.test.ts
git commit -m "feat(governance): engine-primitive registry seeded with active asks (keyed/idempotent-collection, completion-predicate)"
```

---

## Task 3: Capability-registry refusal for not-yet-landed primitives

Make the foundry refuse — before emitting any stage body — a capability whose governable computation depends on an
`active_ask` primitive. This realizes "avoid brittle stage/handler logic in the meantime" at the capability-assessment
layer.

**Files:**
- Modify: `src/foundry-program/capability-registry.ts`
- Test: `tests/unit/capability-governance-refusal.test.ts`

**Interfaces:**
- Consumes: `ENGINE_PRIMITIVE_REGISTRY`/`primitiveForConstruct` (Task 2); the existing `detectRequestedCapabilities`,
  `assertSynthesizableCapabilities`, `CapabilityDemand`, `FOUNDRY_CAPABILITY_REGISTRY` (read `capability-registry.ts`).
- Produces: a `refuses` capability `governed_compute_pending_primitive` (or per-class capabilities) demanded when intake
  signals a not-yet-declarable computation (e.g. dedup/persist), with evidence linking the engine request.

- [ ] **Step 1: Write the failing refusal test**

```ts
// tests/unit/capability-governance-refusal.test.ts
import { describe, it, expect } from 'vitest';
import { assertSynthesizableCapabilities, detectRequestedCapabilities } from '../../src/foundry-program/capability-registry.js';

describe('governance refusal for not-yet-landed primitives', () => {
  it('refuses a domain requiring keyed dedup/persist (pending keyed/idempotent-collection)', () => {
    const input = { purpose: 'Deduplicate and upsert extracted leads across sessions by email into the store.',
      extraText: 'dedupe by email; idempotent upsert; keyed collection' };
    expect(() => assertSynthesizableCapabilities(input)).toThrow();
    const demands = detectRequestedCapabilities(input).map((d) => d.capability);
    expect(demands).toContain('governed_compute_pending_primitive');
  });
  it('does not refuse a domain with no not-yet-declarable computation', () => {
    const input = { purpose: 'Summarize an uploaded memo and export it as a DOCX.', extraText: 'summarize; docx export' };
    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run tests/unit/capability-governance-refusal.test.ts` → FAIL.

- [ ] **Step 3: Implement the refusal wiring**

In `capability-registry.ts`: add a `refuses` entry
```ts
{ capability: 'governed_compute_pending_primitive', status: 'refuses', since_version: '3.28.0',
  evidence: capabilityEvidence(['governable computation (e.g. keyed dedup/idempotent upsert) has no engine primitive yet',
    'foundry refuses rather than emit brittle imperative logic; see engine-primitive-registry active asks']),
  gap_note: 'blocked on keyed/idempotent-collection + completion-predicate engine primitives (active asks)' }
```
Add a detector (mirror `detectDelegationCapabilities`, `capability-registry.ts:~334`) that returns a
`governed_compute_pending_primitive` demand when intake text/stages signal a not-yet-declarable computation — key it off
the SAME signals that would otherwise force imperative dedup/aggregate/idempotent-upsert (e.g. `/\b(dedup|de-duplicate|
idempotent|upsert|keyed collection)\b/i`, and stage `produces` shapes implying a keyed collection). NARROW it so it does
not fire on benign text. Wire into `detectRequestedCapabilities`. Because the entry is `refuses`,
`assertSynthesizableCapabilities` throws (its existing behavior for `refuses`).

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run tests/unit/capability-governance-refusal.test.ts` → PASS.

- [ ] **Step 5: Full-suite regression + commit**

Run: `npm run typecheck && npx vitest run tests/sota/harness.test.ts && npm test`
Expected: green — confirm the new detector does NOT flip any existing SOTA/benchmark domain to refuse (narrow it if it
does).
```bash
git add src/foundry-program/capability-registry.ts tests/unit/capability-governance-refusal.test.ts
git commit -m "feat(governance): refuse capabilities whose governable computation has no engine primitive yet"
```

---

## Task 4: Wire the fail-closed gate into synthesis (the enforcement keystone)

Run the governance gate on emitted stage bodies/handlers/projection in the verification path and block artifact write on a
fatal violation. Phase-1 enforced set = the active-ask computation classes.

**Files:**
- Modify: `src/foundry-program/domain-synthesis.ts` (the stage-body verification path where `scanSafety` runs, ~`:452`/
  `:876`; and where handlers/projection are verified if separate)
- Test: `tests/integration/governance-gate-synthesis-falsifier.test.ts`

**Interfaces:**
- Consumes: `detectGovernedConstructs`, `fatalGovernanceViolations`, `GovernanceRefusalError`, `UNAVOIDABLE_ARTIFACT_KINDS`
  (Task 1); `synthesizeDomainLogic`/`synthesizeProgramSpecFromDomain` (existing).
- Produces: a fail-closed governance check such that synthesizing a program whose emitted stage body contains an enforced
  computation construct throws `GovernanceRefusalError` before artifacts are written.

- [ ] **Step 1: Write the failing end-to-end falsifier**

```ts
// tests/integration/governance-gate-synthesis-falsifier.test.ts
import { describe, it, expect } from 'vitest';
import { verifyGovernanceOfStageBody } from '../../src/foundry-program/domain-synthesis.js';
import { GovernanceRefusalError } from '../../src/foundry-program/governance-gate.js';

const BRITTLE = `export async function runStage(input, runtime){ const s=new Set(); const recs=input.domain['persist.records']??[]; const d=recs.filter(r=>{if(s.has(r.email))return false;s.add(r.email);return true;}); return {result_json:JSON.stringify({d}),items_json:'[]',digest:''}; }`;
const CONFORMANT = `export async function runStage(input, runtime){ const rep=assembleStructuredReport(input.domain); const b=await runtime.connectors.pdf_report.render_report(rep); return {result_json:JSON.stringify({n:b.length}),items_json:'[]',digest:''}; }`;

describe('governance gate in synthesis (fail-closed)', () => {
  it('KILL TEST: a stage body with an enforced dedup construct is refused before write', () => {
    expect(() => verifyGovernanceOfStageBody(BRITTLE, 'stage_body')).toThrow(GovernanceRefusalError);
    try { verifyGovernanceOfStageBody(BRITTLE, 'stage_body'); } catch (e) {
      expect((e as GovernanceRefusalError).violations[0].message).toMatch(/keyed_idempotent_collection|dedup/i);
    }
  });
  it('a conformant thin-glue body passes', () => {
    expect(() => verifyGovernanceOfStageBody(CONFORMANT, 'stage_body')).not.toThrow();
  });
  it('an unavoidable byte-generator with the same construct is NOT refused', () => {
    expect(() => verifyGovernanceOfStageBody(BRITTLE, 'byte_generator')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`verifyGovernanceOfStageBody` not exported)

Run: `npx vitest run tests/integration/governance-gate-synthesis-falsifier.test.ts` → FAIL.

- [ ] **Step 3: Implement + wire the governance check**

In `domain-synthesis.ts`, add and export:
```ts
import { detectGovernedConstructs, fatalGovernanceViolations, GovernanceRefusalError, type GovernedArtifactKind } from './governance-gate.js';
const PHASE1_ENFORCED_CONSTRUCTS = new Set(['compute_dedup'] as const); // active-ask computation classes; Phase 2 expands
export function verifyGovernanceOfStageBody(sourceText: string, artifactKind: GovernedArtifactKind): void {
  const violations = fatalGovernanceViolations(detectGovernedConstructs(sourceText), artifactKind, PHASE1_ENFORCED_CONSTRUCTS);
  if (violations.length > 0) throw new GovernanceRefusalError(artifactKind, violations);
}
```
Call `verifyGovernanceOfStageBody(body, 'stage_body')` inside the existing stage-body verification path (right after
`scanSafety`/before caching the body — read `verifyStageBody` ~`:452`). Apply it to emitted reaction handlers/resolver/
projection with their artifact kind too. The throw propagates up and blocks `write_scaffold_artifacts` (fail-closed).
Because Task 3 refuses dedup-requiring programs at capability assessment, real synthesis never reaches an emitted dedup
body — so this gate does not break current synthesis; it is the enforcement backstop proven by the falsifier.

- [ ] **Step 4: Run the falsifier — expect PASS**

Run: `npx vitest run tests/integration/governance-gate-synthesis-falsifier.test.ts` → PASS.

- [ ] **Step 5: FULL regression (must not break current synthesis)**

Run: `npm run typecheck && npx vitest run tests/sota/harness.test.ts && npm test`
Expected: `=== Result: N pass, 0 fail ===`. Critically, confirm no existing generated-program synthesis or SOTA benchmark
now refuses/throws (the enforced set is scoped to `compute_dedup`, which current conformant emitters don't emit and
dedup-requiring domains refuse upstream). If any existing suite breaks, STOP and report — do not widen or weaken to force
green.

- [ ] **Step 6: Commit**

```bash
git add src/foundry-program/domain-synthesis.ts tests/integration/governance-gate-synthesis-falsifier.test.ts
git commit -m "feat(governance): fail-closed synthesis gate refuses enforced governable-imperative constructs before write"
```

---

## Self-Review

**1. Spec coverage** (spec §§ → tasks):
- §4 taxonomy → Task 1 (`GovernedConstructKind` + detector) ✓
- §5 gate mechanism (AST, unavoidable allowlist, fail-closed at write) → Task 1 (detector+policy) + Task 4 (pipeline
  integration + block-before-write) ✓
- §6 engine-primitive registry + coordination (2 active asks) → Task 2 ✓
- §6 capability-registry refusal wiring → Task 3 ✓
- §7 Phase-1 deliverable (standard+gate+registry+proof-of-fail) → all four tasks; the "proof the gate fails closed" is
  Task 4's kill test ✓
- §9 success bar: gate fails closed (Task 4 kill test), conformant passes (Task 4), unavoidable honored (Task 1 + Task 4),
  refusal path (Task 3), no regression (Task 3/4 full `npm test`) ✓
- §10 build-order (Phase-1 enforced set = active-ask classes; refuse upstream so synthesis isn't broken) → Task 3 refusal +
  Task 4 `PHASE1_ENFORCED_CONSTRUCTS = {compute_dedup}` ✓
- Out of scope (correctly deferred): emitter migration (Phase 2), landing primitives (Phase 3), lead-research retrofit
  (Phase 4). ✓

**2. Placeholder scan:** No TBD/TODO. Where the implementer must read a precedent, the exact function + file:line is named
(`scanSafety` ~:876, `verifyStageBody` ~:452, `detectDelegationCapabilities` ~:334). Real interfaces + real test code given
for every task.

**3. Type consistency:** `GovernedConstructKind`, `GovernanceFinding`, `GovernanceViolation`, `GovernedArtifactKind`,
`UNAVOIDABLE_ARTIFACT_KINDS`, `detectGovernedConstructs`, `fatalGovernanceViolations`, `GovernanceRefusalError`
(Task 1) are reused verbatim by Tasks 2 & 4. `EnginePrimitiveEntry`/`primitiveForConstruct`/`ENGINE_PRIMITIVE_REGISTRY`
(Task 2) reused by Task 1 (message wiring) & Task 3. `governed_compute_pending_primitive` capability name consistent between
Task 3 code + test. `PHASE1_ENFORCED_CONSTRUCTS = {compute_dedup}` consistent between Task 4 impl + falsifier. ✓

**Note for the implementer:** where a task says "mirror function X at path:line", read that function first — the
`domain-synthesis.ts` line anchors are approximate (10k+ LOC file). The falsifiers are the arbiter; keep detection
conservative (precision over recall) so the gate never fires on genuinely thin glue or the unavoidable set.
