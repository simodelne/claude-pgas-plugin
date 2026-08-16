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

const PROGRAM_SLUG = 'export-decision-autoadvance';
const PROGRAM_NAME = 'Export Decision Autoadvance';
const EXPORT_STAGE = 'assemble_export';
const EXPORT_OUTPUT = `${EXPORT_STAGE}.output`;
const ALL_TERMINAL = 'work.opinion_sections.all_terminal';

const confirmationLifecycle = {
  version: 1,
  name: 'opinion_sections',
  item_label: 'opinion section',
  storage: {
    items_path: 'work.opinion_sections.items',
    event_path: 'work.opinion_sections.pending_event_json',
    violation_path: 'work.opinion_sections.lifecycle_violation_json',
    representation: 'indexed_array',
  },
  item: {
    id_field: 'id',
    status_field: 'status',
    schema: {
      id: 'string',
      title: 'string',
      proposed_text: 'string',
      final_text: 'string',
      user_instruction: 'string',
    },
  },
  statuses: [
    { name: 'draft', initial: true },
    { name: 'proposed' },
    { name: 'accepted', terminal: true },
    { name: 'skipped', terminal: true },
  ],
  transitions: [],
  aggregate: {
    guard_field: ALL_TERMINAL,
    terminal_statuses: ['accepted', 'skipped'],
    require_non_empty: true,
  },
};

const confirmationLoop = {
  collection: 'work.opinion_sections.items',
  proposed_status: 'proposed',
  seed: { source_stage: 'draft_sections', id_prefix: 'section' },
  item_id_field: 'id',
  item_title_field: 'title',
  decisions: {
    approve: { to: 'accepted' },
    revise: {
      to: 'proposed',
      requires_instruction: true,
      instruction_path: 'work.opinion_sections.items.*.user_instruction',
      re_propose: true,
    },
    skip: { to: 'skipped' },
  },
  one_proposed_at_a_time: true,
  aggregate: {
    guard_field: ALL_TERMINAL,
    terminal_statuses: ['accepted', 'skipped'],
  },
  stage: 'approve',
  summary_path: 'summary.confirmation_loop',
  violation_path: 'work.opinion_sections.confirmation_violation_json',
  pending_action_path: 'decisions.pending_approve_action',
};

describe('export decision-only auto-advance falsifier', () => {
  it('synthesizes export modes as decision-only with deterministic export wired off the LLM path', async () => {
    const artifact = await artifactFromDomain();
    const spec = load(artifact.spec_yaml) as {
      features?: string[];
      modes: Record<string, {
        decision_only?: boolean;
        vocabulary?: string[];
        channels?: string[];
        transitions?: Array<{ target: string; when?: Record<string, unknown> }>;
      }>;
      prompts?: Record<string, string>;
      projection?: Record<string, unknown>;
      guidance?: Record<string, string[]>;
      action_map: Record<string, unknown>;
      integrations?: Record<string, {
        channel: string;
        hooks?: Array<{ action: string; event: string; result_path?: string }>;
      }>;
      reactions?: Record<string, { event: string; write_scope: string[] }>;
    };

    expect(spec.features).toContain('decision_only');
    expect(spec.modes[EXPORT_STAGE]).toMatchObject({
      decision_only: true,
      vocabulary: [],
      channels: [],
      transitions: [
        {
          target: 'complete',
          when: { kind: 'FieldTruthy', path: ALL_TERMINAL },
        },
      ],
    });
    expect(spec.prompts?.[EXPORT_STAGE]).toBeUndefined();
    expect(spec.projection?.[EXPORT_STAGE]).toBeUndefined();
    expect(spec.guidance?.[EXPORT_STAGE]).toBeUndefined();
    expect(spec.action_map.complete_assemble_export).toBeUndefined();
    expect(spec.modes.approve.vocabulary).toContain('complete_approve');
    expect(spec.modes.approve.vocabulary).not.toContain('complete_assemble_export');

    const exportHooks = Object.values(spec.integrations ?? {})
      .flatMap((integration) => integration.hooks ?? [])
      .filter((hook) => hook.result_path === EXPORT_OUTPUT);
    expect(exportHooks).toEqual([
      expect.objectContaining({
        action: `render_${EXPORT_STAGE}_export`,
        event: 'OnTransition',
        result_path: EXPORT_OUTPUT,
      }),
    ]);
    expect(Object.values(spec.reactions ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'OnTransition',
        write_scope: [`${EXPORT_STAGE}.render_pending`],
      }),
    ]));
    expect(artifact.handlers_ts).toContain(`run${toPascalCase(EXPORT_STAGE)}`);
    expect(artifact.handlers_ts).toContain(`render_${EXPORT_STAGE}_export`);
    expect(artifact.handlers_ts).not.toContain(`async complete_${EXPORT_STAGE}`);
  });

  it('auto-advances through export after approval without an export-stage author round', { timeout: 120_000 }, async () => {
    const artifact = await artifactFromDomain();
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-export-decision-only-'));
    const author = scriptedAuthor([
      effect('begin_work', {}),
      effect('complete_draft_sections', {
        result_json: JSON.stringify({ section_count: 1, drafting_status: 'ready', confidence: 'high' }),
        items_json: JSON.stringify([
          {
            id: 'section-1',
            title: 'Opinion 1',
            proposed_text: 'DRAFT-OPINION-BODY',
          },
        ]),
      }, 'stage_output'),
      effect('propose_item', { proposed_text: 'APPROVED-OPINION-BODY' }),
      effect('complete_approve', {}),
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
            modelId: 'export-decision-autoadvance-observer',
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
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start export autoadvance test' });
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'draft opinion sections' });
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'propose the first section' });
        await client.sessions.trigger(sessionId, { channel: 'user_confirmation', payload: { decision: 'approve' } });

        const completed = await readSnapshot(client, sessionId);
        expect(completed.mode).toBe('complete');
        expect(completed.running).toBe(false);
        expect(completed.domain[ALL_TERMINAL]).toBe(true);
        const output = outputAt(completed.domain, EXPORT_OUTPUT);
        const result = JSON.parse(String(output.result_json)) as { docx_base64: string; docx_bytes: number; section_count: number };
        expect(result.docx_base64.length).toBeGreaterThan(0);
        expect(result.docx_bytes).toBeGreaterThan(0);
        expect(result.section_count).toBe(3);
        expect(author.calls()).toEqual([
          'begin_work',
          'complete_draft_sections',
          'propose_item',
          'complete_approve',
        ]);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

interface RouteSnapshot {
  mode: string | null;
  running: boolean;
  domain: Record<string, unknown>;
}

type ScriptedResponse = ReturnType<typeof effect>;

async function artifactFromDomain(): Promise<SynthesizedArtifact> {
  const artifact = synthesizeProgramSpecFromDomain(exportDecisionDomain());
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-new-export-decision-domain-'));
  try {
    return await synthesizeDomainLogic({
      ...artifact,
      created_at: '2026-07-29T00:00:00.000Z',
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

function exportDecisionDomain(): Record<string, unknown> {
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
    'program.design_path': 'design',
    'intake.purpose': 'Draft legal opinion sections, approve them one by one, assemble the approved sections into a DOCX export, and complete.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'draft_sections',
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: {
            result_json: { stage: 'string', section_count: 'number' },
            items_json: [{ id: 'string', title: 'string', proposed_text: 'string' }],
          },
          rules: ['Create draft opinion sections for confirmation.'],
          invariants: ['items_json must contain the proposed sections.'],
        },
      },
      {
        slug: 'approve',
        domain_spec: {
          reads: ['draft_sections.items_json', 'work.opinion_sections.items.*.proposed_text'],
          produces: {},
          rules: ['Confirm each proposed section.'],
          invariants: ['Do not write final export bytes.'],
        },
      },
      {
        slug: EXPORT_STAGE,
        kind: 'export_docx',
        domain_spec: {
          reads: ['work.opinion_sections.items.*.final_text'],
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
          rules: ['Render approved opinion sections into a deterministic DOCX export.'],
          invariants: ['Do not call an LLM or provider while rendering export bytes.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'draft_sections', trigger: 'started', guard_field: 'intake.started' },
      { from: 'draft_sections', to: 'approve', trigger: 'drafted', guard_field: 'draft_sections.ready' },
      { from: 'approve', to: EXPORT_STAGE, trigger: 'approved', guard_field: ALL_TERMINAL },
      { from: EXPORT_STAGE, to: 'complete', trigger: 'exported', guard_field: ALL_TERMINAL },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        draft_sections: { kind: 'llm-reasoning' },
        approve: { kind: 'pure-compute' },
      },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: ALL_TERMINAL,
      collection_lifecycle: confirmationLifecycle,
    }),
    'intake.interaction_json': JSON.stringify({ confirmation_loops: [confirmationLoop] }),
  };
}

function bodyForStage(request: StageBodyRequest): string {
  if (request.stage === 'draft_sections') {
    return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, section_count: 1 }),
    items_json: JSON.stringify([
      {
        id: 'section-1',
        title: 'Opinion 1',
        proposed_text: 'DRAFT-OPINION-BODY',
      },
    ]),
    digest: '',
  };
}
`;
  }
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, ready: true }),
    items_json: JSON.stringify([]),
    digest: '',
  };
}
`;
}

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  return loadRenderedGeneratedProgramEntry(targetDir, PROGRAM_SLUG);
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<RouteSnapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    running: Boolean(state?.running ?? envelope.running),
    domain: world.domain as Record<string, unknown>,
  };
}

function outputAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const prefix = `${pathKey}.`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
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
    modelId: 'export-decision-autoadvance-author',
    calls: () => [...calls],
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no export-decision author response scripted for call ${String(index - 1)}`);
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

function toPascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}
