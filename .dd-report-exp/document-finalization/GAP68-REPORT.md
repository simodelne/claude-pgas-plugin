# GAP-DF-6.8 + 6.9 Report

Date: 2026-08-05

## Result

Implemented both requested falsifier-first fixes:

- GAP-DF-6.8: `run_live_provider_verification` and `run_generated_live_drive_verification` still share `isReachable`, but the helper now probes the OpenAI-compatible `/models` endpoint derived from `PGAS_OPENAI_BASE_URL` instead of fetching the bare `/v1` base.
- GAP-DF-6.9: existing-repo render rewrites generated `web_search` imports from standalone depth to the depth implied by `<programs_dir>/<slug>`, so `programs/<slug>/tools.ts` resolves repo-root `libraries/search/index.ts`.

No SimoneOS checkout mutation: `git -C /home/simone/simoneos status --short` returned no output.

## Fixes

- `src/foundry-program/handlers.ts:1370` and `src/foundry-program/handlers.ts:1406` continue to gate both live verification actions through `isReachable`.
- `src/foundry-program/handlers.ts:2350-2369` now derives `<base>/models`, strips query/hash, fetches that endpoint, and treats `response.ok` as reachability.
- `src/pgas-new/template-renderer.ts:294-307` computes the existing-repo program dir from `manifest.paths.programs_dir` plus slug and rewrites synthesized `tools.ts`.
- `src/pgas-new/template-renderer.ts:318-325` computes the relative `libraries/search/index.js` import with `posix.relative(programDir, 'libraries/search/index.js')`.

## Falsifiers

GAP-DF-6.8:

- Added `tests/unit/foundry-real-handlers.test.ts:363-401`.
- RED: `npm exec vitest -- run tests/unit/foundry-real-handlers.test.ts -t "runs generated live drive when the provider base is 404 but /models is reachable"` failed with `status: "skipped"` instead of expected `status: "passed"`.
- GREEN: same command passed after the helper fetched `http://provider.local/v1/models`.

GAP-DF-6.9:

- Added `tests/unit/template-renderer.test.ts:243-283`.
- RED: `npm exec vitest -- run tests/unit/template-renderer.test.ts -t "renders existing-repo web_search imports relative to the target repo libraries directory"` failed because generated import was `../../../libraries/search/index.js`.
- GREEN: same command passed with `../../libraries/search/index.js`, and the test verified the import resolves to repo-root `libraries/search/index.ts`.

## Verification

Requested commands:

- `npm run typecheck`: passed (`tsc --noEmit`).
- `env -u NPM_TOKEN npm run test:unit`: passed (`116 passed | 4 skipped`; `769 passed | 14 skipped`).
- `env -u NPM_TOKEN npm run test:static`: passed (`8 pass, 0 fail`; optional generated scaffold install/test skipped because `NPM_TOKEN` was intentionally unset).

Affected/named suites:

- `npm exec vitest -- run tests/unit/foundry-real-handlers.test.ts`: passed (`31 passed`).
- `npm exec vitest -- run tests/unit/template-renderer.test.ts`: passed (`26 passed`).
- `npm exec vitest -- run tests/integration/hub-tools-falsifier.test.ts`: passed (`2 passed`).
- `npm exec vitest -- run --config tests/vitest.config.ts tests/integration/foundry-end-to-end.test.ts tests/integration/hub-tools-falsifier.test.ts`: passed (`2 files passed`; `7 passed`).
- `npm exec vitest -- run --config tests/vitest.config.ts tests/unit/existing-repo.test.ts tests/unit/existing-repo-frontend-spec-path.test.ts tests/unit/graduation-audit.test.ts tests/unit/standalone-graduation.test.ts`: passed (`4 files passed`; `30 passed`).
- `npm exec vitest -- run --config tests/vitest.config.ts tests/integration/foundry-live-graduation.test.ts tests/integration/generated-live-drive.test.ts` without live env: skipped (`2 files skipped`; `10 skipped`).

Opt-in live run:

- Local probe: `curl http://localhost:8000/v1/models` returned HTTP `200`.
- `PGAS_OPENAI_BASE_URL=http://localhost:8000/v1 PGAS_OPENAI_MODEL=qwen36-27b PGAS_OPENAI_API_KEY=local npm run test:live-graduation`: failed after the `/models` reachability fix allowed the live path to advance.
- Failure tail: `domain-synthesis-live.test.ts` expected exact `domain_synthesis_audit` arrays but the live provider emitted additional audited stages (`intake`, `brief_summary`); `foundry-live-graduation.test.ts` then failed inside generated `npm test` for `expense-audit-live`.
- I did not change those live-drift assertions in this PR because they are outside GAP-DF-6.8/6.9 and the hermetic requested suite passed.

Legal-opinion resynthesis/render:

- `node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts`: passed, rendered `46` files to `.dd-report-exp/legal-opinion/generated/legal-opinion-drafter`.
- `node --import tsx .dd-report-exp/legal-opinion/scripts/static-check-legal-opinion.ts`: passed; `bad_projection_paths: []`, delegation policy/input enrichment present, DOCX export surface present.
- `node --import tsx .dd-report-exp/cycle6-render-legal-opinion-check.ts`: passed with `ok: true`, `section_count: 89`, `approved_content_count: 89`, `docx_bytes: 137524`.

Additional observation:

- Extra generated-package check `npm run typecheck` inside `.dd-report-exp/legal-opinion/generated/legal-opinion-drafter` failed on generated scaffold issues unrelated to this PR: optional `mutations` typing in generated handlers and missing `chalk` types/dependency for the generated REPL.
