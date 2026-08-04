# GAP-DF-6.5 Report

## B Fix

- `src/foundry-program/domain-synthesis.ts:2000` now treats an explicit `domain_spec.produces.result_json` object as the authority for serialized result keys.
- `src/foundry-program/domain-synthesis.ts:2001-2017` only enforces `result_json.stage === stage` when the produces schema declares `stage`; legacy no-schema bodies still keep the baseline stage check.
- `src/foundry-program/domain-synthesis.ts:2150-2179` compares actual `result_json` keys exactly to the declared schema, including schemas that intentionally omit `stage` and `adapter_kind`.
- `src/foundry-program/domain-synthesis.ts:2690-2724` renders deterministic fallback `result_json` from the declared schema keys only and keeps external-adapter `adapter_kind` on `StageOutput.adapter_kind`.
- `src/foundry-program/domain-synthesis.ts:2730-2741` includes `stage` or `adapter_kind` inside fallback `result_json` only when the produces contract declares those keys.

## A Verdict

A: env-only. No foundry runtime change was needed for the codex-author/qwen-body split.

Coverage added at `tests/unit/domain-synthesis-escalation.test.ts:145` verifies `PGAS_ENABLE_CODEX_DRIVER=1` does not route body generation through Codex when `PGAS_OPENAI_BASE_URL=http://qwen.local/v1` and `PGAS_OPENAI_MODEL=qwen36-27b` are set. The test observes the OpenAI-compatible `/chat/completions` request and asserts `createProviderHandles` is not called.

## Falsifier

- Added the B falsifier fixture at `tests/unit/domain-synthesis.test.ts:240` with external-adapter `ingest` and produces schema `["summary","section_count"]`.
- Added the RED/GREEN assertion at `tests/unit/domain-synthesis.test.ts:1290`: force generator failure, accept deterministic fallback, execute the generated `runStage`, and assert `Object.keys(result_json) === ["summary","section_count"]` while `adapter_kind === "in_memory_mock"` remains top-level output metadata.
- RED before fix:
  - Command: `env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/unit/domain-synthesis.test.ts -t "keeps external-adapter deterministic fallback metadata outside result_json"`
  - Failure: `Expected keys: ["summary","section_count"]; got ["stage","summary","section_count","adapter_kind"]`.
- GREEN after fix:
  - Same command.
  - Tail: `Test Files 1 passed (1); Tests 1 passed | 34 skipped (35); Duration 1.43s`.

## Verification

- `npm run typecheck`: passed; tail `tsc --noEmit`.
- Targeted external-adapter/domain-synthesis/foundry-end-to-end group:
  - Command: `env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/unit/domain-synthesis.test.ts tests/unit/domain-synthesis-escalation.test.ts tests/unit/domain-synthesis-golden.test.ts tests/integration/domain-synthesis-loopback.test.ts tests/integration/domain-synthesis-live.test.ts tests/integration/generated-multistage-smoke.test.ts tests/integration/foundry-end-to-end.test.ts --pool=threads --maxWorkers=1`
  - Tail: `Test Files 6 passed | 1 skipped (7); Tests 45 passed | 3 skipped (48); Duration 56.49s`.
- `env -u NPM_TOKEN npm run test:unit`: passed; tail `Test Files 116 passed | 4 skipped (120); Tests 757 passed | 14 skipped (771); Duration 169.49s`.
- `env -u NPM_TOKEN npm run test:static`: passed; tail `=== Result: 8 pass, 0 fail ===`; optional generated scaffold install/test skipped because `NPM_TOKEN` was unset.
- Legal-opinion re-synthesis:
  - `timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts`
  - Tail: rendered 46 files to `.dd-report-exp/legal-opinion/generated/legal-opinion-drafter`.
- Legal-opinion static/render checks:
  - Static tail included `bad_projection_paths: []`, `capability_gaps: []`, and `export_surfaces: { docx: true }`.
  - Render tail included `"ok": true`, `"section_count": 89`, `"approved_content_count": 89`, and `"forbidden_substring_hits": []`.

## Scope Notes

- No simoneos files were modified.
- No secrets or token-dependent install paths were used.
- The pre-existing untracked SOTA body-cache fixture was left untouched.
