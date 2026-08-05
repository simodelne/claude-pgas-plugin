# GAP-DF-6.10 Report

Date: 2026-08-05

## Fix

- `src/pgas-new/generated-live-drive.ts:199` now normalizes the live-drive runner layout from `targetKind`.
- `src/pgas-new/generated-live-drive.ts:213` computes runner imports with `posix.relative('.pgas-new-live-drive', <program path>)`.
- Standalone mode resolves program imports under `src/programs/<slug>/...`.
- Existing-repo mode resolves program imports under `<programsDir>/<slug>/...`; the foundry handler passes `programsDir` from the wiring manifest at `src/foundry-program/handlers.ts:1424`.
- All live-drive variants use the same helper: composite `:1133`, entry-only `:2249`, delegation `:2404`, extraction/docx `:2744`, upload `:3306`, export `:3728`, confirmation `:4113`.

## Observability

- `src/pgas-new/generated-live-drive.ts:972` captures child stdout/stderr before `.pgas-new-live-drive` cleanup.
- If the child exits non-zero without a structured report, `runner_error` is derived from the captured output at `src/pgas-new/generated-live-drive.ts:974`.
- `src/foundry-program/handlers.ts:1480` includes that real runner error in failure reasons, and `:1501` persists `runner_exit_code`, `runner_output_excerpt`, and `runner_error` in `graduation.generated_live_drive_report`.

## Falsifier RED To GREEN

RED on pre-fix code:

```text
tests/unit/generated-live-drive-env.test.ts
Expected: .../programs/document-finalization/registration.js
Received: .../src/programs/document-finalization/registration.js

tests/unit/foundry-real-handlers.test.ts
Received reason: final mode null did not reach completion stage complete | no successful provider round trips were observed during the drive
Missing: ERR_MODULE_NOT_FOUND
```

GREEN after fix:

```text
Test Files  2 passed (2)
Tests       34 passed (34)
```

Falsifiers:

- `tests/unit/generated-live-drive-env.test.ts:82` renders an existing-repo live-drive runner and resolves the registration import to `programs/document-finalization/registration.js`.
- `tests/unit/foundry-real-handlers.test.ts:403` proves a boot failure with `ERR_MODULE_NOT_FOUND` lands in the durable handler report.

## Verification Tails

```text
npm run typecheck
> tsc --noEmit
```

```text
env -u NPM_TOKEN npm run test:unit
Test Files  116 passed | 4 skipped (120)
Tests       771 passed | 14 skipped (785)
```

```text
env -u NPM_TOKEN npm run test:static
=== Result: 8 pass, 0 fail ===
```

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts \
  tests/integration/foundry-end-to-end.test.ts \
  tests/integration/foundry-branch-write.test.ts \
  tests/unit/existing-repo.test.ts \
  tests/unit/existing-repo-frontend-spec-path.test.ts
Test Files  4 passed (4)
Tests       13 passed (13)
```

```text
env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

Standalone live-drive runner confirmation:

```text
standalone live-drive registration import ok: from '../src/programs/legal-opinion-drafter/registration.js'
```

No generated legal-opinion diffs remained after re-synthesis.
