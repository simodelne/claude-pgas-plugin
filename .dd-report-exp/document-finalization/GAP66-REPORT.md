# GAP-DF-6.6 Report

## Fix

- `src/foundry-program/domain-synthesis.ts:181-198` resolves an `exportDescriptor` for export stages and disables cache/body-generator reuse for them.
- `src/foundry-program/domain-synthesis.ts:232-237` routes `export_docx`/`export_html` directly to the deterministic foundry emitters (`renderDocxExportStageBody` / `renderHtmlExportStageBody`) instead of the LLM body generator.
- `src/foundry-program/synthesizer.ts:251-253` now reconciles export-stage contracts immediately after export descriptors are known and before artifact/spec/contracts/context rendering.
- `src/foundry-program/synthesizer.ts:3347-3393` normalizes declared export `domain_spec.produces` to the supported deterministic export contracts:
  - DOCX: `["stage","docx_base64","docx_bytes","sha256","section_count"]`, `items_json: ["docx_export:<sha256>"]`
  - HTML: `["stage","html","html_bytes","sha256","section_count"]`, `items_json: ["html_export:<sha256>"]`

## Falsifier

- Added `tests/unit/export-stage-synthesis.test.ts:107` for a `finalize_export` `export_docx` stage whose intake declares the incompatible `["docx_ready","amended_docx_path"]` result contract.
- RED command:
  `env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/unit/export-stage-synthesis.test.ts -t "normalizes DOCX export result contracts"`
- RED tail:
  `Expected keys: ["docx_ready","amended_docx_path"]; got ["stage","docx_base64","docx_bytes","sha256","section_count"].`
- GREEN tail:
  `Test Files 1 passed (1); Tests 1 passed | 9 skipped (10).`

## Verification

- `env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/unit/export-stage-synthesis.test.ts`
  - `Test Files 1 passed (1); Tests 10 passed (10).`
- Focused domain/export/foundry suites:
  - `tests/unit/domain-synthesis.test.ts`, `domain-synthesis-golden.test.ts`, `domain-synthesis-escalation.test.ts`, `tests/integration/export-decision-only-autoadvance-falsifier.test.ts`
  - `Test Files 4 passed (4); Tests 41 passed (41).`
  - `tests/integration/foundry-end-to-end.test.ts`
  - `Test Files 1 passed (1); Tests 4 passed (4).`
- Legal-opinion resynthesis:
  - `env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts`
  - Tail: `[synthesize-legal-opinion] rendered 46 files to .../legal-opinion-drafter`
  - Static check passed with no bad projection paths; `assemble_export` audit recorded `behavioral_gate: "docx_export_render"`.
- Required gates:
  - `npm run typecheck` passed.
  - `env -u NPM_TOKEN npm run test:unit` passed: `Test Files 116 passed | 4 skipped (120); Tests 758 passed | 14 skipped (772).`
  - `env -u NPM_TOKEN npm run test:static` passed: `=== Result: 8 pass, 0 fail ===` (`NPM_TOKEN` unset, optional generated scaffold install/test skipped).
