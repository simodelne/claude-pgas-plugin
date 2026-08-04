# GAP-DF-6.7 Report - Foundry Graduation Verification Status Canonicalization

Date: 2026-08-04
Branch: `fix/foundry-canonicalize-graduation-verification-status`

## Fix

- `src/foundry-program/handlers.ts:361` wires all graduation verification status reactions through canonical status handling, including:
  `graduation.static_verification`, `graduation.smoke_verification`, `graduation.live_verification`,
  `graduation.generated_live_drive`, `graduation.rebase_status`, and `graduation.rebase_verification`.
- `src/foundry-program/handlers.ts:514` stores canonical gate values while preserving verbose status sentences in evidence fields:
  `graduation.static_verification_status_text`, `graduation.smoke_verification_status_text`,
  `graduation.live_verification_status_text`, `graduation.generated_live_drive_status_text`,
  `graduation.rebase_status_text`, and `graduation.rebase_verification_status_text`.
- `src/foundry-program/handlers.ts:683` parses exact synonyms, leading status phrases such as `passed: ...`, and explicit fields such as
  `status: passed`; `src/foundry-program/handlers.ts:702` rejects ambiguous verification text with a concrete repair prompt before mode exit.
- `src/foundry-program/handlers.ts:546` gives generated live-drive handler output precedence over the LLM-echoed status arg and preserves verbose live-drive status text as evidence.
- `src/foundry-program/handlers.ts:598` canonicalizes rebase status, keeps known no-op/clean rebase outcomes compatible, and rejects arbitrary ambiguous rebase prose.
- `src/foundry-program/handlers.ts:1171` and `src/foundry-program/handlers.ts:1249` canonicalize direct handler payloads for static and post-rebase static verification.
- `src/foundry-program/specs.yml:930`, `src/foundry-program/specs.yml:959`, `src/foundry-program/specs.yml:980`, `src/foundry-program/specs.yml:994`, `src/foundry-program/specs.yml:1013`, and `src/foundry-program/specs.yml:1026` document canonical status intake for each graduation action.
- `src/foundry-program/specs.yml:1087` expands reaction write scopes for the evidence text fields; `src/foundry-program/specs.yml:1208` adds those fields to schema, with matching model fields at `src/pgas-new/model.ts:143`.

## Falsifier

- RED on origin/main command:
  `env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/unit/standalone-graduation.test.ts tests/integration/foundry-end-to-end.test.ts -t "verbose|run_static_verification canonicalizes|graduation verification status reactions"`
- RED tail: `Test Files 2 failed (2); Tests 9 failed | 3 passed | 12 skipped (24)`. Key failure: expected `graduation.static_verification` to be `passed`, received `passed: npm_typecheck and npm_test completed for document-finalization static verification`; `run_smoke_verification` was not callable.
- GREEN focused tails:
  `tests/unit/standalone-graduation.test.ts`: `Test Files 1 passed (1); Tests 20 passed (20)`.
  `tests/integration/foundry-end-to-end.test.ts -t "verbose"`: `Test Files 1 passed (1); Tests 2 passed | 3 skipped (5)`.
- Falsifier coverage lives at `tests/integration/foundry-end-to-end.test.ts:197` for the static->smoke gate and `tests/integration/foundry-end-to-end.test.ts:234` for the full verbose ladder. Unit reaction coverage is at `tests/unit/standalone-graduation.test.ts:54`, with ambiguous rejection at `tests/unit/standalone-graduation.test.ts:105` and rebase ambiguity coverage at `tests/unit/standalone-graduation.test.ts:200`.

## Verification Tails

- `npm run typecheck`
  Tail: `> pgas-new@3.24.0 typecheck` / `> tsc --noEmit`.
- `env -u NPM_TOKEN npm run test:unit`
  Tail: `Test Files 116 passed | 4 skipped (120); Tests 767 passed | 14 skipped (781); Duration 185.17s`.
- `env -u NPM_TOKEN npm run test:static`
  Tail: `PASS: Vitest suite passed`; `[6/6] optional generated scaffold install/test`; `SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run`; `=== Result: 8 pass, 0 fail ===`.
- `timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts`
  Tail: `[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter`.
- `timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/static-check-legal-opinion.ts`
  Tail: `"bad_projection_paths": []`, `"capability_gaps": []`, `"export_surfaces": { "docx": true }`.
- `timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/cycle6-render-legal-opinion-check.ts`
  Tail: `"ok": true`, `"section_count": 89`, `"approved_content_count": 89`, `"docx_bytes": 137524`.
- `git diff --check`
  Tail: no output; exit 0.
