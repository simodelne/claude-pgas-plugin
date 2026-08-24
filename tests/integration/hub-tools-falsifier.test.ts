import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import type {
  ConversationMessage,
  OpenAIToolDefinition,
  ProgramEntry,
  UnifiedAuthorDriverOptions,
} from '@simodelne/pgas-server/plugin.js';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain, type SynthesizedSpec } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold, type RenderStandaloneOptions } from '../../src/pgas-new/template-renderer.js';
import { loadRenderedGeneratedProgramEntry } from '../fixtures/generated-convention-entry.js';
import { loadGeneratedReactionHandlers, loadGeneratedToolRegistry } from '../unit/generated-handlers-loader.js';

const PROGRAM_SLUG = 'hub-tools-falsifier';
const PROGRAM_NAME = 'Hub Tools Falsifier';
const HUB_STAGE = 'hub';
const WEB_RESULT_PATH = 'hub.tool_results.web_search';
const RESEARCH_RESULT_PATH = 'hub.delegation.research.result';
const REVIEW_RESULT_PATH = 'hub.delegation.review.result';
const WEB_SENTINEL = 'TASK2_WEB_SEARCH_SENTINEL';
const CHILD_SENTINEL = 'TASK2_RESEARCH_DELEGATION_SENTINEL';

describe('hub ad-hoc tools falsifier', () => {
  it('generates registered web_search source and advertises engine toolkit tools in the hub schema', async () => {
    const artifact = synthesizeProgramSpecFromDomain(webSearchDomain());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(loadGeneratedReactionHandlers(artifact.handlers_ts).size).toBeGreaterThan(0);
    expect(artifact.tools_ts).toContain("import { createWebSearchProvider } from '../../../libraries/search/index.js';");
    expect(artifact.tools_ts).toContain("registry.register('web_search', {");
    expect(artifact.tools_ts).toContain('let webProvider: ReturnType<typeof createWebSearchProvider> | null = null;');
    expect(artifact.tools_ts).not.toMatch(/registerHubToolsFalsifierTools\(_registry: ToolRegistry\): void \{\s*\/\/ Stage actions are native action_map entries/u);
    expect(artifact.registration_ts).toContain('registerHubToolsFalsifierTools(toolRegistry)');
    expect(artifact.registration_ts).toContain('toolRegistry.createAdapter(name)');
    expect(artifact.registration_ts).toContain("channels: ['tool:web_search']");

    const registry = loadGeneratedToolRegistry(
      artifact.tools_ts,
      'registerHubToolsFalsifierTools',
      () => ({
        async search(query: string) {
          return {
            results: [{
              title: `sentinel:${query}`,
              url: 'https://sentinel.example/search',
              snippet: WEB_SENTINEL,
              score: 0.99,
            }],
          };
        },
      }),
    );
    expect(registry.has('web_search')).toBe(true);
    const adapter = registry.createAdapter('web_search') as {
      dispatch: (payload: unknown) => Promise<{ success?: boolean; result?: WebSearchResult }>;
    };
    const out = await adapter.dispatch({ payload: { query: 'Bahrain companies law', max_results: 1 } });
    expect(out.success).toBe(true);
    expect(out.result?.status).toBe('ok');
    expect(out.result?.results?.[0]?.snippet).toBe(WEB_SENTINEL);

    expect(parsed.tools.web_search).toMatchObject({
      result_path: WEB_RESULT_PATH,
      modes: [HUB_STAGE],
    });
    expect(parsed.schema).toMatchObject({
      'hub.tool_results': 'object',
      [WEB_RESULT_PATH]: 'object',
    });
    expect(parsed.projection.hub.include).toContain(WEB_RESULT_PATH);
    expect(parsed.modes.hub.vocabulary).toEqual(expect.arrayContaining([
      'record_note',
      'pin_note',
      'unpin_note',
      'delete_note',
    ]));
  });

  // STILL QUARANTINED on 5.7.0 — but for a DIFFERENT, engine-side reason. Re-verified
  // 2026-08-24 against the published @simodelne/pgas-server@5.7.0:
  //
  //   * simodelne/pgas#1044 IS FIXED. The shipped bundle's setNestedPath
  //     (plugin.mjs) now clones every intermediate segment
  //     (`const next = isRecord2(existing) ? { ...existing } : {}`) instead of
  //     descending into the frozen author-provided object, and the old
  //     "Cannot assign to read only property 'topic'" error no longer occurs.
  //     Triggers 1 and 2 now pass, including the web_search world-state assertion.
  //
  //   * A DISTINCT failure is now reachable at the same call site: the THIRD
  //     trigger (the one that dispatches delegation) is rejected with
  //     `PgasApiError: SESSION_REVISION_CONFLICT`. This is DETERMINISTIC, not a
  //     race — inserting a fixed 750ms delay before every trigger does not change
  //     it, and there is no client-visible round-settle signal to wait on (the
  //     session envelope exposes only the lifecycle `status: "Running"`, no
  //     per-round busy flag), so it cannot be synchronized away test-side.
  //
  // Still NOT a foundry defect and still not fixable consumer-side: the foundry
  // emits a legitimate inputEnrichment (parent inputs.initial_user_text -> child
  // request.topic) and the conflict arises inside the engine's delegation-dispatch
  // revision/CAS path. Kept as a regression guard: un-skip once the engine resolves
  // the delegation-trigger revision conflict.
  it.skip('routes registered web_search and hub-triggered delegation results back into hub-visible state', { timeout: 120_000 }, async () => {
    const artifact = artifactFromDomain(hubToolsDomain());
    const childArtifacts = artifact.child_artifacts ?? [];
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(childArtifacts.map((child) => child.slug).sort()).toEqual(['research', 'review']);
    expect(parsed.modes.hub.vocabulary).toEqual(expect.arrayContaining(['research', 'review']));
    expect(parsed.modes.hub.channels).toEqual(expect.arrayContaining(['research_call', 'review_call', 'system_query_result']));
    expect(parsed.modes.hub.preconditions?.research).toBeUndefined();
    expect(parsed.modes.hub.preconditions?.advance_hub_to_complete).toBeUndefined();
    expect(parsed.projection.hub.include).toEqual(expect.arrayContaining([
      WEB_RESULT_PATH,
      `${RESEARCH_RESULT_PATH}.summary`,
      `${REVIEW_RESULT_PATH}.summary`,
    ]));

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-hub-tools-'));
    const captures: Capture[] = [];
    try {
      renderStandaloneScaffold({
        slug: PROGRAM_SLUG,
        name: PROGRAM_NAME,
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedRegistrationTs: artifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: artifact.stage_sources,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
        synthesizedChildArtifacts: childArtifacts,
      } as RenderStandaloneOptions & DelegationRenderOptions);
      writeSearchProviderStub(targetDir);
      linkRootNodeModules(targetDir);

      const parent = await importProgramEntry(targetDir, PROGRAM_SLUG);
      const researchArtifact = childArtifacts.find((child) => child.slug === 'research');
      const reviewArtifact = childArtifacts.find((child) => child.slug === 'review');
      const research = await importProgramEntry(targetDir, 'research', researchArtifact?.delegation_result_policy);
      const review = await importProgramEntry(targetDir, 'review', reviewArtifact?.delegation_result_policy);
      const server = await createPgasServer({
        programs: [
          { name: PROGRAM_SLUG, entry: parent },
          { name: 'research', entry: research },
          { name: 'review', entry: review },
        ],
        drivers: {
          authorMode: 'unified',
          unified: {
            complete: scriptedAuthor(captures),
            inlineWorldQuery: { enabled: true },
          },
          authorHandle: {
            modelId: 'hub-tools-legacy-author',
            async complete() {
              throw new Error('legacy author path should not run');
            },
          },
          observerHandle: {
            modelId: 'hub-tools-observer',
            async complete() {
              return 'noop';
            },
          },
        },
        devMode: true,
        telemetry: { enabled: false },
        port: 0,
      });
      const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
      const created = await client.sessions.create({ program: PROGRAM_SLUG });

      try {
        await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'start hub tools' });

        await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'search for a sentinel' });
        const afterSearch = await readRouteState(client, created.sessionId);
        expect(afterSearch.mode).toBe(HUB_STAGE);
        expect(valueAtWorldPath(afterSearch.world, `${WEB_RESULT_PATH}.result.results.0.snippet`)).toBe(WEB_SENTINEL);

        await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'delegate research now' });
        const afterDelegation = await readRouteState(client, created.sessionId);
        expect(afterDelegation.mode).toBe(HUB_STAGE);
        expect(valueAtWorldPath(afterDelegation.world, `${RESEARCH_RESULT_PATH}.summary`)).toBe(CHILD_SENTINEL);
        expect(valueAtWorldPath(afterDelegation.world, 'hub.delegation.research.settled')).toBe(true);
        expect(valueAtWorldPath(afterDelegation.world, 'hub.delegation.research.degraded')).toBe(false);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }

    const hubCapture = captureWithTool(captures, 'web_search');
    expect(hubCapture.toolNames).toEqual(expect.arrayContaining([
      'query',
      'record_note',
      'pin_note',
      'unpin_note',
      'delete_note',
      'web_search',
      'research',
    ]));
  });
});

interface ParsedSpec {
  features: string[];
  modes: Record<string, {
    vocabulary: string[];
    channels: string[];
    preconditions?: Record<string, Array<{ kind: string; path: string }>>;
  }>;
  projection: Record<string, { include: string[]; exclude: string[] }>;
  schema: Record<string, string>;
  tools: Record<string, unknown>;
}

interface WebSearchResult {
  status: string;
  results: Array<{ title: string; url: string; snippet: string; score?: number }>;
}

interface Capture {
  prompt: string;
  toolNames: string[];
}

interface RouteState {
  mode: string | null;
  world: Record<string, unknown>;
}

interface DelegationRenderOptions {
  synthesizedChildArtifacts?: Array<SynthesizedSpec & {
    slug: string;
    name: string;
    registration_ts?: string;
    stage_sources?: Record<string, string>;
  }>;
}

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-08-04T00:00:00.000Z',
  };
}

function webSearchDomain(): Record<string, unknown> {
  return {
    ...baseHubDomain(),
    'intake.delegation_json': JSON.stringify({}),
  };
}

function hubToolsDomain(): Record<string, unknown> {
  return {
    ...baseHubDomain(),
    'intake.delegation_json': JSON.stringify({
      children: [
        hubDelegationChild('research', RESEARCH_RESULT_PATH),
        hubDelegationChild('review', REVIEW_RESULT_PATH),
      ],
    }),
  };
}

function baseHubDomain(): Record<string, unknown> {
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
    'program.design_path': 'design',
    'intake.purpose': 'Use a conversational hub with registered web search and delegated research/review tools.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: HUB_STAGE,
        kind: 'hub',
        archetype: 'conversational_hub',
        engine_tools: ['query', 'notebook'],
        tools: [
          {
            name: 'web_search',
            kind: 'registered',
            provider: 'libraries/search',
            result_path: WEB_RESULT_PATH,
            description: 'Search the web for current, source-grounded information.',
            modes: [HUB_STAGE],
          },
        ],
        domain_spec: {
          reads: ['inputs.initial_user_text', WEB_RESULT_PATH, `${RESEARCH_RESULT_PATH}.summary`],
          produces: {},
          rules: ['Stay in the hub while ad-hoc tools run.'],
          invariants: ['Tool and delegation results must be visible in the hub.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: HUB_STAGE, trigger: 'started', guard_field: 'intake.started' },
      { from: HUB_STAGE, to: HUB_STAGE, trigger: 'stay' },
      { from: HUB_STAGE, to: 'complete', trigger: 'done', guard_field: 'hub.finalize_requested' },
    ]),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'hub.finalize_requested',
    }),
  };
}

function hubDelegationChild(id: 'research' | 'review', resultPath: string): Record<string, unknown> {
  return {
    id,
    stage: HUB_STAGE,
    action_name: id,
    ad_hoc: true,
    synthesize_child: {
      kind: 'worker',
      purpose: `Handle delegated ${id} from the hub and echo the seeded topic.`,
      result_fields: {
        summary: 'string',
        seeded_topic: 'string',
      },
    },
    payload_map: {
      'request.topic': 'inputs.initial_user_text',
      'domain_context.original_request': 'inputs.initial_user_text',
    },
    result_path: resultPath,
    max_delegated_rounds: 12,
    round_timeout_ms: 5000,
    optional: true,
  };
}

function scriptedAuthor(captures: Capture[]): UnifiedAuthorDriverOptions['complete'] {
  let webSearchCalls = 0;
  let delegationCalls = 0;
  return async (messages, tools) => {
    const prompt = promptText(messages);
    const toolNames = tools.map((tool) => tool.function.name);
    captures.push({ prompt, toolNames });
    if (hasTool(tools, 'begin_work')) {
      return toolCall('begin_work', {});
    }
    if (hasCompleteTool(tools)) {
      const complete = firstCompleteTool(tools);
      return toolCall(complete, {
        result_json: JSON.stringify({ summary: CHILD_SENTINEL, seeded_topic: CHILD_SENTINEL }),
        items_json: JSON.stringify([`delegated:${CHILD_SENTINEL}`]),
        summary: CHILD_SENTINEL,
        seeded_topic: CHILD_SENTINEL,
      });
    }
    if (webSearchCalls === 0 && hasTool(tools, 'web_search')) {
      webSearchCalls += 1;
      return toolCall('web_search', { query: 'sentinel search', max_results: 1 });
    }
    if (delegationCalls === 0 && hasTool(tools, 'research') && prompt.includes('delegate research now')) {
      delegationCalls += 1;
      return toolCall('research', { request: { topic: CHILD_SENTINEL } });
    }
    return toolCall('session_status', {});
  };
}

function hasTool(tools: OpenAIToolDefinition[], name: string): boolean {
  return tools.some((tool) => tool.function.name === name);
}

function hasCompleteTool(tools: OpenAIToolDefinition[]): boolean {
  return tools.some((tool) => tool.function.name.startsWith('complete_'));
}

function firstCompleteTool(tools: OpenAIToolDefinition[]): string {
  const name = tools.find((tool) => tool.function.name.startsWith('complete_'))?.function.name;
  if (!name) {
    throw new Error(`missing complete_* tool; got ${tools.map((tool) => tool.function.name).join(', ')}`);
  }
  return name;
}

function toolCall(name: string, args: Record<string, unknown>): { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } {
  return {
    tool_calls: [
      {
        id: `call_${name}`,
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

function promptText(messages: ConversationMessage[]): string {
  return messages
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))
    .join('\n');
}

async function importProgramEntry(
  targetDir: string,
  slug: string,
  delegationResultPolicy?: { fields: Array<{ path: string; key: string }> },
): Promise<ProgramEntry> {
  return loadRenderedGeneratedProgramEntry(targetDir, slug, {
    entryOverrides: delegationResultPolicy ? { delegationResultPolicy } : undefined,
  });
}

async function readRouteState(client: PgasClient, sessionId: string): Promise<RouteState> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: typeof envelope.mode === 'string' ? envelope.mode : typeof state?.mode === 'string' ? state.mode : null,
    world: world.domain as Record<string, unknown>,
  };
}

function valueAtWorldPath(world: Record<string, unknown>, path: string): unknown {
  return valueAtPathParts(world, path.split('.'));
}

function valueAtPathParts(current: unknown, parts: string[]): unknown {
  if (parts.length === 0) {
    return current;
  }
  if (!current || typeof current !== 'object') {
    return undefined;
  }
  if (Array.isArray(current)) {
    const index = Number(parts[0]);
    return Number.isInteger(index) && index >= 0
      ? valueAtPathParts(current[index], parts.slice(1))
      : undefined;
  }
  const record = current as Record<string, unknown>;
  for (let count = parts.length; count >= 1; count -= 1) {
    const key = parts.slice(0, count).join('.');
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return valueAtPathParts(record[key], parts.slice(count));
    }
  }
  return undefined;
}

function captureWithTool(captures: Capture[], toolName: string): Capture {
  const capture = captures.find((entry) => entry.toolNames.includes(toolName));
  if (!capture) {
    throw new Error(`missing capture with tool ${toolName}; saw ${captures.map((entry) => entry.toolNames.join(',')).join(' | ')}`);
  }
  return capture;
}

function writeSearchProviderStub(targetDir: string): void {
  const dir = join(targetDir, 'libraries/search');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.ts'), `export function createWebSearchProvider() {
  return {
    async search(query: string) {
      return {
        results: [{
          title: 'sentinel:' + query,
          url: 'https://sentinel.example/search',
          snippet: '${WEB_SENTINEL}',
          score: 0.99,
        }],
      };
    },
  };
}
`);
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}
