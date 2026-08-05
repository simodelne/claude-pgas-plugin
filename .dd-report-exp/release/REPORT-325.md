# Release v3.25.0 Report

## Files bumped

- `package.json`: foundry package version `3.24.0` -> `3.25.0`.
- `package-lock.json`: top-level/root foundry package versions `3.24.0` -> `3.25.0`.
- `.claude-plugin/plugin.json`: foundry plugin version `3.24.0` -> `3.25.0`.
- `tests/plugin-manifest.test.sh`: manifest/package version expectation `3.24.0` -> `3.25.0`.

## Notes added

- Prepended `CHANGELOG.md` with `## v3.25.0`, grouped by engine alignment, document-finalization synthesis, existing-repo product-path hardening, and verification/UAT notes.
- Updated release-current foundry references in `docs/PGAS-NEW-ARCHITECTURE.md` to `v3.25.0`.
- Corrected the README engine text to `PGAS_SERVER_VERSION` `3.26.0`; `src/pgas-new/version.ts` was not touched.
- No engine dependency ranges were changed. `@simodelne/pgas-server` remains `^3.26.0`.
- No generated golden was refreshed. I found no generated-scaffold template that stamps the foundry self-version; generated package templates stamp app version `0.1.0` and engine `PGAS_SERVER_VERSION` only.
- Existing unrelated untracked fixture left untouched: `tests/sota/fixtures/body-cache/fee-calculator/df98d2f953757612a25996a692ee5f5d6f29479e4e2ceb2e5ae1095dc4a792fd.json`.

## Verification tails

### `npm run typecheck`

```text
> pgas-new@3.25.0 typecheck
> tsc --noEmit
```

### `env -u NPM_TOKEN npm run test:unit`

```text
[export-render-falsifier] F-6 PASS {"refused":["export_docx_trackchange"]}
[export-render-falsifier] F-7 PASS {"export_docx_plain":"synthesizes","export_docx_trackchange":"refuses"}

 Test Files  116 passed | 4 skipped (120)
      Tests  775 passed | 14 skipped (789)
   Start at  08:48:49
   Duration  196.00s (transform 3.24s, setup 0ms, import 65.16s, tests 111.03s, environment 17ms)
```

### `env -u NPM_TOKEN npm run test:static`

```text
  PASS: Vitest suite passed
[6/6] optional generated scaffold install/test
  SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run

=== Result: 8 pass, 0 fail ===
```

### Extra targeted check: `npm run test:manifest`

```text
[bonus] local session artifacts ignored
  PASS: .remember/ is ignored

=== Result: 26 pass, 0 fail ===
```
