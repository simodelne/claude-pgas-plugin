# Curator Request: Per-Item Delegation Fan-Out Primitive

Filed: 2026-08-13
Confirmed against: `@simodelne/pgas-server@5.1.0`
Tracking: pgas #922

## Request

Add an engine-owned primitive that drives per-item delegation fan-out from a declared source collection, spawns one child session per eligible item, records a keyed child/session row, collects the child result into a declared result collection, and advances the cursor/status fields without generated consumer TypeScript.

The primitive needs to cover both foundry fan-out drivers that still require generated handlers:

- `advanceSourceDelegationFanOut`: iterates configured source rows for programs such as `lead-research-agent`.
- `advanceDocumentDelegationFanOut`: iterates uploaded document rows for dynamic document review/extraction programs.

## Needed Shape

The foundry needs a declaration that can express:

- source collection path and stable item key path.
- eligibility predicate per item.
- target child program/spec/channel.
- child input mapping from the parent world plus current item fields.
- keyed session/result ledger paths.
- terminal child status predicate and optional degraded/declined handling.
- max in-flight and max total child-session bounds.
- deterministic completion predicate for the parent mode.

The declaration must own the per-item loop. A handler callback that merely receives one child result is not enough; the current drift is the generated driver deciding which item to spawn next and how to write the fan-out ledger.

## 5.1.0 Check

`@simodelne/pgas-server@5.1.0` includes managed delegation through `DelegationSessionFactory` and Service-role `ProgramEntry.serviceContract.requiredInputPaths` (`node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts`). That covers child session materialization, input enrichment, lifecycle hooks, and service-role input contracts.

It does not cover this request because it does not declare a source collection iterator, per-item spawn ledger, keyed fan-out result merge, cursor advance, or parent completion predicate. Those remain implemented by generated foundry handlers in `advanceSourceDelegationFanOut` and `advanceDocumentDelegationFanOut`.

## Current Foundry Residual

Programs with dynamic per-item delegation fan-out remain non-0-TS until #922 lands. The reference blocked program in this phase is `lead-research-agent`; dynamic document fan-out programs are in the same residual class.

Plain single-child delegation settle flags are not part of this ask as of the v5.1.0 Phase 1 migration: they now derive through `derived_paths[from_predicate]`.
