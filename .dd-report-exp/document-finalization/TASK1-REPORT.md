# Task 1 Report: Cyclic Conversational Hub Mode

Date: 2026-08-04
Branch: `feat/foundry-cyclic-conversational-hub-mode`

## Engine model: stay, back-edge, and decision-only

- Raw specs already support `topology: "CyclicTopology"`, per-mode `transitions`, and `decision_only` modes:
  `node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:1872`.
- Query/native read actions are non-mutating by contract: `query_path`/`is_query` entries must have empty mutations and
  no channel in `_shared-types.d.ts:813` and are enforced in
  `node_modules/@simodelne/pgas-server/dist-bundle/index.mjs:18465`.
- Mode advancement is action/proposed-mode driven. `proceed_to` infers a proposed mode from named actions only when the
  target is a declared transition: `index.mjs:4936`. If no proposed mode exists, eligible guards are considered:
  `index.mjs:4969`.
- Execution changes mode only when `instructionSet.proposedMode !== undefined`; otherwise the session remains in the
  current mode: `index.mjs:8774`. This is the required "stay in hub" behavior for non-terminal hub tools.
- `decision_only` modes drain without an author round and select their declared transition at `index.mjs:8555`.
- `CyclicTopology` permits cycles; only Linear/Acyclic are constrained by `checkTopology` at `index.mjs:18654`.

## Synthesis change

Before:
- The classifier had only `pure-compute | llm-reasoning | external-adapter`.
- All non-terminal stages were emitted as stage-body stages.
- Deterministic transition actions generally got `stage_output`/`result_path`, so a conversational hub was treated like a
  pipeline stage instead of a persistent mode.
- Returning from a branch could leave the branch guard truthy, so engine guard inference could immediately re-enter the
  branch after returning to the hub.

After:
- `src/foundry-program/stage-classifier.ts:1` adds `conversational-hub`, and
  `stage-classifier.ts:116` / `stage-classifier.ts:224` recognize `archetype: conversational_hub`, `kind: hub`, and
  equivalent aliases.
- `src/foundry-program/synthesizer/topology.ts:116` identifies hub transition actions.
- `topology.ts:120` and `topology.ts:173` make hub actions widget-only and omit `result_path`; `topology.ts:153` omits
  hub output projection fields.
- `src/foundry-program/synthesizer.ts:540`, `synthesizer.ts:786`, and `synthesizer.ts:9344` keep hub modes out of
  generated body stages, stage-output channels, and body-stage slug lists.
- `synthesizer.ts:847` declares hub guard-reset reactions, and `synthesizer.ts:3561` renders the handler that clears hub
  branch guards on transitions back into the hub.
- `synthesizer.ts:3258`, `synthesizer.ts:5282`, `synthesizer.ts:5385`, and `synthesizer.ts:5575` teach generated
  handlers/tools/contracts/smoke tests the hub action shape while preserving existing linear generated strings.
- There is no `src/foundry-program/synthesizer/mode-wiring.ts` in this repo state; mode wiring for the foundry lives in
  `src/foundry-program/synthesizer.ts` plus `src/foundry-program/synthesizer/topology.ts`.

## Falsifier RED to GREEN

New falsifier: `tests/integration/hub-mode-autoadvance-falsifier.test.ts`.

RED on `origin/main`:

```text
$ npx vitest run --config tests/vitest.config.ts tests/integration/hub-mode-autoadvance-falsifier.test.ts
AssertionError: expected 'amend_approval' to be 'hub' // Object.is equality

Expected: "hub"
Received: "amend_approval"

 ❯ tests/integration/hub-mode-autoadvance-falsifier.test.ts:109:51
```

GREEN after the synthesizer change:

```text
$ npx vitest run --config tests/vitest.config.ts tests/integration/hub-mode-autoadvance-falsifier.test.ts tests/unit/stage-classifier.test.ts
Test Files  2 passed (2)
Tests  6 passed (6)
```

The test synthesizes `intake -> hub -> hub`, `hub -> amend_approval`, `amend_approval -> hub`,
`hub -> finalize_export -> complete`, drives it with `createPgasServer`/`createPgasClient`, and asserts:

- `session_status` in `hub` stays in `hub`.
- `advance_hub_to_amend_approval` enters `amend_approval`.
- `complete_amend_approval` returns to `hub`.
- A second `session_status` after return stays in `hub`, proving stale branch guards no longer re-fire.
- `advance_hub_to_finalize_export` reaches `complete`.

## Verification tails

```text
$ npm run typecheck
> pgas-new@3.24.0 typecheck
> tsc --noEmit
```

```text
$ env -u NPM_TOKEN npm run test:unit
Test Files  111 passed | 4 skipped (115)
Tests  741 passed | 14 skipped (755)
Duration  150.75s
```

```text
$ env -u NPM_TOKEN npm run test:static
PASS: Vitest suite passed
[6/6] optional generated scaffold install/test
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
=== Result: 8 pass, 0 fail ===
```

Focused regression runs:

```text
$ npx vitest run --config tests/vitest.config.ts \
  tests/unit/export-stage-synthesis.test.ts \
  tests/unit/synthesizer-scale-safe-projection.test.ts \
  tests/unit/synthesizer-confirmation-loop.test.ts \
  tests/integration/generated-confirmation-loop-smoke.test.ts \
  tests/integration/confirmation-loop-terminal-advance-falsifier.test.ts \
  tests/integration/export-decision-only-autoadvance-falsifier.test.ts \
  tests/integration/delegation-slice-runtime-falsifier.test.ts
Test Files  7 passed (7)
Tests  26 passed (26)
```

```text
$ npx vitest run --config tests/vitest.config.ts \
  tests/unit/architectural-invariants.test.ts \
  tests/integration/synthesis-regression.test.ts \
  tests/integration/foundry-end-to-end.test.ts
Test Files  3 passed (3)
Tests  26 passed (26)
```

Legal-opinion no-regression render:

```text
$ node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

## Linear synthesis impact

- Existing linear suites, generated goldens, confirmation-loop, export, projection, delegation, and foundry end-to-end
  tests pass.
- No golden refresh was needed. A transient first pass changed non-hub generated contracts/smoke metadata; that was
  narrowed so non-hub linear artifacts remain stable.
- The legal-opinion domain re-synthesized and rendered cleanly, confirming the existing linear pipeline is unaffected.
