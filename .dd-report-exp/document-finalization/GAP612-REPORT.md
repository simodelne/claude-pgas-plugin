# GAP-DF-6.12 + 6.11 Report

Date: 2026-08-05

## GAP-DF-6.12 Fix

- `src/foundry-program/handlers.ts:2251` renders the generated live-drive delegation script from manifest child metadata.
- `src/foundry-program/handlers.ts:2265` now resolves `childProgram` as `target_slug -> registered_name -> synthesize_child.slug -> target_spec -> id`.
- This fixes the reused child import from the display path `programs/SimoneOS Document Ingest/registration.js` to the slug-safe path `programs/document-ingest/registration.js`.
- Falsifiers:
  - `tests/unit/foundry-real-handlers.test.ts:422` proves the handler passes `childProgram: "document-ingest"` instead of the display `target_spec`.
  - `tests/unit/generated-live-drive-env.test.ts:141` renders an existing-repo runner and resolves the child import to `programs/document-ingest/registration.js`; the runner source does not contain `SimoneOS Document Ingest`.

## Shadow Runnability Verdict

VERDICT: reused-delegation live-drive cannot complete in the current shadow. It is env-bound to real simoneos / Task 7.

Evidence:

- Shadow wiring advertises reusable programs in `.dd-report-exp/document-finalization/runs/20260805-063426678/simoneos-shadow/.pgas/wiring.yml:27`: `research`, `document-ingest`, and `review-service`.
- The shadow `programs/` tree contains only `programs/document-finalization`; there is no `programs/document-ingest`, `programs/research`, or `programs/review-service`.
- Read-only real-simoneos probe found `/home/simone/simoneos/programs/document-ingest` and `/home/simone/simoneos/programs/research`; the exact manifest slug `review-service` was not present, while `/home/simone/simoneos/programs/review` exists.
- After the 6.12 fix, the old shadow live-drive fails on the slug-safe child path, with `runner_exit_code: 1`, `rounds: 0`, `provider_hits: 0`, and `ERR_MODULE_NOT_FOUND` for:

```text
.dd-report-exp/document-finalization/runs/20260805-063426678/simoneos-shadow/programs/document-ingest/registration.js
```

This proves the synthesis/import bug is fixed, but the live verification remains blocked because the reused child program code is not seeded into the shadow.

## GAP-DF-6.11a Fix

- `src/foundry-program/handlers.ts:69` defines the generated smoke command:

```text
npx --no-install vitest run tests/generated-program-smoke.test.ts tests/*-deterministic.test.ts --pool=threads --maxWorkers=1
```

- `src/foundry-program/handlers.ts:1365` now runs those generated Vitest smoke/deterministic files directly for `run_smoke_verification`.
- `src/foundry-program/handlers.ts:1370` catches a nonzero generated smoke and records `kind: "smoke_verification", status: "failed"` instead of letting the existing repo's unrelated `npm test` mask the generated failure.
- `src/pgas-new/command-runner.ts:67` applies the same direct generated smoke command to the command-runner route.
- Falsifiers:
  - `tests/unit/foundry-real-handlers.test.ts:353` proves a failing generated smoke records failed and includes the real assertion tail.
  - `tests/unit/command-runner.test.ts:91` proves `runGeneratedSmokeTest` dispatches direct `npx --no-install vitest ...` args.

Old-shadow probe after the fix:

```text
kind: smoke_verification
command: npx --no-install vitest run tests/generated-program-smoke.test.ts tests/*-deterministic.test.ts --pool=threads --maxWorkers=1
status: failed
reason tail: tests/generated-program-smoke.test.ts (1 test | 1 failed)
```

## GAP-DF-6.11b Diagnosis

Diagnosis: not a transition-guard bug, and not directly the display-name import failure. The old generated smoke uploaded a document and set `work.document_ready = true`, but then tried to advance without settling the same-stage `document_ingest` delegation.

Spec evidence:

- `.dd-report-exp/document-finalization/runs/20260805-063426678/simoneos-shadow/programs/document-finalization/specs.yml:121` has the ingest transition guard on `work.document_ready`.
- `:136` has `complete_ingest` preconditions requiring both `work.document_ready` and `ingest.delegation.document_ingest.settled`.
- `:141` has the `document_ingest` action precondition requiring `work.document_ready`.

Fix:

- `src/foundry-program/synthesizer.ts:6307` selects a special generated smoke renderer for required upload plus manifest-reused document-ingest children.
- `src/foundry-program/synthesizer.ts:6709` renders a route-level generated smoke that uploads a real text file, dispatches the reused `document_ingest` child channel, registers a local stub child under `document-ingest`, settles the delegation, harvests summary/sections, and only then drives the ingest transition.
- `src/foundry-program/synthesizer.ts:6888` asserts the child result is complete; `:6891` asserts settled; `:6895` asserts final mode is `finalization_hub`.
- `tests/integration/generated-upload-smoke.test.ts:179` is the falsifier: required upload plus manifest-reused document-ingest reaches the hub.

Live-drive note: the generated smoke is hermetic and now proves the parent route semantics. The reused-delegation live-drive still cannot complete in the current shadow until the real child program code is available.

## Falsifiers RED To GREEN

RED before the fix:

```text
run_smoke_verification used npm test and could report passed while generated-program-smoke failed.
generated live-drive handler selected childProgram: "SimoneOS Document Ingest".
existing-repo runner imported programs/SimoneOS Document Ingest/registration.js.
required upload smoke stayed at ingest because document_ingest delegation never settled.
```

GREEN after the fix:

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts \
  tests/unit/foundry-real-handlers.test.ts \
  tests/unit/command-runner.test.ts \
  tests/unit/generated-live-drive-env.test.ts \
  tests/integration/generated-upload-smoke.test.ts \
  -t "generated Vitest smoke|reused child target_slug|delegated child imports|manifest-reused document-ingest|generated smoke and deterministic"

Test Files  4 passed (4)
Tests       5 passed | 43 skipped (48)
```

Relevant generated-live-drive / delegation / existing-repo / foundry-end-to-end suite:

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts \
  tests/unit/generated-live-drive-env.test.ts \
  tests/unit/generated-live-drive-status.test.ts \
  tests/unit/generated-live-drive-choreography.test.ts \
  tests/unit/existing-repo.test.ts \
  tests/unit/foundry-real-handlers.test.ts \
  tests/unit/command-runner.test.ts \
  tests/integration/generated-live-drive.test.ts \
  tests/integration/generated-upload-smoke.test.ts \
  tests/integration/generated-delegation-smoke.test.ts \
  tests/integration/multi-child-delegation-falsifier.test.ts \
  tests/integration/foundry-repo-targeting-flow.test.ts \
  tests/integration/foundry-end-to-end.test.ts \
  --pool=threads --maxWorkers=1

Test Files  11 passed | 1 skipped (12)
Tests       98 passed | 9 skipped (107)
Duration    53.20s
```

## Verification Tails

```text
npm run typecheck
> tsc --noEmit
```

```text
env -u NPM_TOKEN npm run test:unit
Test Files  116 passed | 4 skipped (120)
Tests       775 passed | 14 skipped (789)
Duration    173.63s
```

```text
env -u NPM_TOKEN npm run test:static
=== Result: 8 pass, 0 fail ===
optional generated scaffold install/test skipped because NPM_TOKEN is unset
```

Legal-opinion resynthesis:

```text
env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

Legal-opinion static check:

```text
approval_item_count: 93
approval_tail_guard: true
bad_projection_paths: []
child_artifacts: opinion_dd_worker, bahrain_law_research_agent
export_surfaces: { docx: true }
```
