# Task 4 Report - selective section-artifact projection + query policy

Date: 2026-08-04
Branch: `feat/foundry-selective-section-artifact-projection`

## Config change

Before:

- Conversational hubs did not get a projection pass for declared document section artifacts.
- A hub declaring `work.document.summary` plus `work.document.sections.*.{id,heading,status,text}` did not project the summary or bounded section index.
- The generated schema did not declare those section artifact wildcard paths, so the engine query policy could not reliably authorize `work.document.sections.<id>.text` as a governed inline world query.

After:

- `src/foundry-program/synthesizer.ts` detects conversational hubs whose `domain_spec.reads` declare the complete section artifact shape:
  - `work.document.summary`
  - `work.document.sections.*.id`
  - `work.document.sections.*.heading`
  - `work.document.sections.*.status`
  - `work.document.sections.*.text`
- The hub projection includes only:
  - `work.document.summary`
  - `work.document.sections.*.id`
  - `work.document.sections.*.heading`
  - `work.document.sections.*.status`
- The hub projection explicitly excludes:
  - `work.document.sections.*.text`
- The generated schema declares the section artifact paths, allowing the existing `queryPolicyForDeclaredPaths` pass to emit `allowedWorldQueryPrefixes: ["work.document.sections", ...]` for the public engine `inline_world_query` primitive.

## Falsifier RED to GREEN

New falsifier:

```text
tests/integration/hub-selective-projection-falsifier.test.ts
```

RED on fresh branch from `origin/main`:

```text
$ npx vitest run --config tests/vitest.config.ts tests/integration/hub-selective-projection-falsifier.test.ts --pool=threads --maxWorkers=1
AssertionError: expected [ 'inputs.user_text', ... ] to deeply equal ArrayContaining{...}
Expected included: work.document.summary, work.document.sections.*.id, work.document.sections.*.heading, work.document.sections.*.status
Received hub projection included only inputs/notebook/guard fields
Test Files  1 failed (1)
Tests       1 failed (1)
```

GREEN after the synthesizer change:

```text
$ npx vitest run --config tests/vitest.config.ts tests/integration/hub-selective-projection-falsifier.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    1.65s
```

The GREEN runtime path renders a generated scaffold, seeds section artifacts via the public `PATCH /sessions/:id/domain` route, confirms the hub prompt contains summary/index but not full text, then has the scripted author call `query({"path":"work.document.sections.section_beta.text"})`. The next author call receives `TASK4_SECTION_TWO_TEXT_QUERY_ONLY_SENTINEL`, proving governed inline query returns the text while projection omits it.

## Focused regressions

```text
$ npx vitest run --config tests/vitest.config.ts \
  tests/integration/hub-selective-projection-falsifier.test.ts \
  tests/unit/synthesizer-scale-safe-projection.test.ts \
  tests/integration/generated-toolkit-awareness-falsifier.test.ts \
  tests/integration/hub-tools-falsifier.test.ts \
  --pool=threads --maxWorkers=1
Test Files  4 passed (4)
Tests       6 passed (6)
Duration    3.89s
```

Scale-safe projection stayed green in that focused run; existing approval/document fan-out bounds are intact.

## Verification tails

```text
$ npm run typecheck
> pgas-new@3.24.0 typecheck
> tsc --noEmit
```

```text
$ env -u NPM_TOKEN npm run test:unit
Test Files  114 passed | 4 skipped (118)
Tests       745 passed | 14 skipped (759)
Duration    150.96s
```

```text
$ env -u NPM_TOKEN npm run test:static
PASS: Vitest suite passed
[6/6] optional generated scaffold install/test
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
=== Result: 8 pass, 0 fail ===
```

Full branch gate:

```text
$ env -u NPM_TOKEN npm test
Test Files  114 passed | 4 skipped (118)
Tests       745 passed | 14 skipped (759)
PASS: Vitest suite passed
[6/6] optional generated scaffold install/test
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
=== Result: 8 pass, 0 fail ===
```

Legal-opinion re-synthesis:

```text
$ timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

Legal-opinion render-clean check:

```text
$ timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/cycle6-render-legal-opinion-check.ts
ok=true
section_count=89
approved_content_count=89
docx_bytes=137524
sha256=aa7c7b7fbe3966f36fbd3faa1b08982ed33f5f389b535e4ab4f2cc68350205a0
forbidden_exact_heading_hits=[]
forbidden_substring_hits=[]
```
