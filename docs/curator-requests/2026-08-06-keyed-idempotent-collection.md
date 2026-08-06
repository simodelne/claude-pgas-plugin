# Curator request: keyed idempotent collection engine primitive

- **Date:** 2026-08-06
- **Upstream:** `@simodelne/pgas-server` (engine monorepo `simodelne/pgas`); active ask coordinated with pgas
- **Origin:** pgas-new governed-logic enforcement Phase 1, Task 2
- **pgas-new version:** 3.27.2 · engine 3.27.2

## Why this is upstream (engine boundary)
Collection identity, idempotent writes, and duplicate suppression are engine-governed computation semantics. pgas-new is a
read-only consumer of public `@simodelne/pgas-server` exports and must not emit imperative Set/filter/reduce logic in a
generated stage body to decide which domain records are already present or unique.

## The governable computation the foundry must not emit imperatively
Generated programs need to express "keep one record per stable key and apply writes idempotently" for records such as
leads, contacts, findings, or line items. Today the tempting foundry-side implementation is brittle imperative code:
create a `Set`, test `seen.has(record.email)`, call `seen.add(record.email)`, then filter or upsert records by hand.

That is governed business/control logic. The foundry must refuse rather than synthesize that computation as stage,
handler, resolver, or projection code.

## Requested change
Add a declarative engine primitive named `keyed_idempotent_collection` that lets a program declare:

- the collection path,
- the stable identity key or key expression,
- the idempotent write/update policy,
- the output or transition evidence produced by the collection operation.

The primitive should make keyed deduplication and idempotent collection writes engine-declared instead of emitted as
imperative domain logic.

## Impact
Blocks safe synthesis of extraction and persistence programs that must deduplicate records by a domain key before writing
or reporting them. Until this primitive lands, pgas-new treats this as an **active ask** and refuses the governed
computation instead of generating brittle code.

## Notes
- This is an active ask coordinated with pgas.
- pgas-new records the request in `src/foundry-program/engine-primitive-registry.ts` as
  `compute_dedup -> keyed_idempotent_collection`.
- No interim foundry workaround should be shipped; the durable fix belongs in the engine primitive surface.
