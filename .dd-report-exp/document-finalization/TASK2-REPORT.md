# Task 2 Report — ad-hoc hub tools

## SimoneOS registration signature matched

- Matched the grounded `web_search` ToolRegistry shape used by SimoneOS Bahrain research:
  `/home/simone/simoneos/programs/simoneos/bahrain-law-research/tools.ts:17` imports `createToolRegistry, type ToolRegistry`,
  `:18` imports `createWebSearchProvider` from `../../../libraries/search/index.js`,
  `:20-27` creates a registry and lazy `webProvider`,
  `:27-29` registers `web_search` as `{ kind: 'local', fn: async (args: Record<string, unknown>) => ... }`,
  and `:43-50` lazily calls `createWebSearchProvider().search(fullQuery)`.
- Matched the adapter wiring signature from
  `/home/simone/simoneos/programs/simoneos/bahrain-law-research/registration.ts:39-60`:
  `syncOutContinuationPolicy.channels` includes `tool:web_search`, generated handler names are inserted before
  `createProgramAdapters`, and `adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name))` installs the
  registered tool adapter.
- Legal-opinion's integrated wiring test asserts the same behavior through
  `/home/simone/simoneos/programs/simoneos/legal-opinion-drafter/__tests__/spec-wiring.test.ts:438-486`.

## Wiring

- Registered tool synthesis:
  `src/foundry-program/synthesizer.ts:9530-9628` collects stage `tools[]` descriptors for registered `web_search`,
  normalizes provider aliases to `libraries/search`, and emits the generated tool schema.
- Generated `tools.ts`:
  `src/foundry-program/synthesizer.ts:5451-5522` imports `../../../libraries/search/index.js`, emits lazy provider
  construction, registers `web_search`, calls `webProvider.search(fullQuery)`, and returns structured ok/failed results.
- Generated registration:
  `src/foundry-program/synthesizer/registration-artifacts.ts:38-43` emits `syncOutContinuationPolicy`; `:94-112`
  mirrors the SimoneOS adapter-handler/ToolRegistry output replacement pattern.
- Hub-triggered delegation:
  `src/foundry-program/synthesizer-store.ts:24-29` adds `action_name` and `ad_hoc`; `src/foundry-program/synthesizer.ts:1210-1217`
  uses the custom action as the delegation tool; `:1251-1267` skips once-only/stage-advance gates for ad-hoc children;
  `:1330-1343`, `:1393-1407`, and `:1417-1463` keep the child call/result visible in the hub.
- Engine toolkit:
  hub stages already receive notebook action vocabulary via the existing toolkit path; the falsifier verifies notebook
  write actions in generated hub vocabulary and `query` in the runtime LLM tool schema.

## Falsifier RED

Command on `origin/main`:

```text
npx vitest run --config tests/vitest.config.ts tests/integration/hub-tools-falsifier.test.ts --pool=threads --maxWorkers=1
```

Observed failures before implementation:

```text
generated tools.ts was still the empty stub:
export function registerHubToolsFalsifierTools(_registry: ToolRegistry): void {
  // Stage actions are native action_map entries...
  void _registry;
}

delegation.children[1].stage must be unique across children; stage hub is used by more than one child
```

## GREEN

```text
npx vitest run --config tests/vitest.config.ts tests/integration/hub-tools-falsifier.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests       2 passed (2)
```

The GREEN scripted hub run:

- dispatched generated `web_search` through a stub `libraries/search` provider and observed `TASK2_WEB_SEARCH_SENTINEL`
  at `hub.tool_results.web_search.result.results.0.snippet`;
- dispatched hub tool `research` and observed `TASK2_RESEARCH_DELEGATION_SENTINEL` at
  `hub.delegation.research.result.summary`;
- confirmed the hub stayed in `hub`, `settled=true`, `degraded=false`, and runtime tools included `query`,
  notebook write tools, `web_search`, and `research`.

## Verification tails

```text
npm run typecheck
> tsc --noEmit
exit 0
```

```text
env -u NPM_TOKEN npm run test:unit
Test Files  112 passed | 4 skipped (116)
Tests       743 passed | 14 skipped (757)
Duration    162.38s
```

```text
env -u NPM_TOKEN npm run test:static
=== Result: 8 pass, 0 fail ===
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
```

```text
npx vitest run --config tests/vitest.config.ts tests/integration/foundry-end-to-end.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests       4 passed (4)
Duration    36.00s
```

```text
node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts
[synthesize-legal-opinion] rendered 46 files to /home/simone/pgas-new/.dd-report-exp/legal-opinion/generated/legal-opinion-drafter
```

```text
node --import tsx .dd-report-exp/cycle6-render-legal-opinion-check.ts
ok=true
section_count=89
approved_content_count=89
docx_bytes=137524
sha256=aa7c7b7fbe3966f36fbd3faa1b08982ed33f5f389b535e4ab4f2cc68350205a0
forbidden_exact_heading_hits=[]
forbidden_substring_hits=[]
```
