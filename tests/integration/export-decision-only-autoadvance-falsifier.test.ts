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
    // The hook is scoped by MUTATION PATH, not left unscoped on OnTransition.
    // `runOnTransitionHooks` applies no mode/target-mode/predicate filter, so an
    // OnTransition hook dispatches once per mode change — measured at FOUR on this
    // very artifact (see the exactly-once assertion in the live drive below).
    // `AfterMutation` is the only hook event the engine scopes, and it binds to the
    // one-shot `<stage>.render_pending` write carried by the transition INTO the
    // export stage.
    expect(exportHooks).toEqual([
      expect.objectContaining({
        action: `render_${EXPORT_STAGE}_export`,
        event: 'AfterMutation',
        path: `${EXPORT_STAGE}.render_pending`,
        result_path: EXPORT_OUTPUT,
      }),
    ]);
    const entryActions = Object.entries(spec.action_map)
      .filter(([, a]) => ((a as { mutations?: Array<{ path?: string }> }).mutations ?? [])
        .some((m) => m.path === `${EXPORT_STAGE}.render_pending`))
      .map(([name]) => name);
    expect(entryActions, 'exactly one action arms the export render').toEqual(['complete_approve']);

    // and the OnTransition reaction that used to maintain `render_pending` as a
    // consumer-read suppression flag is GONE — no reaction writes that path.
    expect(Object.values(spec.reactions ?? {}).filter(
      (r) => (r.write_scope ?? []).includes(`${EXPORT_STAGE}.render_pending`),
    )).toEqual([]);
    expect(artifact.handlers_ts).toContain(`run${toPascalCase(EXPORT_STAGE)}`);
    expect(artifact.handlers_ts).toContain(`render_${EXPORT_STAGE}_export`);
    expect(artifact.handlers_ts).not.toContain(`async complete_${EXPORT_STAGE}`);
  });

  // ── EXISTING-GRAMMAR ROUTE AUDIT (owner directive: no new grammar until the
  //    behaviour is proven inexpressible with what already ships) ──────────────
  //
  // Integration hooks dispatch on exactly THREE events: AfterMutation (filtered
  // by `path` against `instructionSet.mutations` only), AfterRound (no filter),
  // and OnTransition (no filter). `AfterIngestion` is REACTION-only — the engine
  // has no `runAfterIngestionHooks`.
  //
  // `AfterMutation` is therefore the only event with ANY scoping, and
  // tests/integration/render-section-list-falsifier.test.ts `E-1` proves it DOES
  // yield exactly-once + content-complete when the hooked path is a ONE-SHOT
  // SCALAR that some action MSets at export-entry time.
  //
  // The real class had no such mutation to hook: its export-entry guard is an
  // engine-DERIVED aggregate (which `G-2a` observed can never trigger a hook), and
  // `complete_approve` shipped with `mutations: []`. The resolution keeps the
  // derived guard exactly as-is and adds ONE declared scalar for the hook to bind
  // to — so no new engine grammar was needed.
  it('E-3 (RESOLUTION): the aggregate guard stays engine-derived; a separate one-shot scalar arms the render', async () => {
    const artifact = await artifactFromDomain();
    const spec = load(artifact.spec_yaml) as {
      modes: Record<string, { vocabulary?: string[]; transitions?: Array<{ target: string; when?: Record<string, unknown> }> }>;
      action_map: Record<string, { mutations?: Array<{ op: string; path: string }> }>;
      derived_paths?: Array<{ target?: string; set?: { kind?: string } }>;
    };

    // (a) entry into the export stage is guarded by a COLLECTION-AGGREGATE
    //     predicate, not by a scalar flag any action flips.
    const toExport = (spec.modes.approve.transitions ?? []).find((t) => t.target === EXPORT_STAGE);
    expect(toExport?.when, 'export entry is an aggregate predicate over the collection').toMatchObject({
      kind: 'AllItemsStatus',
    });

    // (b) the aggregate guard field is a DERIVED path — and `G-2a` in the render
    //     falsifier OBSERVED that derived-path writes never trigger a hook,
    //     because runAfterMutationHooks matches instructionSet.mutations only.
    const derivedGuard = (spec.derived_paths ?? []).find((d) => d.target === ALL_TERMINAL);
    expect(derivedGuard?.set?.kind, 'the guard is engine-derived, not action-written').toBe('all_items_field_eq');

    // (c) NO action_map mutation anywhere writes the guard path.
    const guardWriters = Object.entries(spec.action_map)
      .filter(([, a]) => (a.mutations ?? []).some((m) => m.path === ALL_TERMINAL))
      .map(([name]) => name);
    expect(guardWriters, 'no action writes the export-entry guard').toEqual([]);

    // (d) the loop-exit action therefore cannot hook the guard itself — but it CAN
    //     carry its own one-shot scalar. That is the whole fix: `complete_approve`
    //     (which previously had `mutations: []`) now arms exactly one path, and the
    //     capability hook binds to THAT via AfterMutation. The aggregate guard above
    //     is untouched and stays engine-derived, so approval is still never
    //     re-derived outside the engine.
    expect(spec.modes.approve.vocabulary, 'the loop-exit action exists').toContain('complete_approve');
    expect(spec.action_map.complete_approve?.mutations ?? [], 'the loop-exit action arms the render exactly once')
      .toEqual([{ op: 'MSet', path: `${EXPORT_STAGE}.render_pending`, value: true }]);
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
        // ⚠ D-1 (DEFECT PINNED, simodelne/pgas#1087) — this count is WRONG, and it is
        // asserted here deliberately so the defect is recorded rather than invisible.
        //
        // The drive approves one section carrying APPROVED-OPINION-BODY, so the
        // deliverable should contain exactly ONE section with that prose. Instead
        // `section_count` is 3 and the bytes carry three identical copies of a raw
        // stage-metadata dump, with the approved prose ABSENT entirely.
        //
        // Cause: the confirmation loop declares `storage.representation: indexed_array`,
        // so `items_where_field_eq` over it hits
        // `if (!Array.isArray(collection)) return []` (create-server.mjs:17369-17385)
        // and EVERY `summary.confirmation_loop.status_buckets.*` is empty even though
        // `work.opinion_sections.items.0.status === 'accepted'`. With no approved items,
        // the emitted TS falls through to its domain-scan fallback and dumps stage
        // metadata as "content".
        //
        // WHEN #1087 SHIPS THIS FAILS. That is the intended trigger for the render
        // 0-TS migration: at that point bind `render: section_list` to the (now
        // correctly populated) accepted bucket, delete the shape-mapping TS, and
        // replace these assertions with the content assertions below.
        expect(result.section_count, 'DEFECT: metadata dump, not the deliverable — see #1087').toBe(3);
        expect(acceptedBucketOf(completed.domain), 'DEFECT: accepted bucket empty despite an accepted item')
          .toEqual([]);
        expect(String(completed.domain['work.opinion_sections.items.0.status']), 'the item really is accepted')
          .toBe('accepted');

        // The strongest form of the pin: assert against the BYTES, not a count.
        // The export writes STORE (uncompressed) OOXML, so authored text appears
        // verbatim in the payload.
        const docxText = Buffer.from(result.docx_base64, 'base64').toString('latin1');
        expect(docxText, 'DEFECT: the approved prose is MISSING from the deliverable (#1087)')
          .not.toContain('APPROVED-OPINION-BODY');
        expect(docxText, 'DEFECT: internal stage metadata is emitted as deliverable content (#1087)')
          .toContain('drafting_status');

        // EXACTLY-ONCE, measured on the real confirmation-loop artifact with NO
        // consumer-side dispatch filter and NO OnTransition reaction: the hook is
        // declared `AfterMutation` on the one-shot `<stage>.render_pending` write
        // carried by the transition INTO the export stage.
        expect(exportDispatches.count, 'the export hook dispatched exactly once').toBe(1);
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

// Dispatch cardinality on the REAL generated artifact is otherwise unobservable:
// the engine does not log hook fires, and a second dispatch would simply overwrite
// the same `result_path`. So the generated export adapter is wrapped and counted.
const exportDispatches = { count: 0 };

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  exportDispatches.count = 0;
  return loadRenderedGeneratedProgramEntry(targetDir, PROGRAM_SLUG, {
    wrapAdapterOverrides: (overrides) => {
      const wrapped: typeof overrides = { ...overrides };
      for (const [channel, override] of Object.entries(overrides)) {
        if (!channel.includes('export')) continue;
        const inner = override as { dispatch?: (p: unknown) => Promise<unknown> };
        if (typeof inner.dispatch !== 'function') continue;
        const original = inner.dispatch.bind(inner);
        wrapped[channel] = {
          ...override,
          async dispatch(payload: unknown) {
            const result = await original(payload);
            // count only dispatches this adapter actually SERVICED — an unrelated
            // hook action returns undefined without rendering.
            if (result !== undefined) exportDispatches.count += 1;
            return result;
          },
        } as typeof override;
      }
      return wrapped;
    },
  });
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

function acceptedBucketOf(domain: Record<string, unknown>): unknown[] {
  const bucket = domain['summary.confirmation_loop.status_buckets.accepted'];
  return Array.isArray(bucket) ? bucket : [];
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
