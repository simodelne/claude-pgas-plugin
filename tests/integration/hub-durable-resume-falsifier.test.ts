import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type PgasClient } from '@simodelne/pgas-server/client.js';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { dump, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { loadRenderedGeneratedProgramEntry } from '../fixtures/generated-convention-entry.js';
import { startRouteHarness } from './foundry-test-utils.js';

const PROGRAM_SLUG = 'hub-durable-resume-falsifier';
const PROGRAM_NAME = 'Hub Durable Resume Falsifier';
const ENTRY_CHANNEL = 'user_text';
const HUB_STAGE = 'finalization_hub';
const COMPLETE_STAGE = 'complete';
const SUMMARY_PATH = 'work.document.summary';
const SECTIONS_PATH = 'work.document.sections';
const SECTION_KEY = 'section_alpha';
const SECTION_TEXT_PATH = `${SECTIONS_PATH}.${SECTION_KEY}.text`;
const AMENDMENT_RESULT_PATH = 'amend_approval.result_json';
const AMENDMENT_ITEMS_PATH = 'amend_approval.items_json';
const AMENDMENT_GUARD_PATH = `${HUB_STAGE}.amend_requested`;
const NOTE_PATH = 'notebook.resume_note';
const TEST_STATE_CHANNEL = 'test_state';

const CHECKPOINT_STATE = {
  [SUMMARY_PATH]: 'TASK5_SUMMARY_CHECKPOINT_SENTINEL',
  [`${SECTIONS_PATH}.${SECTION_KEY}.id`]: 'section-alpha',
  [`${SECTIONS_PATH}.${SECTION_KEY}.heading`]: 'Liability cap',
  [`${SECTIONS_PATH}.${SECTION_KEY}.status`]: 'approved',
  [SECTION_TEXT_PATH]: 'TASK5_APPROVED_SECTION_TEXT_SENTINEL',
  [AMENDMENT_RESULT_PATH]: JSON.stringify({
    section_id: 'section-alpha',
    new_text: 'TASK5_APPROVED_SECTION_TEXT_SENTINEL',
    approved: true,
  }),
  [AMENDMENT_ITEMS_PATH]: JSON.stringify(['amendment:section-alpha']),
  [NOTE_PATH]: 'TASK5_NOTEBOOK_SENTINEL: preserve negotiated cap rationale.',
  notebook_pins: ['resume_note'],
} as const satisfies Record<string, unknown>;

const MUTATED_STATE = {
  [SUMMARY_PATH]: 'MUTATED_SUMMARY_SHOULD_NOT_SURVIVE_RESTORE',
  [SECTION_TEXT_PATH]: 'MUTATED_SECTION_TEXT_SHOULD_NOT_SURVIVE_RESTORE',
  [AMENDMENT_RESULT_PATH]: JSON.stringify({ approved: false }),
  [NOTE_PATH]: 'MUTATED_NOTE_SHOULD_NOT_SURVIVE_RESTORE',
} as const satisfies Record<string, unknown>;

describe('hub durable checkpoint/resume falsifier', () => {
  it('synthesizes a durable conversation channel and resumes hub state from checkpoint', { timeout: 120_000 }, async () => {
    const artifact = synthesizeProgramSpecFromDomain(hubDomain());
    const specYaml = withTestStateChannel(artifact.spec_yaml, [
      ...Object.keys(CHECKPOINT_STATE),
      ...Object.keys(MUTATED_STATE),
    ]);
    const parsed = load(specYaml) as ParsedSpec;

    expect.soft(parsed.features).toContain('durable_channel');
    expect.soft(parsed.channels[ENTRY_CHANNEL]).toMatchObject({
      direction: 'In',
      sync: 'Async',
      durable: true,
      durability: { max_retries: 3, ordering: 'fifo' },
    });

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-hub-durable-resume-'));
    try {
      renderStandaloneScaffold({
        slug: PROGRAM_SLUG,
        name: PROGRAM_NAME,
        outDir: targetDir,
        synthesizedSpecYaml: specYaml,
        synthesizedRegistrationTs: artifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: {
          amend_approval: minimalStageSource('amend_approval'),
        },
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);

      const entry = await importProgramEntry(targetDir);
      const compiledChannel = entry.spec.schannels.get(ENTRY_CHANNEL);
      expect.soft(compiledChannel).toMatchObject({
        direction: 'In',
        sync: 'Async',
        durable: true,
        durability: { maxRetries: 3, ordering: 'fifo' },
      });

      const dbPath = join(targetDir, 'hub-resume.sqlite');
      const firstAuthor = scriptedAuthor([
        effect('begin_work', {}, channelForAction(parsed, 'begin_work')),
        effect('session_status', {}, channelForAction(parsed, 'session_status')),
        effect('session_status', {}, channelForAction(parsed, 'session_status')),
      ]);
      const first = await startRouteHarness({
        programs: [{ name: PROGRAM_SLUG, entry }],
        authorHandle: firstAuthor,
        observerModelId: 'hub-durable-resume-observer',
        storage: { dbPath, uploadsDir: join(targetDir, 'uploads') },
      });

      let checkpointId = '';
      let sessionId = '';
      try {
        const created = await first.client.sessions.create({ program: PROGRAM_SLUG });
        sessionId = created.sessionId;
        await first.client.sessions.trigger(sessionId, { channel: ENTRY_CHANNEL, payload: 'start finalization hub' });
        expect(modeOf(await first.client.sessions.get(sessionId))).toBe(HUB_STAGE);

        await patchState(first.client, sessionId, CHECKPOINT_STATE);
        const beforeCheckpoint = await readState(first.client, sessionId, Object.keys(CHECKPOINT_STATE));
        expect(beforeCheckpoint).toEqual(CHECKPOINT_STATE);

        const createdCheckpoint = await first.client.checkpoints.create(sessionId, { reason: 'Task 5 checkpoint' });
        checkpointId = checkpointIdFrom(createdCheckpoint);

        await patchState(first.client, sessionId, MUTATED_STATE);
        const afterMutation = await readState(first.client, sessionId, Object.keys(MUTATED_STATE));
        expect(afterMutation).toEqual(MUTATED_STATE);
      } finally {
        await first.close();
      }

      const resumedAuthor = scriptedAuthor([
        effect('session_status', {}, channelForAction(parsed, 'session_status')),
      ]);
      const resumed = await startRouteHarness({
        programs: [{ name: PROGRAM_SLUG, entry }],
        authorHandle: resumedAuthor,
        observerModelId: 'hub-durable-resume-observer-restarted',
        storage: { dbPath, uploadsDir: join(targetDir, 'uploads') },
      });

      try {
        const restored = await resumed.client.checkpoints.restore(sessionId, checkpointId);
        expect(modeOf(restored)).toBe(HUB_STAGE);

        const afterRestore = await readState(resumed.client, sessionId, Object.keys(CHECKPOINT_STATE));
        expect(afterRestore).toEqual(CHECKPOINT_STATE);

        await resumed.client.sessions.trigger(sessionId, {
          channel: ENTRY_CHANNEL,
          payload: 'continue after checkpoint restore',
        });
        expect(modeOf(await resumed.client.sessions.get(sessionId))).toBe(HUB_STAGE);
        expect(resumedAuthor.calls()).toEqual(['session_status']);
      } finally {
        await resumed.close();
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

interface ParsedSpec {
  features: string[];
  channels: Record<string, {
    direction: string;
    sync: string;
    durable?: boolean;
    durability?: { max_retries: number; ordering: string };
  }>;
  action_map: Record<string, { channel?: string }>;
}

type ScriptedAction = ReturnType<typeof effect>;

function hubDomain(): Record<string, unknown> {
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
    'program.design_path': 'design',
    'intake.purpose': 'Finalize a document through a long-lived durable conversational hub.',
    'intake.entry_channel': ENTRY_CHANNEL,
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: HUB_STAGE,
        kind: 'hub',
        archetype: 'conversational_hub',
        domain_spec: {
          reads: [
            'inputs.initial_user_text',
            SUMMARY_PATH,
            `${SECTIONS_PATH}.*.id`,
            `${SECTIONS_PATH}.*.heading`,
            `${SECTIONS_PATH}.*.status`,
            `${SECTIONS_PATH}.*.text`,
            AMENDMENT_RESULT_PATH,
            AMENDMENT_ITEMS_PATH,
            NOTE_PATH,
            'notebook_pins',
          ],
          produces: {},
          rules: ['Stay available across user turns until a branch or finalize action is explicit.'],
          invariants: ['Artifacts, amendment state, and notebook notes survive checkpoint restore.'],
        },
      },
      {
        slug: 'amend_approval',
        domain_spec: {
          reads: [SECTION_TEXT_PATH],
          produces: {
            result_json: { section_id: 'string', new_text: 'string', approved: 'boolean' },
            items_json: ['amendment:<section_id>'],
          },
          rules: ['Record one approved amendment and return to the hub.'],
          invariants: ['Do not finalize the document.'],
        },
      },
      { slug: COMPLETE_STAGE, is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: HUB_STAGE, trigger: 'started', guard_field: 'intake.started' },
      { from: HUB_STAGE, to: HUB_STAGE, trigger: 'stay' },
      { from: HUB_STAGE, to: 'amend_approval', trigger: 'amend', guard_field: AMENDMENT_GUARD_PATH },
      { from: 'amend_approval', to: HUB_STAGE, trigger: 'amended', guard_field: 'amend_approval.ready' },
      { from: HUB_STAGE, to: COMPLETE_STAGE, trigger: 'done', guard_field: 'finalization.done' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({
      final_stage: COMPLETE_STAGE,
      guard_field: 'finalization.done',
    }),
  };
}

function scriptedAuthor(actions: ScriptedAction[]) {
  let index = 0;
  const actionNames: string[] = [];
  return {
    modelId: 'hub-durable-resume-author',
    calls: () => [...actionNames],
    async complete() {
      const response = actions[index++];
      if (!response) {
        throw new Error(`no durable-resume author response scripted for call ${String(index - 1)}`);
      }
      const name = response.actions[0]?.name;
      if (typeof name === 'string') {
        actionNames.push(name);
      }
      return JSON.stringify(response);
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function minimalStageSource(stage: string): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, status: '${stage}_ready' }),
    items_json: JSON.stringify(['${stage}:ready']),
    digest: '',
  };
}
`;
}

async function patchState(
  client: PgasClient,
  sessionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await client.sessions.trigger(sessionId, { channel: TEST_STATE_CHANNEL, payload: state });
}

async function readState(
  client: PgasClient,
  sessionId: string,
  paths: string[],
): Promise<Record<string, unknown>> {
  const world = await client.sessions.world(sessionId);
  if (!isRecord(world) || !isRecord(world.domain)) {
    throw new Error(`unexpected world response: ${JSON.stringify(world)}`);
  }
  return Object.fromEntries(paths.map((path) => [path, world.domain[path]]));
}

function checkpointIdFrom(value: unknown): string {
  if (isRecord(value) && isRecord(value.checkpoint) && typeof value.checkpoint.checkpointId === 'string') {
    return value.checkpoint.checkpointId;
  }
  throw new Error(`checkpoint response missing checkpointId: ${JSON.stringify(value)}`);
}

function withTestStateChannel(specYaml: string, paths: string[]): string {
  const spec = load(specYaml) as ParsedSpec & {
    ingestion: Record<string, string[]>;
    modes: Record<string, { channels?: string[] }>;
  };
  spec.channels[TEST_STATE_CHANNEL] = { direction: 'In', sync: 'Async' };
  spec.ingestion[TEST_STATE_CHANNEL] = [...new Set(paths)];
  for (const mode of Object.values(spec.modes)) {
    mode.channels = [...new Set([...(mode.channels ?? []), TEST_STATE_CHANNEL])];
  }
  return dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
}

function channelForAction(spec: ParsedSpec, actionName: string): string {
  return spec.action_map[actionName]?.channel ?? 'widget_output';
}

function modeOf(envelope: unknown): string | null {
  if (!isRecord(envelope)) {
    return null;
  }
  if (typeof envelope.mode === 'string') {
    return envelope.mode;
  }
  if (isRecord(envelope.state) && typeof envelope.state.mode === 'string') {
    return envelope.state.mode;
  }
  return null;
}

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  return loadRenderedGeneratedProgramEntry(targetDir, PROGRAM_SLUG);
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
