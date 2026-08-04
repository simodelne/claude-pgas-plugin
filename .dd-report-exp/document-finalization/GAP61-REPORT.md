# GAP-DF-6.1 Report

## Intake Action Added

- Added the governed product-path intake action `record_skill_catalog` to the foundry's own `intake_intelligence` vocabulary at `src/foundry-program/specs.yml:31`.
- Gated it after Q6 and before finalize with design-path, q6-recorded, skills-not-recorded, and intake-not-finalized preconditions at `src/foundry-program/specs.yml:64`.
- Persisted the catalog as `intake.skills_json` plus `intake.skills_recorded` in the action map at `src/foundry-program/specs.yml:692`.
- Projected the catalog into intake confirmation, architecture design, and domain synthesis at `src/foundry-program/specs.yml:296`, `src/foundry-program/specs.yml:314`, and `src/foundry-program/specs.yml:320`.
- Added `summarize_design_confirmation` so finalized intake exposes a confirmation summary that lists the skill catalog names at `src/foundry-program/specs.yml:1029` and `src/foundry-program/handlers.ts:392`.
- Added strict handler validation/canonicalization for `[{name, body}]`, duplicate rejection, and non-empty body enforcement at `src/foundry-program/handlers.ts:165` and the `record_skill_catalog` handler at `src/foundry-program/handlers.ts:662`.
- Registered the semantic tool in the public foundry tool surface at `src/foundry-program/tools.ts:15`.

## Flow Into Synthesis

The implementation intentionally reuses the existing Task-3 synthesis path. The foundry synthesizer already reads `intake.skills` / `intake.skills_json` at `src/foundry-program/synthesizer.ts:216` and `src/foundry-program/synthesizer.ts:10677`, adds `activation` and `skill_triage` features when skills exist at `src/foundry-program/synthesizer.ts:375`, and writes skill activation targets at `src/foundry-program/synthesizer.ts:961`.

## Falsifier RED to GREEN

New falsifier: `tests/integration/foundry-skill-catalog-intake.test.ts:70`.

It drives the real foundry product path with `createTestHarness(createPgasNewFoundryProgramEntry())`, uses actual `intake_intelligence` actions for Q1-Q6, `record_documents_descriptor`, and `record_skill_catalog`, and never injects `intake.skills_json` directly into the domain.

Pinned assertions:

- Before design approval and before finalize, `intake.skills_json` contains all four entries and `intake.skills_recorded` is true: `tests/integration/foundry-skill-catalog-intake.test.ts:131`.
- The design confirmation summary lists `Skill catalog (4)` and all names: `tests/integration/foundry-skill-catalog-intake.test.ts:146`.
- After architecture/domain synthesis, the generated spec contains `activation`, `skill_triage`, and the four static catalog bodies: `tests/integration/foundry-skill-catalog-intake.test.ts:169`.

RED on origin/main after adding only the falsifier:

```text
npx vitest run --config tests/vitest.config.ts tests/integration/foundry-skill-catalog-intake.test.ts --pool=threads --maxWorkers=1
FAIL tests/integration/foundry-skill-catalog-intake.test.ts > foundry product intake skill catalog path > records a governed skill catalog before design approval and carries it into synthesis
SyntaxError: "undefined" is not valid JSON
at tests/integration/foundry-skill-catalog-intake.test.ts:134
```

GREEN after implementation:

```text
npx vitest run --config tests/vitest.config.ts tests/integration/foundry-skill-catalog-intake.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests  1 passed (1)
Duration  4.39s
```

## Verification Tails

```text
npm run typecheck
> pgas-new@3.24.0 typecheck
> tsc --noEmit
exit 0
```

```text
env -u NPM_TOKEN npm run test:unit
Test Files  116 passed | 4 skipped (120)
Tests  749 passed | 14 skipped (763)
Duration  193.90s
exit 0
```

```text
env -u NPM_TOKEN npm run test:static
[6/6] optional generated scaffold install/test
  SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
=== Result: 8 pass, 0 fail ===
exit 0
```

```text
npx vitest run --config tests/vitest.config.ts tests/integration/foundry-end-to-end.test.ts tests/integration/foundry-intake-flow.test.ts tests/integration/skill-triage-falsifier.test.ts tests/integration/foundry-skill-catalog-intake.test.ts --pool=threads --maxWorkers=1
Test Files  4 passed (4)
Tests  12 passed (12)
Duration  36.20s
exit 0
```

Legal-opinion no-leak/render check:

```text
node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter

rg -n "skill_triage|activation_providers|clause-amendment|enforceability-review|risk-disclosure-checklist|compare-to-precedent" .dd-report-exp/legal-opinion/generated/legal-opinion-drafter/src/programs
exit 1 (no matches)

node --import tsx .dd-report-exp/cycle6-render-legal-opinion-check.ts
"ok": true
"section_count": 89
"approved_content_count": 89
"forbidden_exact_heading_hits": []
"forbidden_substring_hits": []
exit 0
```
