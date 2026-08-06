# Curator request: completion predicate engine primitive

- **Date:** 2026-08-06
- **Upstream:** `@simodelne/pgas-server` (engine monorepo `simodelne/pgas`); active ask coordinated with pgas
- **Origin:** pgas-new governed-logic enforcement Phase 1, Task 2
- **pgas-new version:** 3.27.2 · engine 3.27.2

## Why this is upstream (engine boundary)
Terminal readiness and completion decisions are engine-governed control-flow semantics. pgas-new is a read-only consumer
of public `@simodelne/pgas-server` exports and must not emit imperative `if`/`switch`/ternary logic in generated code to
decide whether a domain shape is complete enough to terminate or route.

## The governable computation the foundry must not emit imperatively
Generated programs need to express terminal predicates such as "all required records have been collected", "the reviewed
artifact is approved", or "every requested item has complete evidence". Today the tempting foundry-side implementation is
domain-shape branching inside a stage body, reaction handler, resolver, or projection.

That terminal-predicate subset of `domain_shape_branch` is governed control logic. The foundry must refuse rather than
synthesize that completion decision imperatively.

## Requested change
Add a declarative engine primitive named `completion_predicate` that lets a program declare:

- the domain facts that determine completion,
- the predicate semantics for terminal readiness,
- the transition or terminal mode driven by the predicate,
- the evidence surfaced when the predicate is not yet satisfied.

The primitive should make completion and terminal-routing decisions engine-declared instead of emitted as imperative domain
branching.

## Impact
Blocks safe synthesis of programs whose terminal readiness cannot be represented by current declarative modes,
preconditions, and transition guards without dropping into generated code. Until this primitive lands, pgas-new treats this
as an **active ask** and refuses the governed computation instead of generating brittle code.

## Notes
- This is an active ask coordinated with pgas.
- pgas-new records the request in `src/foundry-program/engine-primitive-registry.ts` as the terminal-predicate subset of
  `domain_shape_branch -> completion_predicate`.
- Phase 2 should refine class granularity so the broad `domain_shape_branch` detector can distinguish terminal predicates
  from other branch classes.
