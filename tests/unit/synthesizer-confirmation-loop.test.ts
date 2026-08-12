import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns, type ReactionHandler, type ReactionResult } from '@simodelne/pgas-server/plugin.js';
import { assertConfirmationPairingTerminals } from '../../src/foundry-program/composite-checks.js';
import {
  createConfirmationLoopChoreographCollectionReaction,
  createConfirmationLoopEnforceStatusReaction,
  createConfirmationLoopSaveDecisionReaction,
  synthesizeProgramSpecFromDomain,
  type SynthesizedSpec,
} from '../../src/foundry-program/synthesizer.js';
import { loadGeneratedReactionHandlers } from './generated-handlers-loader.js';

const baseDomain = {
  'program.slug': 'work-unit-flow',
  'program.name': 'Work Unit Flow',
  'program.target_dir': '/tmp/work-unit-flow',
  'program.design_path': 'design',
  'intake.purpose': 'Move generic work units through review until completion.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'review_work' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'review_work', trigger: 'started', guard_field: 'intake.started' },
    { from: 'review_work', to: 'complete', trigger: 'done', guard_field: 'work_units.all_terminal' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'work_units.all_terminal' }),
};

const indexedLifecycle = {
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

interface ParsedSpec {
  features?: string[];
  terminal: string[];
  channels: Record<string, {
    direction: string;
    sync: string;
    structured_decision?: boolean;
    decision_targeting?: Record<string, unknown>;
  }>;
  confirmation_pairing?: {
    prefixes: string[];
    policy: string;
    terminals?: string[];
  };
  modes: Record<string, {
    channels?: string[];
    vocabulary?: string[];
    transitions?: Array<{ target: string; guard?: Record<string, unknown> }>;
    preconditions?: Record<string, Array<Record<string, unknown>>>;
  }>;
  projection: Record<string, { include: string[]; exclude: string[] }>;
  schema: Record<string, string>;
  prompts: Record<string, string>;
  guidance: Record<string, string[]>;
  recovery_steers?: Array<{
    mode: string;
    when: Record<string, unknown>;
    guidance?: string;
    set?: { path: string; value: unknown };
    template_paths?: string[];
  }>;
  no_action_escapes?: Array<{
    mode: string;
    counter: string;
    cap: number;
    arm: string;
    guidance?: string;
  }>;
  derived_paths?: Array<{
    target: string;
    when: { always: true } | { path_truthy: { path: string } } | { path_equals: { path: string; value: unknown } };
    set: {
      kind: string;
      params?: {
        collection_path?: string;
        field?: string;
        value?: unknown;
        order?: { kind: string; path?: string };
      };
    };
  }>;
  ingestion: Record<string, string[]>;
  proceed_to: Record<string, string>;
  reactions: Record<string, { event: string; watch?: string[]; write_scope: string[] }>;
  action_map: Record<string, {
    channel?: string;
    description?: string;
    result_path?: string;
    awaits_user_decision?: { channel: string; intent?: string };
    arg_schema?: Record<string, { type?: string; required?: boolean }>;
    mutations?: Array<{ op: string; path: string; value?: unknown; from_arg?: string }>;
  }>;
}

describe('confirmation_loop descriptor synthesis', () => {
  it('gates propose_item before terminal and completion after terminal before a downstream stage', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoopThenDownstream());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.modes.review_work.transitions).toEqual(expect.arrayContaining([
      { target: 'assemble_work', guard: { kind: 'AllItemsStatus', path: 'work_units.items_terminal_status', value: true } },
    ]));
    expect(parsed.action_map.propose_item.awaits_user_decision).toEqual({
      channel: 'user_confirmation',
      intent: 'present_for_approval',
    });
    expect(parsed.action_map.complete_review_work).toMatchObject({
      channel: 'widget_output',
      mutations: [],
    });
    expect(parsed.action_map.complete_review_work.awaits_user_decision).toBeUndefined();
    expect(parsed.proceed_to.complete_review_work).toBe('assemble_work');
    expect(parsed.modes.review_work.vocabulary).toEqual(expect.arrayContaining([
      'propose_item',
      'complete_review_work',
    ]));
    expect(parsed.modes.review_work.preconditions?.propose_item).toEqual([
      { kind: 'FieldFalsy', path: 'work_units.all_terminal' },
      {
        kind: 'Implies',
        subs: [
          { kind: 'FieldTruthy', path: 'summary.confirmation_loop.active_item_id' },
          {
            kind: 'PreviousItemFieldEquals',
            path: 'work_units.items_terminal_status',
            cursor: 'summary.confirmation_loop.active_item_id',
            value: true,
            order: { kind: 'plan_array' },
          },
        ],
      },
      { kind: 'FieldFalsy', path: 'review_work.no_action_escape.work_units_items.arm' },
    ]);
    expect(parsed.modes.review_work.preconditions?.complete_review_work).toEqual([
      { kind: 'AllItemsStatus', path: 'work_units.items_terminal_status', value: true },
    ]);
    expect(parsed.prompts.review_work).toContain('call complete_review_work exactly once to advance downstream');
    expect(parsed.features).toEqual(expect.arrayContaining(['recovery_steer']));
    expect(parsed.recovery_steers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'review_work',
        when: { kind: 'FieldTruthy', path: 'work_units.all_terminal' },
        guidance: 'When work_units.all_terminal is true, all items are resolved; call complete_review_work exactly once to advance downstream, and do not call propose_item again or open another confirmation prompt.',
      }),
    ]));
    expect(parsed.guidance.review_work).not.toEqual(expect.arrayContaining([
      expect.stringContaining('When work_units.all_terminal is true'),
    ]));
  });

  it('emits richer recovery steers for completion guard arming and active-item templating', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoopThenDownstream());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.recovery_steers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'review_work',
        when: { kind: 'FieldTruthy', path: 'work_units.all_terminal' },
        guidance: 'When work_units.all_terminal is true, all items are resolved; call complete_review_work exactly once to advance downstream, and do not call propose_item again or open another confirmation prompt.',
        set: { path: 'work_units.all_terminal', value: true },
      }),
      {
        mode: 'review_work',
        when: {
          kind: 'All',
          subs: [
            { kind: 'FieldTruthy', path: 'summary.confirmation_loop.active_item_id' },
            { kind: 'FieldFalsy', path: 'work_units.all_terminal' },
          ],
        },
        guidance: 'Handle {{summary.confirmation_loop.active_item_id}} next with propose_item; use summary.confirmation_loop.active_item as the bounded work unit view and do not inspect work_units.items.',
        template_paths: ['summary.confirmation_loop.active_item_id'],
      },
    ]));
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('emits no_action_escapes for confirmation-loop author stalls and wires the arm to a blocked transition', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoopThenDownstream());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;
    const escape = {
      mode: 'review_work',
      counter: 'review_work.no_action_escape.work_units_items.counter',
      cap: 3,
      arm: 'review_work.no_action_escape.work_units_items.arm',
    };
    const blockedMode = 'review_work_no_action_blocked';
    const blockedAction = 'route_review_work_no_action_blocked';
    const blockedPredicate = {
      kind: 'All',
      subs: [
        { kind: 'FieldTruthy', path: escape.arm },
        { kind: 'FieldFalsy', path: 'work_units.all_terminal' },
      ],
    };

    expect(parsed.features).toEqual(expect.arrayContaining(['no_action_escape']));
    expect(parsed.no_action_escapes).toEqual([
      expect.objectContaining({
        ...escape,
        guidance: expect.stringContaining('review_work is waiting for propose_item'),
      }),
    ]);
    expect(parsed.schema[escape.counter]).toBe('number');
    expect(parsed.schema[escape.arm]).toBe('boolean');
    expect(parsed.terminal).toEqual(expect.arrayContaining([blockedMode]));
    expect(parsed.modes[blockedMode]).toMatchObject({
      transitions: [],
    });
    expect(parsed.modes.review_work.transitions).toEqual(expect.arrayContaining([
      { target: blockedMode, guard: blockedPredicate },
    ]));
    expect(parsed.modes.review_work.vocabulary).toEqual(expect.arrayContaining([blockedAction]));
    expect(parsed.modes.review_work.preconditions?.[blockedAction]).toEqual([
      { kind: 'FieldTruthy', path: escape.arm },
      { kind: 'FieldFalsy', path: 'work_units.all_terminal' },
    ]);
    expect(parsed.modes.review_work.preconditions?.propose_item).toEqual(expect.arrayContaining([
      { kind: 'FieldFalsy', path: escape.arm },
    ]));
    expect(parsed.action_map[blockedAction]).toMatchObject({
      channel: 'widget_output',
      mutations: [],
    });
    expect(parsed.proceed_to[blockedAction]).toBe(blockedMode);
    expect(declaredWriterCount(parsed, escape.counter)).toBe(1);
    expect(declaredWriterCount(parsed, escape.arm)).toBe(1);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('KILL TEST: no_action_escape counter and arm fail 4.2.0 load when another surface writes them', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoopThenDownstream());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;
    const escape = parsed.no_action_escapes?.[0];
    if (!escape) throw new Error('expected confirmation-loop no_action_escape');
    parsed.action_map.propose_item.mutations = [
      ...(parsed.action_map.propose_item.mutations ?? []),
      { op: 'MSet', path: escape.arm, value: false },
    ];

    expect(() => loadSpecWithPatterns(writeTempSpec(dump(parsed, { lineWidth: -1, noRefs: true, sortKeys: false }))))
      .toThrow(/NA-4: no_action_escapes\[0\]\.arm/u);
  });

  it('emits engine-derived completion and cursor paths for confirmation loops', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoop());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.derived_paths).toEqual(expect.arrayContaining([
      {
        target: 'work_units.all_terminal',
        when: { always: true },
        set: {
          kind: 'all_items_field_eq',
          params: {
            collection_path: 'work_units.items_terminal_status',
            field: 'status',
            value: true,
          },
        },
      },
      {
        target: 'summary.confirmation_loop.active_item_id',
        when: { always: true },
        set: {
          kind: 'first_item_where_field_ne',
          params: {
            collection_path: 'work_units.items_terminal_status',
            field: 'status',
            value: true,
            order: { kind: 'plan_array' },
          },
        },
      },
      {
        target: 'summary.confirmation_loop.has_proposed_item',
        when: { always: true },
        set: {
          kind: 'any_item_field_eq',
          params: {
            collection_path: 'work_units.items',
            field: 'status',
            value: 'proposed',
          },
        },
      },
      {
        target: 'summary.confirmation_loop.status_buckets.accepted',
        when: { always: true },
        set: {
          kind: 'items_where_field_eq',
          params: {
            collection_path: 'work_units.items',
            field: 'status',
            value: 'accepted',
          },
        },
      },
      {
        target: 'summary.confirmation_loop.status_buckets.skipped',
        when: { always: true },
        set: {
          kind: 'items_where_field_eq',
          params: {
            collection_path: 'work_units.items',
            field: 'status',
            value: 'skipped',
          },
        },
      },
    ]));
    expect(parsed.schema).toMatchObject({
      'work_units.items.*.__terminal': 'boolean',
      'work_units.items_terminal_status': 'array',
      'work_units.items_terminal_status.*': 'object',
      'work_units.items_terminal_status.*.id': 'string',
      'work_units.items_terminal_status.*.status': 'boolean',
      'summary.confirmation_loop.active_item_id': 'any',
      'summary.confirmation_loop.has_proposed_item': 'boolean',
      'summary.confirmation_loop.status_buckets': 'object',
      'summary.confirmation_loop.status_buckets.accepted': 'array',
      'summary.confirmation_loop.status_buckets.accepted.*': 'object',
      'summary.confirmation_loop.status_buckets.skipped': 'array',
      'summary.confirmation_loop.status_buckets.skipped.*': 'object',
      'work_units.all_terminal': 'boolean',
    });
    expect(parsed.modes.review_work.preconditions?.propose_item).toEqual(expect.arrayContaining([
      {
        kind: 'Implies',
        subs: [
          { kind: 'FieldTruthy', path: 'summary.confirmation_loop.active_item_id' },
          {
            kind: 'PreviousItemFieldEquals',
            path: 'work_units.items_terminal_status',
            cursor: 'summary.confirmation_loop.active_item_id',
            value: true,
            order: { kind: 'plan_array' },
          },
        ],
      },
    ]));
    expect(parsed.reactions.enforce_review_work_status.write_scope).not.toContain('work_units.all_terminal');
    expect(artifact.handlers_ts).not.toContain("path: 'work_units.all_terminal', value: allTerminal");
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('emits user_confirmation targeting, confirmation_pairing, propose_item, and an engine-valid spec', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoop());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.channels.user_confirmation).toEqual({
      direction: 'In',
      sync: 'Async',
      structured_decision: true,
      decision_targeting: {
        collection: 'work_units.items',
        status_field: 'status',
        status_equals: 'proposed',
        select: 'first',
        index_path: 'inputs.user_decision.target_item_index',
        id_path: 'inputs.user_decision.target_item_id',
        title_path: 'inputs.user_decision.target_item_title',
        status_path: 'inputs.user_decision.target_item_status',
      },
    });
    expect(parsed.ingestion.user_confirmation).toEqual([
      'inputs.user_decision',
      'inputs.user_decision.decision',
      'inputs.user_decision.instruction',
      'inputs.user_decision.note_mode',
      'inputs.user_decision.timestamp',
      'inputs.user_decision.target_item_index',
      'inputs.user_decision.target_item_id',
      'inputs.user_decision.target_item_title',
      'inputs.user_decision.target_item_status',
    ]);
    const pairing = parsed.confirmation_pairing;
    expect(pairing).toEqual({
      prefixes: ['work_units.items'],
      policy: 'reject',
      terminals: expect.arrayContaining(['propose_item', 'approve_item', 'request_revision_item', 'reject_item']),
    });
    expect(pairing?.terminals).not.toEqual(expect.arrayContaining(['revise_item', 'skip_item']));
    expect(parsed.action_map.propose_item.awaits_user_decision).toEqual({
      channel: 'user_confirmation',
      intent: 'present_for_approval',
    });
    expect(parsed.action_map.propose_item.description).toContain('The runtime selects which work unit is under review');
    expect(parsed.action_map.propose_item.description).toContain('must author the work unit content in proposed_text');
    expect(parsed.action_map.propose_item.description).toContain('payload: {"proposed_text":"<the drafted section text>"}');
    expect(parsed.action_map.propose_item.description).toContain('top-level payload fields, not payload.mutations');
    expect(parsed.action_map.propose_item.description).not.toMatch(/do not attempt to pick or write items/iu);
    expect(parsed.action_map.propose_item.mutations).toEqual([
      { op: 'MSet', path: 'review_work.proposal.raw_payload_mutations', value: [], from_arg: 'mutations' },
      { op: 'MSet', path: 'review_work.proposal.proposed_text', value: '', from_arg: 'proposed_text' },
      { op: 'MAppend', path: 'review_work.proposal.log', value: 'proposed' },
    ]);
    expect(parsed.action_map.propose_item.arg_schema).toEqual({
      proposed_text: { type: 'string', required: true },
    });
    expect(parsed.action_map.propose_item.arg_schema).not.toHaveProperty('mutations');
    expect(parsed.action_map.complete_review_work).toMatchObject({
      description: expect.stringContaining('Advance from confirmation-loop stage review_work to complete'),
      mutations: [],
      channel: 'widget_output',
    });
    expect(parsed.proceed_to.complete_review_work).toBe('complete');
    expect(parsed.modes.review_work.vocabulary).toEqual([
      'propose_item',
      'complete_review_work',
      'record_note',
      'pin_note',
      'unpin_note',
      'delete_note',
      'session_new',
      'session_abort_current',
      'session_status',
      'session_history',
      'session_resume',
      'session_help',
      'route_review_work_no_action_blocked',
    ]);
    expect(parsed.modes.review_work.channels).toEqual(expect.arrayContaining(['user_confirmation', 'widget_output']));
    expect(parsed.projection.review_work.include).toEqual(expect.arrayContaining([
      'inputs.user_decision.target_item_index',
      'work_units.all_terminal',
      'summary.confirmation_loop',
      'summary.confirmation_loop.active_item',
      'summary.confirmation_loop.active_item_id',
      'summary.confirmation_loop.has_proposed_item',
      'summary.confirmation_loop.status_buckets.accepted',
      'summary.confirmation_loop.status_buckets.skipped',
      'summary.confirmation_loop.total_items',
      'summary.confirmation_loop.terminal_items',
      'summary.confirmation_loop.pending_items',
      'summary.confirmation_loop.current_index',
    ]));
    expect(parsed.projection.review_work.include).not.toContain('work_units.items');
    expect(parsed.projection.review_work.include).not.toContain('work_units.items.*.id');
    expect(parsed.projection.review_work.include).not.toContain('work_units.items.*.title');
    expect(parsed.projection.review_work.include).not.toContain('work_units.items.*.status');
    expect(parsed.projection.review_work.include).not.toContain('plan_work.items_json');
    expect(parsed.reactions.save_review_work_decision).toEqual({
      event: 'AfterIngestion',
      watch: [
        'inputs.user_decision.decision',
        'inputs.user_decision.instruction',
        'inputs.user_decision.timestamp',
        'inputs.user_decision.target_item_index',
      ],
      write_scope: ['decisions.pending_review_work_action'],
    });
    expect(parsed.reactions.enforce_review_work_status).toEqual({
      event: 'AfterIngestion',
      watch: ['inputs.user_decision.decision', 'inputs.user_decision.timestamp'],
      write_scope: [
        'work_units.items.*.status',
        'work_units.items.*.__terminal',
        'work_units.items_terminal_status.*.status',
        'work_units.items.*.user_instruction',
        'work_units.confirmation_violation_json',
        'summary.confirmation_loop.one_proposed_demotions',
        'summary.confirmation_loop.last_applied_decision',
      ],
    });
    expect(parsed.reactions.summarize_review_work_approval).toEqual({
      event: 'AfterIngestion',
      watch: [
        'inputs.mode_entry.mode',
        'inputs.user_text',
        'inputs.user_decision.decision',
        'inputs.user_decision.timestamp',
      ],
      write_scope: ['summary.confirmation_loop'],
    });
    expect(parsed.reactions.mirror_review_work_proposal_payload).toEqual({
      event: 'AfterMutation',
      watch: ['review_work.proposal.raw_payload_mutations'],
      write_scope: ['review_work.proposal.proposed_text'],
    });
    expect(parsed.reactions.choreograph_review_work_collection).toEqual({
      event: 'AfterRound',
      watch: [],
      write_scope: [
        'work_units.items.*',
        'work_units.items_terminal_status',
        'summary.confirmation_loop.applied_proposal_count',
        'summary.confirmation_loop.seed_state',
      ],
    });
    expect(Object.keys(parsed.reactions).indexOf('save_review_work_decision')).toBeLessThan(
      Object.keys(parsed.reactions).indexOf('enforce_review_work_status'),
    );
    expect(Object.keys(parsed.reactions).indexOf('enforce_review_work_status')).toBeLessThan(
      Object.keys(parsed.reactions).indexOf('summarize_review_work_approval'),
    );
    expect(Object.keys(parsed.reactions).indexOf('summarize_review_work_approval')).toBeLessThan(
      Object.keys(parsed.reactions).indexOf('mirror_review_work_proposal_payload'),
    );
    expect(Object.keys(parsed.reactions).indexOf('mirror_review_work_proposal_payload')).toBeLessThan(
      Object.keys(parsed.reactions).indexOf('choreograph_review_work_collection'),
    );
    expect(parsed.schema).toMatchObject({
      'review_work.proposal': 'object',
      'review_work.proposal.raw_payload_mutations': 'any',
      'review_work.proposal.proposed_text': 'string',
      'review_work.proposal.log': 'array',
      'summary.confirmation_loop.active_item': 'object',
      'summary.confirmation_loop.active_item_id': 'any',
      'summary.confirmation_loop.active_item.id': 'string',
      'summary.confirmation_loop.active_item.title': 'string',
      'summary.confirmation_loop.active_item.status': 'string',
      'summary.confirmation_loop.has_proposed_item': 'boolean',
      'summary.confirmation_loop.status_buckets': 'object',
      'summary.confirmation_loop.status_buckets.accepted': 'array',
      'summary.confirmation_loop.status_buckets.accepted.*': 'object',
      'summary.confirmation_loop.status_buckets.skipped': 'array',
      'summary.confirmation_loop.status_buckets.skipped.*': 'object',
      'summary.confirmation_loop.total_items': 'number',
      'summary.confirmation_loop.terminal_items': 'number',
      'summary.confirmation_loop.pending_items': 'number',
      'summary.confirmation_loop.current_index': 'number',
      'summary.confirmation_loop.applied_proposal_count': 'number',
      'summary.confirmation_loop.seed_state': 'string',
    });
    expect(parsed.prompts.review_work).toContain('Work through the work units one at a time');
    expect(parsed.prompts.review_work).toContain('Respond with EXACTLY ONE terminal action');
    expect(parsed.prompts.review_work).toContain('Valid terminal action JSON example: {"actions":[{"kind":"EffectAction","name":"propose_item","channel":"widget_output","payload":{"proposed_text":"<the drafted section text>"}}]}');
    expect(parsed.prompts.review_work).toContain('Emit exactly ONE such terminal action; do not emit raw MutationActions for a named action.');
    expect(parsed.prompts.review_work).toContain('emit the proposal content as top-level payload fields, not payload.mutations');
    expect(parsed.prompts.review_work).toContain('do not emit an empty proposed_text');
    expect(parsed.prompts.review_work).not.toContain('"payload":{}}');
    expect(parsed.prompts.review_work).toContain('the runtime selects that item');
    expect(parsed.prompts.review_work).toContain('use its active_item and progress counts');
    expect(parsed.guidance.review_work).toEqual(expect.arrayContaining([
      expect.stringContaining('Respond with EXACTLY ONE terminal action'),
      expect.stringContaining('Valid terminal action JSON example: {"actions":[{"kind":"EffectAction","name":"propose_item","channel":"widget_output","payload":{"proposed_text":"<the drafted section text>"}}]}'),
      expect.stringContaining('Emit exactly ONE such terminal action; do not emit raw MutationActions for a named action.'),
      expect.stringContaining('emit the proposal content as top-level payload fields, not payload.mutations'),
      expect.stringContaining('do not emit an empty proposed_text'),
      expect.stringContaining('never write item statuses yourself'),
      expect.stringContaining('summary.confirmation_loop.active_item'),
      expect.stringContaining('not the full work_units.items collection'),
    ]));
    expect(artifact.handlers_ts).toContain("['save_review_work_decision', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("['enforce_review_work_status', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("['summarize_review_work_approval', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("['choreograph_review_work_collection', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain('"request_revision"');
    expect(artifact.handlers_ts).toContain('"reject"');
    expect(artifact.handlers_ts).toContain('reconstructArray(Object.fromEntries(snapshot), itemsPath)');
    expect(artifact.smoke_test_ts).toContain('runs the confirmation loop choreography hermetically');
    expect(artifact.smoke_test_ts).toContain("title: 'Verify Pre-Launch System Health Checks'");
    expect(artifact.smoke_test_ts).toContain("status: 'pending_review'");
    expect(artifact.smoke_test_ts).not.toContain('complete_review_work');
    // Regression (confirmation live-drive RED, 2026-07-16 — SpecWiringError
    // HANDLER_NO_ACTION): terminal completion is a declarative spec action only,
    // so handlers_ts/tools_ts must NOT emit an orphaned complete_review_work
    // handler/tool. loadSpecWithPatterns does not run the engine's
    // validateSpecWiring; createPgasServer boot (and the live-drive) does.
    expect(artifact.handlers_ts).not.toContain('complete_review_work');
    expect(artifact.tools_ts).not.toContain('complete_review_work');
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
    expect(() => assertConfirmationPairingTerminals(parsed)).not.toThrow();
  });

  it('projects upstream analysis summaries and active item fields into confirmation-loop proposal drafting without full collection blowup', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithAnalysisLoop());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;
    const approveInclude = parsed.projection.approve.include;

    expect(approveInclude).toEqual(expect.arrayContaining([
      'intake_facts.result_json',
      'dd_dispatch.result_json',
      'issue_analysis.result_json',
      'draft_sections.result_json',
      'work.opinion_sections.confirmation_summary.active_item',
      'work.opinion_sections.confirmation_summary.active_item.title',
      'work.opinion_sections.confirmation_summary.active_item.section_kind',
      'work.opinion_sections.confirmation_summary.active_item.template_anchor',
      'inputs.user_decision.target_item_index',
      'work.opinion_sections.all_terminal',
    ]));
    expect(approveInclude.filter((path) =>
      path === 'work.opinion_sections.items' ||
      path.startsWith('work.opinion_sections.items.*.'))).toEqual([]);
    expect(approveInclude.length).toBeLessThanOrEqual(45);

    expect(parsed.prompts.approve).toContain('issue_analysis');
    expect(parsed.prompts.approve).toMatch(/blank or generic/u);
    expect(parsed.guidance.approve.join('\n')).toContain('issue_analysis');
    expect(parsed.guidance.approve.join('\n')).toMatch(/blank or generic/u);
    expect(parsed.action_map.propose_item.description).toContain(
      'payload: {"proposed_text":"<the drafted section text>","section_kind":"...","template_anchor":"..."}',
    );
    expect(parsed.action_map.propose_item.mutations).toEqual(expect.arrayContaining([
      { op: 'MSet', path: 'approve.proposal.raw_payload_mutations', value: [], from_arg: 'mutations' },
      { op: 'MSet', path: 'approve.proposal.proposed_text', value: '', from_arg: 'proposed_text' },
      { op: 'MSet', path: 'approve.proposal.section_kind', value: '', from_arg: 'section_kind' },
      { op: 'MSet', path: 'approve.proposal.template_anchor', value: '', from_arg: 'template_anchor' },
    ]));
    expect(parsed.reactions.mirror_approve_proposal_payload).toEqual({
      event: 'AfterMutation',
      watch: ['approve.proposal.raw_payload_mutations'],
      write_scope: [
        'approve.proposal.proposed_text',
        'approve.proposal.section_kind',
        'approve.proposal.template_anchor',
      ],
    });
  });

  it('records user decisions and enforces approve, request_revision, reject, demotion, and aggregate status', () => {
    const save = createConfirmationLoopSaveDecisionReaction(confirmationLoop, indexedLifecycle);
    const enforce = createConfirmationLoopEnforceStatusReaction(confirmationLoop, indexedLifecycle);

    const approved = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'pending' },
    ], savedPending(save, 'approve', 0));
    expect(approved.valueAt('work_units.items.0.status')).toBe('accepted');
    expect(approved.valueAt('work_units.items.0.__terminal')).toBe(true);
    expect(approved.valueAt('work_units.items_terminal_status.0.status')).toBe(true);
    expect(approved.valueAt('summary.confirmation_loop.last_applied_decision')).toBe('2026-07-15T00:00:00.000Z');
    expect(approved.valueAt('work_units.all_terminal')).toBeUndefined();

    const revised = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'pending' },
    ], savedPending(save, 'request_revision', 0, 'Tighten the summary.'));
    expect(revised.valueAt('work_units.items.0.status')).toBe('proposed');
    expect(revised.valueAt('work_units.items.0.__terminal')).toBe(false);
    expect(revised.valueAt('work_units.items_terminal_status.0.status')).toBe(false);
    expect(revised.valueAt('work_units.items.0.user_instruction')).toBe('Tighten the summary.');

    const skipped = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'accepted' },
    ], savedPending(save, 'reject', 0));
    expect(skipped.valueAt('work_units.items.0.status')).toBe('skipped');
    expect(skipped.valueAt('work_units.items.0.__terminal')).toBe(true);
    expect(skipped.valueAt('work_units.items_terminal_status.0.status')).toBe(true);
    expect(skipped.valueAt('work_units.all_terminal')).toBeUndefined();

    const demoted = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'proposed' },
    ], '');
    expect(demoted.valueAt('work_units.items.1.status')).toBe('pending');
    expect(demoted.valueAt('work_units.items.1.__terminal')).toBe(false);
    expect(demoted.valueAt('work_units.items_terminal_status.1.status')).toBe(false);
    expect(JSON.parse(String(demoted.valueAt('work_units.confirmation_violation_json')))).toMatchObject({
      reason: 'multiple_proposed',
      demoted_index: 1,
      demoted_id: 'wu-2',
    });
    expect(demoted.valueAt('summary.confirmation_loop.one_proposed_demotions')).toBe(1);

    const aggregate = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'accepted', __terminal: true },
      { id: 'wu-2', title: 'Two', status: 'skipped', __terminal: true },
    ], '');
    expect(aggregate.valueAt('work_units.all_terminal')).toBeUndefined();

    const fallback = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
    ], '', [
      ['inputs.user_decision.decision', 'approve'],
      ['inputs.user_decision.instruction', ''],
      ['inputs.user_decision.timestamp', '2026-07-15T00:00:00.000Z'],
      ['inputs.user_decision.target_item_index', 0],
    ]);
    expect(fallback.valueAt('work_units.items.0.status')).toBe('accepted');
    expect(fallback.valueAt('work_units.items.0.__terminal')).toBe(true);
    expect(fallback.valueAt('work_units.items_terminal_status.0.status')).toBe(true);
  });

  it('generated handlers apply timestamp-distinct identical decisions independently', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoop());
    const generated = loadGeneratedReactionHandlers(artifact.handlers_ts);
    const save = requiredReaction(generated, 'save_review_work_decision');
    const enforce = requiredReaction(generated, 'enforce_review_work_status');
    let snapshot = new Map<string, unknown>([
      ...flattenItems([
        { id: 'wu-1', title: 'One', proposed_text: 'First draft', user_instruction: '', status: 'proposed' },
      ]),
      ['summary.confirmation_loop.one_proposed_demotions', 0],
    ]);

    snapshot = applyMutations(snapshot, save(decisionSnapshot(snapshot, '2026-07-15T00:00:00.000Z'), 'AfterIngestion', 'review_work'));
    snapshot = applyMutations(snapshot, enforce(snapshot, 'AfterIngestion', 'review_work'));
    expect(snapshot.get('work_units.items.0.status')).toBe('accepted');
    expect(snapshot.get('summary.confirmation_loop.last_applied_decision')).toBe('2026-07-15T00:00:00.000Z');

    snapshot.set('work_units.items.0.status', 'proposed');
    snapshot = applyMutations(snapshot, save(decisionSnapshot(snapshot, '2026-07-15T00:00:01.000Z'), 'AfterIngestion', 'review_work'));
    snapshot = applyMutations(snapshot, enforce(snapshot, 'AfterIngestion', 'review_work'));

    expect(snapshot.get('work_units.items.0.status')).toBe('accepted');
    expect(snapshot.get('summary.confirmation_loop.last_applied_decision')).toBe('2026-07-15T00:00:01.000Z');
  });

  it('seeds items from the source stage and applies staged proposals once by nonce', () => {
    const choreograph = createConfirmationLoopChoreographCollectionReaction(confirmationLoop, indexedLifecycle);

    const objectChoreograph = createConfirmationLoopChoreographCollectionReaction(confirmationLoop, {
      ...clone(indexedLifecycle),
      item: {
        ...indexedLifecycle.item,
        schema: {
          ...indexedLifecycle.item.schema,
          description: 'string',
        },
      },
    });
    const objectSeeded = runChoreograph(objectChoreograph, [
      ['plan_work.items_json', JSON.stringify([
        {
          id: 'wu-1',
          title: 'Verify Pre-Launch System Health Checks',
          description: 'Confirm critical services are healthy before launch.',
          status: 'pending_review',
        },
        {
          id: 'wu-2',
          title: 'Validate Deployment Rollback Procedures',
          description: 'Check rollback commands and ownership before release.',
        },
      ])],
    ]);
    expect(objectSeeded.valueAt('work_units.items.0')).toEqual({
      id: 'wu-1',
      title: 'Verify Pre-Launch System Health Checks',
      proposed_text: '',
      user_instruction: '',
      description: 'Confirm critical services are healthy before launch.',
      __terminal: false,
      status: 'pending',
    });
    expect(objectSeeded.valueAt('work_units.items.1')).toEqual({
      id: 'wu-2',
      title: 'Validate Deployment Rollback Procedures',
      proposed_text: '',
      user_instruction: '',
      description: 'Check rollback commands and ownership before release.',
      __terminal: false,
      status: 'pending',
    });
    expect(objectSeeded.valueAt('work_units.items_terminal_status')).toEqual([
      { id: 'wu-1', status: false },
      { id: 'wu-2', status: false },
    ]);
    expect(objectSeeded.valueAt('summary.confirmation_loop.seed_state')).toBe('seeded');
    expect(objectSeeded.valueAt('summary.confirmation_loop.seed_state')).not.toBe('invalid_items_json');

    const mixedSeeded = runChoreograph(objectChoreograph, [
      ['plan_work.items_json', JSON.stringify([
        { name: 'Review fallback title source' },
        'Confirm owner handoff',
      ])],
    ]);
    expect(mixedSeeded.valueAt('work_units.items.0')).toMatchObject({
      id: 'unit-1',
      title: 'Review fallback title source',
      __terminal: false,
      status: 'pending',
    });
    expect(mixedSeeded.valueAt('work_units.items.1')).toMatchObject({
      id: 'unit-2',
      title: 'Confirm owner handoff',
      __terminal: false,
      status: 'pending',
    });
    expect(mixedSeeded.valueAt('summary.confirmation_loop.seed_state')).toBe('seeded');

    const seeded = runChoreograph(choreograph, [
      ['plan_work.items_json', JSON.stringify(['Draft launch checklist', 'Confirm owner handoff'])],
    ]);
    expect(seeded.valueAt('work_units.items.0')).toEqual({
      id: 'unit-1',
      title: 'Draft launch checklist',
      proposed_text: '',
      user_instruction: '',
      __terminal: false,
      status: 'pending',
    });
    expect(seeded.valueAt('work_units.items.1')).toEqual({
      id: 'unit-2',
      title: 'Confirm owner handoff',
      proposed_text: '',
      user_instruction: '',
      __terminal: false,
      status: 'pending',
    });
    expect(seeded.valueAt('work_units.items_terminal_status')).toEqual([
      { id: 'unit-1', status: false },
      { id: 'unit-2', status: false },
    ]);
    expect(seeded.valueAt('summary.confirmation_loop.seed_state')).toBe('seeded');

    const invalidSeed = runChoreograph(choreograph, [
      ['plan_work.items_json', '{not json'],
    ]);
    expect(invalidSeed.valueAt('summary.confirmation_loop.seed_state')).toBe('invalid_items_json');

    const emptySeedArray = runChoreograph(choreograph, [
      ['plan_work.items_json', JSON.stringify([])],
    ]);
    expect(emptySeedArray.valueAt('summary.confirmation_loop.seed_state')).toBe('invalid_items_json');

    const invalidSeedArray = runChoreograph(choreograph, [
      ['plan_work.items_json', JSON.stringify(['valid title', 123])],
    ]);
    expect(invalidSeedArray.valueAt('summary.confirmation_loop.seed_state')).toBe('invalid_items_json');

    const applied = runChoreograph(choreograph, [
      ...flattenItems([
        { id: 'unit-1', title: 'Draft launch checklist', proposed_text: '', user_instruction: '', status: 'pending' },
        { id: 'unit-2', title: 'Confirm owner handoff', proposed_text: '', user_instruction: '', status: 'pending' },
      ]),
      ['review_work.proposal.proposed_text', 'First proposal'],
      ['review_work.proposal.log', ['proposed']],
      ['summary.confirmation_loop.applied_proposal_count', 0],
    ]);
    expect(applied.valueAt('work_units.items.0')).toEqual({
      id: 'unit-1',
      title: 'Draft launch checklist',
      proposed_text: 'First proposal',
      user_instruction: '',
      __terminal: false,
      status: 'proposed',
    });
    expect(applied.valueAt('summary.confirmation_loop.applied_proposal_count')).toBe(1);

    const deduped = runChoreograph(choreograph, [
      ...flattenItems([
        { id: 'unit-1', title: 'Draft launch checklist', proposed_text: 'First proposal', user_instruction: '', status: 'proposed' },
        { id: 'unit-2', title: 'Confirm owner handoff', proposed_text: '', user_instruction: '', status: 'pending' },
      ]),
      ['review_work.proposal.proposed_text', 'First proposal'],
      ['review_work.proposal.log', ['proposed']],
      ['summary.confirmation_loop.applied_proposal_count', 1],
    ]);
    expect(deduped.mutations).toEqual([]);
  });

  it('rejects loops on json_string collections, undeclared statuses, and terminal stages', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        lifecycle: {
          ...clone(indexedLifecycle),
          storage: {
            ...indexedLifecycle.storage,
            items_path: 'work_units.items_json',
            representation: 'json_string',
          },
        },
        loop: { ...confirmationLoop, collection: 'work_units.items_json' },
      })),
    ).toThrow(/confirmation_loop collection must reference a collection_lifecycle with indexed_array storage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, proposed_status: 'drafted' },
      })),
    ).toThrow(/proposed_status.*declared non-terminal status/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: {
          ...confirmationLoop,
          decisions: { ...confirmationLoop.decisions, approve: { to: 'archived' } },
        },
      })),
    ).toThrow(/decision approve.*declared status/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, stage: 'complete' },
      })),
    ).toThrow(/stage.*non-terminal mode/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, seed: { source_stage: 'missing_stage' } },
      })),
    ).toThrow(/seed.source_stage must reference an earlier llm-reasoning stage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, seed: { source_stage: 'review_work' } },
      })),
    ).toThrow(/seed.source_stage must precede the confirmation_loop stage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        delegation: { plan_work: { kind: 'pure-compute' } },
      })),
    ).toThrow(/seed.source_stage must reference an earlier llm-reasoning stage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        lifecycle: {
          ...indexedLifecycle,
          transitions: [
            { from: 'pending', to: 'proposed', stage: 'review_work', action: 'draft_item', managed_by: 'llm' },
          ],
        },
      })),
    ).toThrow(/confirmation_loop lifecycles cannot declare managed_by llm transitions/u);
  });

  it('fails the pairing lint when a prefix-writing action is missing from terminals', () => {
    const parsed = load(synthesizeProgramSpecFromDomain(domainWithLoop()).spec_yaml) as ParsedSpec;
    const drifted = clone(parsed);
    drifted.action_map.write_item_directly = {
      mutations: [{ op: 'MSet', path: 'work_units.items.0.status', value: 'accepted' }],
    };
    drifted.confirmation_pairing = {
      prefixes: ['work_units.items'],
      policy: 'reject',
      terminals: ['propose_item', 'approve_item', 'request_revision_item', 'reject_item'],
    };

    expect(() => assertConfirmationPairingTerminals(drifted)).toThrow(/write_item_directly/u);
  });

  it('keeps no-interaction generated artifacts stable apart from synthesized spec guidance', () => {
    expect(hashArtifact(synthesizeProgramSpecFromDomain(baseDomain))).toEqual({
      spec_yaml: 'c47246cf23e73399c22f07eebb2014c4d8016de950b4ad9d20c393dc228fac87',
      contracts_ts: '0887c0cf22f7eefd2b877e61d6dea3a938d952bbb349572a2fc9919523a74993',
      handlers_ts: '3a199dedfb60608b43be6403ca002ed6d79a4fedc7cfa0ab27c02c0777eceab7',
      handlers_index_ts: '1a48cdeab26386fc7b1a917aa9d466340f2e1af8b493056e5892cc1ca4776e94',
      tools_ts: 'ba348055c634de2e2f58dd88a696d53614266b13c29ed03a9568cf3a3545bfe7',
      smoke_test_ts: 'cfb74d966744cd252918dd8820602ce9b762ea406a7cd39c26ff4e4edc821a92',
    });
  });
});

function domainWithLoop(overrides: {
  lifecycle?: unknown;
  loop?: unknown;
  delegation?: unknown;
} = {}): Record<string, unknown> {
  const lifecycle = overrides.lifecycle ?? indexedLifecycle;
  const loop = overrides.loop ?? confirmationLoop;
  return {
    ...baseDomain,
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'plan_work' },
      { slug: 'review_work' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'plan_work', trigger: 'started', guard_field: 'intake.started' },
      { from: 'plan_work', to: 'review_work', trigger: 'planned', guard_field: 'plan_work.done' },
      { from: 'review_work', to: 'complete', trigger: 'done', guard_field: 'work_units.all_terminal' },
    ]),
    'intake.delegation_json': JSON.stringify(overrides.delegation ?? {
      plan_work: { kind: 'llm-reasoning' },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'work_units.all_terminal',
      collection_lifecycle: lifecycle,
    }),
    'intake.interaction_json': JSON.stringify({ confirmation_loops: [loop] }),
  };
}

function domainWithLoopThenDownstream(): Record<string, unknown> {
  return {
    ...domainWithLoop(),
    'program.slug': 'work-unit-flow-downstream',
    'program.name': 'Work Unit Flow Downstream',
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
      assemble_work: { kind: 'pure-compute' },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'assemble_work.done',
      collection_lifecycle: indexedLifecycle,
    }),
  };
}

function domainWithAnalysisLoop(): Record<string, unknown> {
  const opinionLifecycle = {
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
        section_kind: 'string',
        template_anchor: 'string',
        proposed_text: 'string',
        user_instruction: 'string',
        status: 'string',
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
      guard_field: 'work.opinion_sections.all_terminal',
      terminal_statuses: ['accepted', 'skipped'],
      require_non_empty: true,
    },
  };
  return {
    'program.slug': 'analysis-backed-opinion-flow',
    'program.name': 'Analysis Backed Opinion Flow',
    'program.target_dir': '/tmp/analysis-backed-opinion-flow',
    'program.design_path': 'design',
    'intake.purpose': 'Draft opinion sections from intake facts, diligence findings, and issue analysis.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'intake_facts' },
      { slug: 'dd_dispatch' },
      { slug: 'issue_analysis' },
      { slug: 'draft_sections' },
      { slug: 'approve' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'intake_facts', trigger: 'started', guard_field: 'intake.started' },
      { from: 'intake_facts', to: 'dd_dispatch', trigger: 'facts_captured', guard_field: 'intake_facts.done' },
      { from: 'dd_dispatch', to: 'issue_analysis', trigger: 'dd_done', guard_field: 'dd_dispatch.done' },
      { from: 'issue_analysis', to: 'draft_sections', trigger: 'analysis_done', guard_field: 'issue_analysis.done' },
      { from: 'draft_sections', to: 'approve', trigger: 'sections_planned', guard_field: 'draft_sections.done' },
      { from: 'approve', to: 'complete', trigger: 'approved', guard_field: 'work.opinion_sections.all_terminal' },
    ]),
    'intake.delegation_json': JSON.stringify({
      intake_facts: { kind: 'llm-reasoning' },
      dd_dispatch: { kind: 'llm-reasoning' },
      issue_analysis: { kind: 'llm-reasoning' },
      draft_sections: { kind: 'llm-reasoning' },
      approve: { kind: 'llm-reasoning' },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'work.opinion_sections.all_terminal',
      collection_lifecycle: opinionLifecycle,
    }),
    'intake.interaction_json': JSON.stringify({
      confirmation_loops: [{
        collection: 'work.opinion_sections.items',
        proposed_status: 'proposed',
        seed: { source_stage: 'draft_sections', id_prefix: 'section' },
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
          guard_field: 'work.opinion_sections.all_terminal',
          terminal_statuses: ['accepted', 'skipped'],
        },
        stage: 'approve',
        summary_path: 'work.opinion_sections.confirmation_summary',
        violation_path: 'work.opinion_sections.confirmation_violation_json',
        pending_action_path: 'decisions.pending_approve_action',
      }],
    }),
  };
}

function savedPending(
  save: ReturnType<typeof createConfirmationLoopSaveDecisionReaction>,
  decision: string,
  targetIndex: number,
  instruction = '',
): string {
  const result = save(new Map<string, unknown>([
    ['inputs.user_decision.decision', decision],
    ['inputs.user_decision.instruction', instruction],
    ['inputs.user_decision.timestamp', '2026-07-15T00:00:00.000Z'],
    ['inputs.user_decision.target_item_index', targetIndex],
    ['inputs.user_decision.target_item_id', `wu-${targetIndex + 1}`],
    ['inputs.user_decision.target_item_title', `Item ${targetIndex + 1}`],
    ['inputs.user_decision.target_item_status', 'proposed'],
  ]), 'AfterIngestion', 'review_work');
  const pending = result?.mutations?.find((mutation) => mutation.path === 'decisions.pending_review_work_action')?.value;
  return String(pending ?? '');
}

function runEnforce(
  enforce: ReturnType<typeof createConfirmationLoopEnforceStatusReaction>,
  items: Array<Record<string, unknown>>,
  pending: string,
  extraEntries: Array<[string, unknown]> = [],
): { valueAt(path: string): unknown } {
  const snapshot = new Map<string, unknown>([
    ...flattenItems(items),
    ['decisions.pending_review_work_action', pending],
    ['summary.confirmation_loop.one_proposed_demotions', 0],
    ...extraEntries,
  ]);
  const result = enforce(snapshot, 'AfterIngestion', 'review_work');
  const values = new Map(result?.mutations?.map((mutation) => [mutation.path, mutation.value]));
  return {
    valueAt(path: string): unknown {
      return values.has(path) ? values.get(path) : snapshot.get(path);
    },
  };
}

function runChoreograph(
  choreograph: ReturnType<typeof createConfirmationLoopChoreographCollectionReaction>,
  entries: Array<[string, unknown]>,
): { mutations: Array<{ op: string; path: string; value?: unknown }>; valueAt(path: string): unknown } {
  const snapshot = new Map<string, unknown>(entries);
  const result = choreograph(snapshot, 'AfterRound', 'review_work');
  const mutations = result?.mutations ?? [];
  const values = new Map(mutations.map((mutation) => [mutation.path, mutation.value]));
  return {
    mutations,
    valueAt(path: string): unknown {
      return values.has(path) ? values.get(path) : snapshot.get(path);
    },
  };
}

function flattenItems(items: Array<Record<string, unknown>>): Array<[string, unknown]> {
  return items.flatMap((item, index) =>
    Object.entries(item).map(([field, value]) => [`work_units.items.${index}.${field}`, value] as [string, unknown]),
  );
}

function requiredReaction(handlers: Map<string, ReactionHandler>, name: string): ReactionHandler {
  const reaction = handlers.get(name);
  if (!reaction) {
    throw new Error(`missing generated reaction ${name}`);
  }
  return reaction;
}

function decisionSnapshot(snapshot: ReadonlyMap<string, unknown>, timestamp: string): Map<string, unknown> {
  return new Map<string, unknown>([
    ...snapshot,
    ['inputs.user_decision.decision', 'approve'],
    ['inputs.user_decision.instruction', ''],
    ['inputs.user_decision.timestamp', timestamp],
    ['inputs.user_decision.target_item_index', 0],
    ['inputs.user_decision.target_item_id', 'wu-1'],
    ['inputs.user_decision.target_item_title', 'One'],
    ['inputs.user_decision.target_item_status', 'proposed'],
  ]);
}

function applyMutations(snapshot: ReadonlyMap<string, unknown>, result: ReactionResult | void | undefined): Map<string, unknown> {
  const next = new Map(snapshot);
  for (const mutation of result?.mutations ?? []) {
    if (mutation.op === 'MSet') {
      next.set(mutation.path, mutation.value);
    }
  }
  return next;
}

function declaredWriterCount(spec: ParsedSpec, path: string): number {
  return [
    ...(spec.no_action_escapes ?? []).flatMap((escape) => [escape.counter, escape.arm]),
    ...Object.values(spec.action_map).flatMap((semantics) => [
      ...(semantics.result_path ? [semantics.result_path] : []),
      ...(semantics.mutations ?? []).map((mutation) => mutation.path),
    ]),
    ...Object.values(spec.reactions).flatMap((reaction) => reaction.write_scope),
    ...(spec.derived_paths ?? []).map((rule) => rule.target),
    ...Object.values(spec.ingestion).flat(),
    ...(spec.recovery_steers ?? []).flatMap((steer) => steer.set ? [steer.set.path] : []),
  ].filter((writer) => writer === path).length;
}

function hashArtifact(artifact: SynthesizedSpec): Record<string, string> {
  return Object.fromEntries(
    (['spec_yaml', 'contracts_ts', 'handlers_ts', 'handlers_index_ts', 'tools_ts', 'smoke_test_ts'] as const)
      .map((key) => [key, createHash('sha256').update(artifact[key]).digest('hex')]),
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-confirmation-loop-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
