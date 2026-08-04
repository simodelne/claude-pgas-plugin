# GAP-DF-6.3 Report

## Result

Existing-repo reusable delegation now treats manifest `payload_map` keys as the child input contract and adapts the source side from the new parent program's declared schema. Incompatible reusable mappings fail during Q5 intake with repair guidance instead of terminal-failing after design approval.

## Fix

- `src/foundry-program/synthesizer.ts:727` adds `adaptReusableDelegationPayloadMapsForDomain(...)`, a reusable adapter/validator that resolves manifest children, normalizes internal ids/enrichment, builds the new parent's declared schema path set, and returns adapted delegation plus compatibility errors.
- `src/foundry-program/synthesizer.ts:7297` and `src/foundry-program/synthesizer.ts:7314` now preserve the reusable manifest target slug while calling `adaptReusableProgramPayloadMap(...)` instead of copying manifest sources verbatim.
- `src/foundry-program/synthesizer.ts:7325` keeps manifest payload-map target keys, prefers the Q5 parent-provided source for each target key, supports one explicit parent source as an override for all manifest keys, and only falls back to the manifest source when no override is provided.
- `src/foundry-program/synthesizer.ts:10688` emits actionable compatibility errors: `manifest source X is not declared in this program's schema; provide a source mapping...`.
- `src/foundry-program/synthesizer.ts:10732` collects parent-declared paths during intake validation before completion exists, including entry-channel input paths, stage domain reads/produces, transitions, document paths, and child result paths.
- `src/foundry-program/handlers.ts:390` canonicalizes `intake.delegation_json` through the manifest adapter when a visible existing-repo manifest exists.
- `src/foundry-program/handlers.ts:405` adds the Q5 fail-fast reaction: incompatible reusable mappings clear `intake.q5_recorded`, set `intake.delegation_validation_error`, and keep the user at Q5 with the repair text.
- `src/foundry-program/handlers.ts:466` reads the manifest either from stored repo wiring state or from `<program.target_dir>/.pgas/wiring.yml` during intake, so validation happens before repo-targeting approval steps.
- `src/foundry-program/specs.yml:61`, `src/foundry-program/specs.yml:70`, `src/foundry-program/specs.yml:632`, `src/foundry-program/specs.yml:1036`, and `src/foundry-program/specs.yml:1118` wire the validation state into Q6/finalize preconditions, projection/schema, reaction metadata, and Q5 guidance.

## Falsifier

Added `tests/integration/foundry-repo-targeting-flow.test.ts:31`, a real foundry product-session falsifier. It drives Q1-Q6 through `record_q5_delegation`, approves the design, selects an existing repo, loads a `.pgas/wiring.yml`, authorizes the target, runs `synthesize_program_spec`, and reaches `scaffold_plan`.

Success-with-override case:

- `tests/integration/foundry-repo-targeting-flow.test.ts:40` supplies parent-declared Q5 sources `inputs.initial_user_text` for manifest child input keys `request.extraction_contract` and `domain_context.original_request`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:69` asserts synthesis completes after approval.
- `tests/integration/foundry-repo-targeting-flow.test.ts:70` asserts the child remains bound to external slug `document-ingest` through `registered_name` and `target_slug`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:76` asserts payload-map sources are all parent-declared and no `intake.summary` source survives.
- `tests/integration/foundry-repo-targeting-flow.test.ts:81` asserts generated channel/action wiring still targets the external manifest program.

Fail-fast-without-override case:

- `tests/integration/foundry-repo-targeting-flow.test.ts:94` drives through Q5 with manifest-native source `intake.summary`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:118` waits for intake-time validation, not architecture synthesis.
- `tests/integration/foundry-repo-targeting-flow.test.ts:129` asserts the clear repair error contains `manifest source intake.summary is not declared in this program's schema` and `provide a source mapping`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:131` asserts design approval and synthesis never run.
- `tests/integration/foundry-repo-targeting-flow.test.ts:578`, `tests/integration/foundry-repo-targeting-flow.test.ts:601`, and `tests/integration/foundry-repo-targeting-flow.test.ts:714` define the reusable document-ingest Q5 payload, Q1-Q6 product path, and manifest fixture with native `intake.summary` sources.

## RED -> GREEN

RED on origin/main behavior, using the new product-path falsifier before implementation:

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/integration/foundry-repo-targeting-flow.test.ts --pool=threads --maxWorkers=1
Test Files  1 failed (1)
Tests  2 failed | 5 passed (7)
success-with-override failed after approval:
delegation.children[0].payload_map source intake.summary must be declared in the parent schema
fail-fast-without-override did not set intake.delegation_validation_error and timed out waiting for the Q5 validation failure
```

GREEN after the adapter and intake validation:

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/integration/foundry-repo-targeting-flow.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests  7 passed (7)
```

## Verification

```text
npm run typecheck
> pgas-new@3.24.0 typecheck
> tsc --noEmit
```

```text
env -u NPM_TOKEN npm run test:unit
Test Files  116 passed | 4 skipped (120)
Tests  752 passed | 14 skipped (766)
Duration 178.80s
```

```text
env -u NPM_TOKEN npm run test:static
[6/6] optional generated scaffold install/test
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
=== Result: 8 pass, 0 fail ===
```

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/unit/manifest-driven-connectors.test.ts tests/unit/manifest-payload-map-alignment.test.ts tests/integration/manifest-reuse-engine-falsifier.test.ts --pool=threads --maxWorkers=1
Test Files  3 passed (3)
Tests  25 passed (25)
```

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/unit/delegation-descriptor.test.ts tests/unit/delegation-continuation-contract.test.ts tests/integration/delegation-engine-falsifier.test.ts tests/integration/delegation-slice-runtime-falsifier.test.ts tests/integration/multi-child-delegation-falsifier.test.ts --pool=threads --maxWorkers=1
Test Files  5 passed (5)
Tests  28 passed (28)
```

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/integration/foundry-end-to-end.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests  4 passed (4)
```

Legal-opinion re-synthesis and render:

```text
timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

```text
timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/static-check-legal-opinion.ts
"capability_gaps": []
"child_artifacts": [
  { "slug": "opinion_dd_worker", "name": "Legal Opinion Drafter OpinionDd Worker" },
  { "slug": "bahrain_law_research_agent", "name": "Legal Opinion Drafter BahrainLawResearch Research Agent" }
]
```

```text
timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/cycle6-render-legal-opinion-check.ts
"ok": true
"section_count": 89
"approved_content_count": 89
"docx_bytes": 137524
"sha256": "aa7c7b7fbe3966f36fbd3faa1b08982ed33f5f389b535e4ab4f2cc68350205a0"
```

No simoneos workspace mutation was performed.
