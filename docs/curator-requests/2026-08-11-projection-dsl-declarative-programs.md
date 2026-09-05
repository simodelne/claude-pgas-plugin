# Curator request → pgas engine: declarative projection surface (projection-DSL) + choreography reminder

**From:** pgas-new curator  **To:** pgas engine curator  **Date:** 2026-08-11  **Priority:** MEDIUM (unblocks "purely declarative programs")

**Status:** RESOLVED — SHIPPED in `@simodelne/pgas-server@4.3.0` (simodelne/pgas#884 CLOSED completed 2026-08-13; pgas PR #905 "feat(engine): declarative view: → server-tier ViewProfile replacing projectionBuilder (pgas#884)"; closing comment: "Shipped in v4.3.0 … bare tag `v4.3.0`@`dca3f54`"). Recorded 2026-09-05.
**Resolution:** the declarative `view:` block replaces per-program `projection.ts`.

## Goal
Owner mandate: foundry-generated PGAS programs must be **purely declarative — no business/control logic in per-program
`.ts` files.** The foundry now enforces a ratchet (no new logic file can be introduced; all logic-bearing emitted
`.ts` is governance-gated fail-closed). To actually DELETE the remaining per-program `.ts`, each needs an engine
surface. This request covers **projection**; the others are tracked below.

## The ask: a declarative projection / view surface
Each generated program emits a per-program `projection.ts` (+ `report-data.ts`) — **presentation/view-building
logic** (shaping domain state into the WorldView / widget payloads the LLM and UI consume). This is real logic
outside the engine and cannot currently be declared. Request a **declarative projection surface** so the view is
described in the spec, not authored in `.ts`:
- Declarative field selection/inclusion (which world paths + wildcards project into the view), shaping/labeling,
  and derived/computed view fields via existing engine primitives (derived_paths, sum_of, keyed_collections) —
  NOT arbitrary imperative code.
- If a general projection-DSL is too broad, a scoped first cut that covers the common cases (select paths,
  rename/label, order, include-if-present, simple derived scalars) would let the foundry delete the majority of
  `projection.ts`; anything genuinely irreducible stays a small typed host hook, not free-form logic.

Concretely: a `projection:` (or `view:`) declaration block per mode/channel that names the world paths + shaping
rules, evaluated by the engine to build the WorldView — replacing the consumer-side `projection.ts` builder.

## Why now
The projection `.ts` is currently on the foundry's declarative-debt ledger as "allowed short-term, no primitive."
It is the LAST legitimately-per-program `.ts` in the north-star ("specs.yml + registration + projection only" →
then specs-only). A declarative projection surface removes it.

## Related asks (tracking — so the full "specs.yml-only" path is visible)
1. **Choreography (K/L/M) — ALREADY FILED** (pgas #844 comment ~5226011889): declarative fan-out dispatch /
   channel-event decision-write / cross-collection status-summary-mirror. This is the BIGGEST per-program logic
   file (`handlers.ts`, ~1,070 LOC in lead-research) and the `pure:strict` blocker. Highest-value delete.
2. **Declarative stages** (future): let a stage's deterministic transform be declared/engine-run rather than
   emitted as `stages/*.ts`. Larger ask; lower priority than choreography.
3. **Shared `$ref` tools/connectors**: let a spec reference generic shared tools (`tools: [$ref(web_search)]`)
   instead of per-program `tools.ts`/`connectors/*.ts`. Moves I/O adapters out of the program dir (they stay code,
   but shared-once, not per-program).

## Foundry-side status (no engine dependency)
Enforcement ratchet shipping now (foundry PR, this session): structural per-program `.ts` allowlist gate (rogue
logic files refused at synthesis) + governance content-scan extended to every logic-bearing emitted `.ts` +
declarative-debt registry tagging each remaining `.ts` bucket to its engine ask. As each engine surface above
lands, the foundry adopts it and the allowlist ratchets down. Please advise feasibility/shape of the projection
surface (or point me at an existing one I've missed).
