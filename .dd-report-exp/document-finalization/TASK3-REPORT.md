# Task 3 Report - skill_triage + skill catalog synthesis

## Engine contract pinned

- `node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:132` declares `skill_triage` as an explicit
  `Feature`, next to `activation`.
- `_shared-types.d.ts:165-184` defines `ActivationTargetDecl`: each target carries a static `body`; descriptions and
  scripts are optional engine-lazy metadata.
- `_shared-types.d.ts:210-233` defines the decision cell shape: `activated` or `declined`, origin kind, round, and mode.
- `_shared-types.d.ts:252-264` defines `DeclineSkillsAction` as a side-band action that settles the decision cell with
  state `declined`.
- `_shared-types.d.ts:940-986` keeps `activations` and `declines` outside normal terminal `actions`.
- `_shared-types.d.ts:1359-1377` requires decision schema paths to be disjoint and states that `skill_triage` is never
  auto-inferred.
- `_shared-types.d.ts:2262-2285` declares YAML-level `advisory_schema`, `activation_providers`, and `decision_schema`.
- `node_modules/@simodelne/pgas-server/dist-bundle/plugin.mjs:17413-17428` builds the rendered skill catalog from
  `spec.activation_providers`.
- `plugin.mjs:17429-17469` resolves skill names, builds `activate_skill`, and renders the catalog prompt.
- `plugin.mjs:17470-17493` builds `decline_skills` and the required triage guidance.
- `plugin.mjs:17763-17766` creates synthetic skill tools from the catalog/decision schema; `plugin.mjs:17844-17849`
  appends them to the LLM tool surface.
- `plugin.mjs:18226-18245` maps `activate_skill` to a side-band activation; `plugin.mjs:18252-18263` maps
  `decline_skills` to a side-band decline.
- `plugin.mjs:19750-19760` enforces `decision_schema` disjointness and the explicit `skill_triage` feature gate.
- `node_modules/@simodelne/pgas-server/dist-bundle/create-server.mjs:2751-2768` materializes activation bodies into
  advisory state at `skill.<name>`.
- `create-server.mjs:2783-2803` settles the decision zone from activation or decline acts.
- `create-server.mjs:3010-3022` applies activations and decision materialization during instruction execution.

## Synthesis change

Before:

- Foundry accepted hub/domain intake but ignored declared skills.
- Generated specs never emitted `features: [activation, skill_triage]`, `activation_providers`, `advisory_schema` skill
  paths, or `decision_schema.skill_triage_settled`.
- Stored synthesis context did not preserve skill catalogs for reasoning-contract re-synthesis.

After:

- `src/foundry-program/synthesizer.ts:208` parses skill intake from `intake.skills` or `intake.skills_json`.
- `src/foundry-program/synthesizer.ts:364` adds `activation` and `skill_triage` only when the normalized catalog is
  non-empty.
- `src/foundry-program/synthesizer.ts:615` applies skill triage declarations to the generated spec.
- `src/foundry-program/synthesizer.ts:933-958` emits:
  - `advisory_schema.skill.<name>: string`
  - `activation_providers.skill.targets.<name>.body`
  - `decision_schema.skill_triage_settled: string`
- `src/foundry-program/synthesizer.ts:730` includes skill catalog input during stored-context re-synthesis.
- `src/foundry-program/synthesizer.ts:10578-10615` normalizes the catalog, requires `{ name, body }`, rejects duplicate
  names, and preserves static body strings exactly.
- `src/foundry-program/synthesizer-store.ts:105-109` stores `skills` in `SynthesisContext`.

## Falsifier RED

Command on `origin/main`:

```text
npx vitest run --config tests/vitest.config.ts tests/integration/skill-triage-falsifier.test.ts
```

Observed failure before implementation:

```text
expected features to include ['activation', 'skill_triage']
received only ['base', 'runtime_control', 'inline_world_query', 'reactions']
```

This confirmed the foundry never synthesized the engine skill-triage contract.

## GREEN

```text
npx vitest run --config tests/vitest.config.ts tests/integration/skill-triage-falsifier.test.ts
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    1.52s
```

The GREEN falsifier asserts:

- generated spec includes `activation` and `skill_triage`;
- generated catalog contains declared names and exact static bodies for `clause-amendment`, `enforceability-review`,
  `risk-disclosure-checklist`, and `compare-to-precedent`;
- `activate_skill({"name":"clause-amendment"})` injects only the selected skill body on the next round and settles
  `skill_triage_settled` as `activated`;
- `decline_skills({})` settles `skill_triage_settled` as `declined` with no active skill body;
- synthetic skill tools appear in the runtime tool surface but not in hub vocabulary actions;
- a non-skill domain emits no `skill_triage`, `activation_providers`, or decision schema.

## Verification tails

```text
npm run typecheck
> tsc --noEmit
exit 0
```

```text
env -u NPM_TOKEN npm run test:unit
Test Files  113 passed | 4 skipped (117)
Tests       744 passed | 14 skipped (758)
Duration    159.54s
```

```text
env -u NPM_TOKEN npm run test:static
=== Result: 8 pass, 0 fail ===
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
```

```text
env -u NPM_TOKEN npx vitest run --config tests/vitest.config.ts tests/integration/foundry-end-to-end.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests       4 passed (4)
Duration    30.80s
```

```text
timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

```text
rg -n "skill_triage|activation_providers|activate_skill|decline_skills|skill_triage_settled" \
  .dd-report-exp/legal-opinion/generated/legal-opinion-drafter/src/programs/legal-opinion-drafter/specs.yml
exit 1, no matches
```

Legal-opinion regenerated features remain:

```text
features:
  - base
  - runtime_control
  - inline_world_query
  - reactions
  - decision_only
  - integrations
  - delegation
```

## Opt-in-only verdict

- Skill triage synthesis is opt-in only: it is emitted only when the hub/domain intake declares a non-empty skill catalog.
- Legal-opinion re-synthesis rendered cleanly and did not leak `skill_triage`, skill activation providers, decision-zone
  declarations, or synthetic skill tool names.
- No golden refresh was performed; no generated golden string changed.
