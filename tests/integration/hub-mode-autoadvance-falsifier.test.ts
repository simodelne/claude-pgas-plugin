import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeDomainLogic, type StageBodyRequest } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { loadRenderedGeneratedProgramEntry } from '../fixtures/generated-convention-entry.js';

const PROGRAM_SLUG = 'hub-mode-autoadvance';
const PROGRAM_NAME = 'Hub Mode Autoadvance';
const HUB_STAGE = 'hub';
const AMEND_STAGE = 'amend_approval';
const EXPORT_STAGE = 'finalize_export';
const COMPLETE_STAGE = 'complete';
const AMEND_BRANCH_GUARD = 'hub.amend_requested';
const FINALIZE_BRANCH_GUARD = 'hub.finalize_requested';
const AMEND_COMPLETE_GUARD = 'amend_approval.ready';
const HUB_STAY_ACTION = 'advance_hub_to_hub';
const AMEND_ACTION = 'advance_hub_to_amend_approval';
const FINALIZE_ACTION = 'advance_hub_to_finalize_export';
const AMEND_COMPLETE_ACTION = 'complete_amend_approval';

describe('hub mode autoadvance falsifier', () => {
  it('keeps non-terminal hub actions in the hub, returns from a branch, and exits only on finalize', { timeout: 120_000 }, async () => {
    const artifact = await artifactFromDomain();
    const spec = load(artifact.spec_yaml) as {
      modes: Record<string, {
        transitions?: Array<{ target: string; guard?: { kind: string; path: string } }>;
        vocabulary?: string[];
      }>;
      action_map: Record<string, {
        channel?: string;
        result_path?: string;
        mutations?: Array<{ path: string }>;
      }>;
      proceed_to: Record<string, string>;
    };
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-hub-autoadvance-'));
    const author = scriptedAuthor([
      effect('begin_work', {}, channelForAction(spec, 'begin_work')),
      effect('session_status', {}, channelForAction(spec, 'session_status')),
      effect(AMEND_ACTION, {}, channelForAction(spec, AMEND_ACTION)),
      effect(AMEND_COMPLETE_ACTION, {}, channelForAction(spec, AMEND_COMPLETE_ACTION)),
      effect('session_status', {}, channelForAction(spec, 'session_status')),
      effect(FINALIZE_ACTION, {}, channelForAction(spec, FINALIZE_ACTION)),
    ]);

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
        synthesizedExportSurfaces: artifact.export_surfaces,
      });
      linkRootNodeModules(targetDir);

      const server = await createPgasServer({
        programs: [{ name: PROGRAM_SLUG, entry: await importProgramEntry(targetDir) }],
        drivers: {
          authorHandle: author,
          observerHandle: {
            modelId: 'hub-mode-autoadvance-observer',
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
      const sessionId = created.sessionId;

      try {
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start hub test' });

        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'show status without leaving hub' });
        const afterNonTerminalTool = await readSnapshot(client, sessionId);
        expect(afterNonTerminalTool.mode).toBe(HUB_STAGE);

        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'propose an amendment' });
        const inAmendApproval = await readSnapshot(client, sessionId);
        expect(inAmendApproval.mode).toBe(AMEND_STAGE);

        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'approve that amendment' });
        const returnedToHub = await readSnapshot(client, sessionId);
        expect(returnedToHub.mode).toBe(HUB_STAGE);

        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'show status after returning to hub' });
        const afterReturnedNonTerminalTool = await readSnapshot(client, sessionId);
        expect(afterReturnedNonTerminalTool.mode).toBe(HUB_STAGE);

        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'finalize the document' });
        const completed = await readSnapshot(client, sessionId);
        expect(completed.mode).toBe(COMPLETE_STAGE);
        expect(completed.running).toBe(false);
        expect(author.calls()).toEqual([
          'begin_work',
          'session_status',
          AMEND_ACTION,
          AMEND_COMPLETE_ACTION,
          'session_status',
          FINALIZE_ACTION,
        ]);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }

    expect(stageArchetype(artifact.stage_classification, HUB_STAGE)).toBe('conversational-hub');
    expect(artifact.body_stage_slugs).not.toContain(HUB_STAGE);
    expect(spec.modes[HUB_STAGE]?.vocabulary).toEqual(expect.arrayContaining([
      HUB_STAY_ACTION,
      AMEND_ACTION,
      FINALIZE_ACTION,
      'session_status',
    ]));
    expect(spec.modes[HUB_STAGE]?.transitions).toEqual(expect.arrayContaining([
      { target: HUB_STAGE, guard: { kind: 'FieldTruthy', path: 'hub.hub_selected' } },
      { target: AMEND_STAGE, guard: { kind: 'FieldTruthy', path: AMEND_BRANCH_GUARD } },
      { target: EXPORT_STAGE, guard: { kind: 'FieldTruthy', path: FINALIZE_BRANCH_GUARD } },
    ]));
    expect(spec.proceed_to[AMEND_ACTION]).toBe(AMEND_STAGE);
    expect(spec.proceed_to[FINALIZE_ACTION]).toBe(EXPORT_STAGE);
    expect(spec.action_map[AMEND_ACTION]).toMatchObject({
      channel: 'widget_output',
      mutations: [{ path: AMEND_BRANCH_GUARD }],
    });
    expect(spec.action_map[AMEND_ACTION]?.result_path).toBeUndefined();
  });
});

interface RouteSnapshot {
  mode: string | null;
  running: boolean;
}

type ScriptedResponse = ReturnType<typeof effect>;

async function artifactFromDomain(): Promise<SynthesizedArtifact> {
  const artifact = synthesizeProgramSpecFromDomain(hubDomain());
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-new-hub-domain-'));
  try {
    return await synthesizeDomainLogic({
      ...artifact,
      created_at: '2026-08-04T00:00:00.000Z',
    }, {
      cacheDir,
      providerUrl: '',
      model: '',
      generator: async (request) => bodyForStage(request),
    });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function hubDomain(): Record<string, unknown> {
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
    'program.design_path': 'design',
    'intake.purpose': 'Finalize a document through a central hub with amendment approval and export.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: HUB_STAGE,
        kind: 'hub',
        archetype: 'conversational_hub',
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: {},
          rules: ['Remain available across user turns until an explicit branch action is chosen.'],
          invariants: ['Non-terminal tools must not leave the hub.'],
        },
      },
      {
        slug: AMEND_STAGE,
        domain_spec: {
          reads: [AMEND_BRANCH_GUARD],
          produces: { result_json: { stage: 'string', approved: 'boolean' }, items_json: ['amendment:approved'] },
          rules: ['Apply the single amendment decision and return to the hub.'],
          invariants: ['Do not finalize the document.'],
        },
      },
      {
        slug: EXPORT_STAGE,
        kind: 'export_docx',
        domain_spec: {
          reads: [FINALIZE_BRANCH_GUARD],
          produces: {
            result_json: {
              stage: 'string',
              docx_base64: 'string',
              docx_bytes: 'number',
              sha256: 'string',
              section_count: 'number',
            },
            items_json: ['docx_export:<sha256>'],
          },
          rules: ['Render the amended document into a deterministic DOCX export.'],
          invariants: ['Do not call an LLM or provider while rendering export bytes.'],
        },
      },
      { slug: COMPLETE_STAGE, is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: HUB_STAGE, trigger: 'started', guard_field: 'intake.started' },
      { from: HUB_STAGE, to: HUB_STAGE, trigger: 'stay' },
      { from: HUB_STAGE, to: AMEND_STAGE, trigger: 'amend', guard_field: AMEND_BRANCH_GUARD },
      { from: HUB_STAGE, to: EXPORT_STAGE, trigger: 'finalize', guard_field: FINALIZE_BRANCH_GUARD },
      { from: AMEND_STAGE, to: HUB_STAGE, trigger: 'decision', guard_field: AMEND_COMPLETE_GUARD },
      { from: EXPORT_STAGE, to: COMPLETE_STAGE, trigger: 'exported', guard_field: FINALIZE_BRANCH_GUARD },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({
      final_stage: COMPLETE_STAGE,
      guard_field: FINALIZE_BRANCH_GUARD,
    }),
  };
}

function bodyForStage(request: StageBodyRequest): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, approved: input.stage === '${AMEND_STAGE}' }),
    items_json: JSON.stringify([input.stage + ':item']),
    digest: '',
  };
}
`;
}

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  return loadRenderedGeneratedProgramEntry(targetDir, PROGRAM_SLUG);
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<RouteSnapshot> {
  const envelope = await client.sessions.get(sessionId);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    running: Boolean(state?.running ?? envelope.running),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function scriptedAuthor(responses: ScriptedResponse[]) {
  let index = 0;
  const calls: string[] = [];
  return {
    modelId: 'hub-mode-autoadvance-author',
    calls: () => [...calls],
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no hub-mode author response scripted for call ${String(index - 1)}`);
      }
      const action = response.actions[0]?.name;
      if (typeof action === 'string') {
        calls.push(action);
      }
      return JSON.stringify(response);
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function channelForAction(
  spec: { action_map: Record<string, { channel?: string }> },
  actionName: string,
): string {
  return spec.action_map[actionName]?.channel ?? 'widget_output';
}

function stageArchetype(stageClassification: unknown[], slug: string): unknown {
  const found = stageClassification.find((stage) =>
    stage !== null
    && typeof stage === 'object'
    && !Array.isArray(stage)
    && (stage as Record<string, unknown>).slug === slug);
  return found && typeof found === 'object' && !Array.isArray(found)
    ? (found as Record<string, unknown>).archetype
    : undefined;
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}
