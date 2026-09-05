# Curator request → pgas engine: resolve decision-only prompt compiler-vs-registry conflict (convention loader)

**From:** pgas-new curator  **To:** pgas engine curator  **Date:** 2026-08-16  **Priority:** LOW-MED (forces a tiny consumer shim in generated servers)

**Status:** RESOLVED — filed upstream as simodelne/pgas#1055 (CLOSED completed 2026-08-24, same closing timestamp as pgas#1054, the v6.0.0 clean-slate stream); shipped in `@simodelne/pgas-server@6.0.0`. Recorded 2026-09-05.
**Resolution:** the 6.0.0 bundle's `assertDeclarativePrompts` skips `decisionOnly === true` modes, so the registry no longer requires what the compiler forbids; see the "Second-order note — RESOLVED by pgas#1055" in `2026-08-25-integration-hook-transition-scoping.md`.

## The conflict
Adopting `registerProgramByConvention`/`loadProgramByConvention` (#924, 4.12.3) to delete `registration.ts` surfaced a
compiler-vs-registry inconsistency for **decision-only modes**:
- The spec **compiler REJECTS** a `prompts` entry declared ON a decision-only mode (so the foundry cannot emit it).
- The **registry REQUIRES** a prompt entry for every mode AFTER load (so a decision-only mode with no prompt fails).

The foundry therefore cannot win: it can't emit the prompt (compiler rejects) and can't omit it (registry requires).
The only bridge is a POST-LOAD in-memory fixup in the generated server (`withDecisionOnlyRegistryPrompts` in
`server.ts.tmpl`) that clones the prompts map and inserts a constant placeholder (`'Decision-only auto-transition
mode.'`) for each decision-only mode lacking one. This is a tiny consumer-side spec fixup — exactly the kind of
consumer logic the 0-`.ts` campaign wants eliminated — but it is engine-forced, not foundry-avoidable.

## The ask
Resolve engine-side so the generated server needs NO post-load prompt fixup. Any of:
1. **Convention loader auto-fills** decision-only prompts (the loader knows the mode is decision-only + auto-transition,
   so it can supply the registry's required prompt) — preferred; removes the consumer shim entirely.
2. OR the **registry does not require** a prompt for decision-only/auto-transition modes.
3. OR the **compiler accepts** a prompt on a decision-only mode (foundry emits it in-spec, registry satisfied).

On any of these, the foundry deletes `withDecisionOnlyRegistryPrompts` and decision-only programs reach a cleaner
convention shape. Until then the shim is tracked in pgas-new `program-purity.ts` declarative-debt as engine-forced.

Context: pgas-new `docs/superpowers/specs/2026-08-13-foundry-blueprint-convergence-design.md`; adopted in PR #315.
