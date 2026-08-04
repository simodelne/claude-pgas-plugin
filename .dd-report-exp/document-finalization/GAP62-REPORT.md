# GAP-DF-6.2 Report

## Result

Hyphenated manifest delegation slugs now work through the foundry product path. The generated PGAS child id is normalized to a slug-safe internal identifier, while the external wiring slug is preserved for manifest binding and payload mapping.

## Fix

- `src/foundry-program/synthesizer.ts:201` wraps manifest-resolved delegation descriptors in `normalizeDelegationChildInternalIdentifiers(...)` before descriptor assertion and spec generation.
- `src/foundry-program/synthesizer.ts:7244` resolves a reusable manifest agent from the child plus the Q5 per-stage target (`stages.ingest.target` / target_slug / program_slug variants).
- `src/foundry-program/synthesizer.ts:7248` rewrites manifest-reused children by removing `synthesize_child`, setting canonical `target_spec`, and preserving the external manifest slug in both `registered_name` and `target_slug`.
- `src/foundry-program/synthesizer.ts:7281` normalizes only the internal child/action identifiers (`document-ingest` -> `document_ingest`) and updates result paths only when they contain the old internal id.
- `src/foundry-program/synthesizer.ts:7393` keeps lookup candidates separate from the generated child id: explicit child targets, preserved target slug, registered name, and the Q5 stage target are used for manifest lookup.
- `src/foundry-program/synthesizer-store.ts:31` adds `target_slug?: string` to the delegation child descriptor so synthesis context can carry the external slug explicitly.
- Existing binding still uses the preserved external slug: `src/foundry-program/synthesizer.ts:7627` includes `registered_name` in `delegationPolicy.allowedTargetPrograms`.

## Falsifier

Added `tests/integration/foundry-repo-targeting-flow.test.ts:31`, a real foundry product session falsifier. It drives Q1-Q6 through `record_q5_delegation`, approves design, selects an existing repo, loads a `.pgas/wiring.yml`, authorizes the target, runs `synthesize_program_spec`, and reaches `scaffold_plan`.

Fixture shape:

- `tests/integration/foundry-repo-targeting-flow.test.ts:36` sets `stages.ingest.target` to `document-ingest`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:40` sets the Q5 child id to the failing hyphenated value `document-ingest`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:499` exposes hyphenated manifest slugs `document-ingest` and `review-service`.

Assertions:

- `tests/integration/foundry-repo-targeting-flow.test.ts:142` asserts synthesis completed.
- `tests/integration/foundry-repo-targeting-flow.test.ts:143` asserts the generated child has internal id `document_ingest` and preserved external `registered_name` / `target_slug` of `document-ingest`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:154` asserts the generated channel is `document_ingest_call`, targets `SimoneOS Document Ingest`, and keeps the manifest `result_path`.
- `tests/integration/foundry-repo-targeting-flow.test.ts:159` asserts no invalid `document-ingest_call` channel is emitted.
- `tests/integration/foundry-repo-targeting-flow.test.ts:160` asserts the action map points to the normalized channel.
- `tests/integration/foundry-repo-targeting-flow.test.ts:161` asserts generated registration text still contains the manifest target and external slug.

## RED -> GREEN

RED on origin/main behavior, using the new product-path falsifier before implementation:

```text
tests/integration/foundry-repo-targeting-flow.test.ts (5 tests | 1 failed)
delegation.children[0].id must be a slug-safe identifier; got document-ingest
```

GREEN after the normalize-preserve fix:

```text
npx vitest run --config tests/vitest.config.ts tests/integration/foundry-repo-targeting-flow.test.ts -t "normalizes a hyphenated manifest delegation slug"
Test Files  1 passed (1)
Tests  1 passed | 4 skipped (5)
```

## Verification

```text
npm run typecheck
> tsc --noEmit
exit 0
```

```text
env -u NPM_TOKEN npm run test:unit
Test Files  116 passed | 4 skipped (120)
Tests  750 passed | 14 skipped (764)
Duration 171.25s
```

```text
env -u NPM_TOKEN npm run test:static
[6/6] optional generated scaffold install/test
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
=== Result: 8 pass, 0 fail ===
```

```text
npx vitest run --config tests/vitest.config.ts tests/integration/foundry-end-to-end.test.ts tests/unit/manifest-driven-connectors.test.ts tests/unit/delegation-descriptor.test.ts tests/integration/delegation-engine-falsifier.test.ts tests/integration/delegation-slice-runtime-falsifier.test.ts tests/integration/generated-delegation-smoke.test.ts tests/integration/multi-child-delegation-falsifier.test.ts
Test Files  7 passed (7)
Tests  45 passed (45)
Duration 31.40s
```

Legal-opinion re-synthesis and render:

```text
node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

```text
node --import tsx .dd-report-exp/legal-opinion/scripts/static-check-legal-opinion.ts
"capability_gaps": []
"child_artifacts": [
  { "slug": "opinion_dd_worker", "name": "Legal Opinion Drafter OpinionDd Worker" },
  { "slug": "bahrain_law_research_agent", "name": "Legal Opinion Drafter BahrainLawResearch Research Agent" }
]
```

```text
node --import tsx .dd-report-exp/cycle6-render-legal-opinion-check.ts
"ok": true
"section_count": 89
"approved_content_count": 89
"docx_bytes": 137524
```

## Binding Confirmation

For the hyphenated real slug `document-ingest`, synthesis now emits:

- internal child id: `document_ingest`
- generated channel/action wiring: `document_ingest_call` / `document_ingest`
- external manifest slug: `target_slug: "document-ingest"` and `registered_name: "document-ingest"`
- payload map: preserved from the manifest for `request.extraction_contract` and `domain_context.original_request`
- binding policy: `allowedTargetPrograms` includes both `SimoneOS Document Ingest` and `document-ingest`

No simoneos workspace mutation was performed.
