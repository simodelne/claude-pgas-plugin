import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

const PROGRAM_SLUG = 'confirmation-terminal-advance';
const PROGRAM_NAME = 'Confirmation Terminal Advance';

const confirmationLifecycle = {
  version: 1,
  name: 'work_units',
  item_label: 'work unit',
  storage: {
    items_path: 'work_units.items',
    event_path: 'work_units.pending_event_json',
    violation_path: 'work_units.lifecycle_violation_json',
    representation: 'indexed_array',
  },
  item: {
    id_field: 'id',
    status_field: 'status',
    schema: {
      id: 'string',
      title: 'string',
      proposed_text: 'string',
      user_instruction: 'string',
    },
  },
  statuses: [
    { name: 'pending', initial: true },
    { name: 'proposed' },
    { name: 'accepted', terminal: true },
    { name: 'skipped', terminal: true },
  ],
  transitions: [],
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'skipped'],
    require_non_empty: true,
  },
};

const confirmationLoop = {
  collection: 'work_units.items',
  proposed_status: 'proposed',
  seed: { source_stage: 'plan_work', id_prefix: 'unit' },
  decisions: {
    approve: { to: 'accepted' },
    revise: {
      to: 'proposed',
      requires_instruction: true,
      instruction_path: 'work_units.items.*.user_instruction',
      re_propose: true,
    },
    skip: { to: 'skipped' },
  },
  one_proposed_at_a_time: true,
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'skipped'],
  },
  stage: 'review_work',
  summary_path: 'summary.confirmation_loop',
  violation_path: 'work_units.confirmation_violation_json',
  pending_action_path: 'decisions.pending_review_work_action',
};

describe('confirmation-loop terminal advance falsifier', () => {
  it('advances from an all-terminal confirmation loop into the downstream gated stage before completing', { timeout: 120_000 }, async () => {
    const artifact = artifactFromDomain(terminalAdvanceDomain());
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-confirmation-terminal-advance-'));
    const author = scriptedAuthor([
      effect('begin_work', {}),
      effect('complete_plan_work', {
        result_json: JSON.stringify({ planned: true }),
        items_json: JSON.stringify([
          { id: 'wu-1', title: 'Confirm first clause' },
          { id: 'wu-2', title: 'Confirm second clause' },
        ]),
      }),
      effect('propose_item', { proposed_text: 'First approved clause.' }),
      effect('propose_item', { proposed_text: 'Second approved clause.' }),
      effect('complete_review_work', {}),
      effect('complete_assemble_work', {
        result_json: JSON.stringify({ assembled: true }),
        items_json: JSON.stringify(['assembled:work_units']),
      }),
    ]);

    try {
      renderStandaloneScaffold({
        slug: PROGRAM_SLUG,
        name: PROGRAM_NAME,
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);

      const server = await createPgasServer({
        programs: [{ name: PROGRAM_SLUG, entry: await importProgramEntry(targetDir) }],
        drivers: {
          authorHandle: author,
          observerHandle: {
            modelId: 'confirmation-terminal-advance-observer',
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
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start terminal advance test' });
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'plan confirmation items' });
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'propose first item' });
        await client.sessions.trigger(sessionId, { channel: 'user_confirmation', payload: { decision: 'approve' } });
        await client.sessions.trigger(sessionId, { channel: 'user_confirmation', payload: { decision: 'approve' } });

        const terminalLoop = await readSnapshot(client, sessionId);
        expect(terminalLoop.domain['work_units.all_terminal']).toBe(true);

        const advanced = await readSnapshot(client, sessionId);
        expect(advanced.mode).toBe('assemble_work');

        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'assemble confirmed work' });
        const completed = await readSnapshot(client, sessionId);
        expect(completed.mode).toBe('complete');
        expect(completed.running).toBe(false);
        expect(completed.domain['assemble_work.result_json']).toBe(JSON.stringify({ assembled: true }));
        expect(author.calls()).toEqual([
          'begin_work',
          'complete_plan_work',
          'propose_item',
          'propose_item',
          'complete_review_work',
          'complete_assemble_work',
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

function terminalAdvanceDomain(): Record<string, unknown> {
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
    'program.design_path': 'design',
    'intake.purpose': 'Plan two work units, confirm each item explicitly, assemble the approved set, and complete.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'plan_work' },
      { slug: 'review_work' },
      { slug: 'assemble_work' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'plan_work', trigger: 'started', guard_field: 'intake.started' },
      { from: 'plan_work', to: 'review_work', trigger: 'planned', guard_field: 'plan_work.done' },
      { from: 'review_work', to: 'assemble_work', trigger: 'reviewed', guard_field: 'work_units.all_terminal' },
      { from: 'assemble_work', to: 'complete', trigger: 'assembled', guard_field: 'assemble_work.done' },
    ]),
    'intake.delegation_json': JSON.stringify({
      plan_work: { kind: 'llm-reasoning' },
      assemble_work: { kind: 'llm-reasoning' },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'assemble_work.done',
      collection_lifecycle: confirmationLifecycle,
    }),
    'intake.interaction_json': JSON.stringify({ confirmation_loops: [confirmationLoop] }),
  };
}

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  const module = await import(pathToFileURL(join(targetDir, `src/programs/${PROGRAM_SLUG}/registration.ts`)).href) as Record<string, unknown>;
  const createEntry = Object.values(module).find((value): value is () => ProgramEntry =>
    typeof value === 'function' && /^create[A-Z].*ProgramEntry$/u.test(value.name));
  if (!createEntry) {
    throw new Error(`generated registration did not export a create*ProgramEntry function: ${Object.keys(module).join(', ')}`);
  }
  return createEntry();
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
    modelId: 'confirmation-terminal-advance-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no confirmation terminal advance response scripted for call ${String(index - 1)}`);
      }
      const actionName = response.actions[0]?.name;
      if (actionName) {
        calls.push(actionName);
      }
      return JSON.stringify(response);
    },
    calls: () => [...calls],
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction' as const, name, channel, payload }] };
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}
