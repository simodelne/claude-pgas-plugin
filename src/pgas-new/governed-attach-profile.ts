import { dump } from 'js-yaml';
import type { SynthesisContext } from '../foundry-program/synthesizer-store.js';

export type ExistingRepoTargetProfile = 'simoneos-governed-attach';

interface SimoneOsGovernedSpecOptions {
  slug: string;
  name: string;
  context: SynthesisContext;
}

interface StageModel {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
  domain_spec?: {
    reads: string[];
    produces: Record<string, unknown>;
    rules: string[];
    invariants: string[];
  };
}

interface StageTransition {
  from: string;
  to: string;
  guard_field?: string;
}

export function renderSimoneOsGovernedAttachSpec(options: SimoneOsGovernedSpecOptions): string {
  const model = minimalLinearStageModel(options.context);
  const askChannel = governedAskChannel(options.context.entry_channel);
  const spec = {
    name: options.slug,
    termination: 'BoundedSession',
    topology: 'CyclicTopology',
    pure: true,
    preamble: [
      `Program: ${options.name}. ${options.context.purpose}`,
      '',
      'Workflow: intake -> draft_memo -> complete. The program records user-provided facts, drafts a markdown memo artifact from those facts, and then terminates.',
      '',
      'Cross-cutting rules:',
      '- Emit exactly one native tool call per response.',
      '- Use only the declared vocabulary for the current mode.',
      '- Never invent memo facts that are absent from recorded intake state.',
    ].join('\n'),
    initial: model.initial.slug,
    terminal: [model.terminal.slug],
    features: ['base', 'runtime_control'],
    patterns: [
      {
        use: 'control-plane-standard',
        as: {
          program: options.slug,
          ask_channel: askChannel,
          default_controls: ['ask', 'abort', 'new', 'history', 'status', 'help'],
          http_controls: ['ask', 'abort', 'history', 'status', 'help'],
        },
      },
    ],
    channels: {
      user_text: { direction: 'In', sync: 'Async' },
      user_messages: { direction: 'In', sync: 'Async' },
      user_confirmation: { direction: 'In', sync: 'Async', structured_decision: true },
      system_mode_entry: { direction: 'In', sync: 'Async' },
      widget_output: { direction: 'Out', sync: 'Async' },
    },
    modes: {
      [model.initial.slug]: {
        vocabulary: ['record_intake'],
        channels: ['user_text', 'user_messages', 'system_mode_entry', 'widget_output'],
        transitions: [
          {
            target: model.body.slug,
            guard: { kind: 'FieldTruthy', path: model.intakeTransition.guard_field },
          },
        ],
      },
      [model.body.slug]: {
        vocabulary: [model.body.slug],
        channels: ['system_mode_entry', 'user_messages', 'widget_output'],
        transitions: [
          {
            target: model.terminal.slug,
            guard: { kind: 'FieldTruthy', path: model.completionTransition.guard_field },
          },
        ],
      },
      [model.terminal.slug]: {
        vocabulary: [],
        channels: ['system_mode_entry', 'widget_output'],
      },
    },
    proceed_to: {
      record_intake: model.body.slug,
      [model.body.slug]: model.terminal.slug,
    },
    projection: {
      [model.initial.slug]: {
        include: ['inputs.user_text', 'inputs.user_message_latest', 'inputs.mode_entry', 'work.intake', 'work.intake_recorded', 'work.status'],
        exclude: [],
      },
      [model.body.slug]: {
        include: ['work.intake', 'work.intake.facts', 'work.memo_artifact', 'decisions.reasoning', 'work.status'],
        exclude: [],
      },
      [model.terminal.slug]: {
        include: ['work.memo_artifact', 'work.status'],
        exclude: [],
      },
    },
    schema: {
      'inputs.user_text': 'string',
      'inputs.user_message_latest': 'string',
      'inputs.user_decision.decision': 'string',
      'inputs.user_decision.instruction': 'string',
      'inputs.mode_entry': 'object',
      'work.status': 'string',
      'work.intake': 'object',
      'work.intake.facts': 'object',
      'work.intake.summary': 'string',
      'work.intake_recorded': 'boolean',
      'work.memo_artifact': 'object',
      'work.memo_artifact.id': 'string',
      'work.memo_artifact.kind': 'string',
      'work.memo_artifact.title': 'string',
      'work.memo_artifact.body': 'string',
      'work.memo_artifact.status': 'string',
      'decisions.reasoning': 'object',
    },
    ingestion: {
      user_text: ['inputs.user_text'],
      user_messages: ['inputs.user_message_latest'],
      user_confirmation: ['inputs.user_decision.decision', 'inputs.user_decision.instruction'],
      system_mode_entry: ['inputs.mode_entry'],
    },
    action_map: {
      record_intake: {
        description: 'Record the user-provided intake facts that the memo drafter may use.',
        arg_descriptions: {
          facts: 'Object containing only facts supplied by the user.',
          summary: 'Short human-readable summary of the recorded facts.',
        },
        mutations: [
          { op: 'MSet', path: 'work.intake.facts', value: {}, from_arg: 'facts' },
          { op: 'MSet', path: 'work.intake.summary', value: '', from_arg: 'summary' },
          { op: 'MSet', path: 'work.intake_recorded', value: true },
          { op: 'MSet', path: 'work.status', value: 'intake_recorded' },
        ],
        channel: 'widget_output',
      },
      [model.body.slug]: {
        description: `LLM-reasoning stage action for ${model.body.slug}: draft a structured markdown memo artifact from recorded intake facts.`,
        arg_descriptions: {
          id: 'Stable artifact id for this memo.',
          title: 'Memo title derived from the recorded intake facts.',
          body: 'Markdown memo body. Use only facts recorded at work.intake.facts.',
          status: 'Artifact status; use drafted when the memo is ready.',
          reasoning: 'Reasoning object describing the recorded state, goal, action, and rationale.',
        },
        mutations: [
          { op: 'MSet', path: 'work.memo_artifact.id', value: '', from_arg: 'id' },
          { op: 'MSet', path: 'work.memo_artifact.kind', value: 'markdown' },
          { op: 'MSet', path: 'work.memo_artifact.title', value: '', from_arg: 'title' },
          { op: 'MSet', path: 'work.memo_artifact.body', value: '', from_arg: 'body' },
          { op: 'MSet', path: 'work.memo_artifact.status', value: 'drafted', from_arg: 'status' },
          { op: 'MSet', path: 'decisions.reasoning', value: {}, from_arg: 'reasoning' },
          { op: 'MSet', path: 'work.status', value: 'memo_drafted' },
        ],
        channel: 'widget_output',
      },
    },
    reactions: {},
    guidance: {
      [model.initial.slug]: [
        '$ref(core.query-first)',
        '$ref(core.terminal-action-invariant)',
        'INTAKE: record only user-provided facts. If facts are missing, ask for them before advancing.',
      ],
      [model.body.slug]: [
        '$ref(core.query-first)',
        '$ref(core.reasoning-required)',
        '$ref(core.terminal-action-invariant)',
        'DRAFT MEMO: produce work.memo_artifact with id, kind="markdown", title, body, and status="drafted".',
        ...stageRules(model.body),
      ],
      [model.terminal.slug]: [
        'TERMINAL MODE: no further authoring actions are available after the memo artifact is drafted.',
      ],
    },
    prompts: {
      [model.initial.slug]: [
        '---',
        'temperature: 0.2',
        '---',
        'MEMO MINI INTAKE',
        '$ref(core.query-first)',
        '',
        'Collect the memo facts from the user and call record_intake with facts and summary.',
      ].join('\n'),
      [model.body.slug]: [
        '---',
        'temperature: 0.2',
        '---',
        'MEMO MINI DRAFT',
        '$ref(core.query-first)',
        '$ref(core.reasoning-required)',
        '',
        'Draft one markdown memo artifact from work.intake.facts. Do not use facts that were not recorded in intake.',
      ].join('\n'),
      [model.terminal.slug]: 'Terminal mode after the governed memo artifact has been drafted.',
    },
    repair_bound: 2,
    fallback: {
      channel: 'widget_output',
      payload: 'I could not draft the memo from the recorded facts. Please provide the missing intake facts.',
    },
  };

  return dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
}

function minimalLinearStageModel(context: SynthesisContext): {
  initial: StageModel;
  body: StageModel;
  terminal: StageModel;
  intakeTransition: StageTransition & { guard_field: string };
  completionTransition: StageTransition & { guard_field: string };
} {
  const stages = context.stages as StageModel[];
  const initial = stages.find((stage) => stage.is_bootstrap) ?? stages[0];
  const terminal = stages.find((stage) => stage.slug === context.completion.final_stage || stage.is_terminal);
  if (!initial) {
    throw new Error('simoneos governed attach profile requires at least one stage');
  }
  if (!terminal) {
    throw new Error('simoneos governed attach profile requires a terminal stage');
  }

  const bodyStages = stages.filter((stage) => stage.slug !== initial.slug && stage.slug !== terminal.slug);
  if (bodyStages.length !== 1) {
    throw new Error(`simoneos governed attach profile currently supports exactly one body stage; got ${bodyStages.length}`);
  }
  const body = bodyStages[0] as StageModel;
  const intakeTransition = requiredTransition(context.transitions as StageTransition[], initial.slug, body.slug);
  const completionTransition = requiredTransition(context.transitions as StageTransition[], body.slug, terminal.slug);

  assertSupportedMinimalTarget(initial, body, terminal);
  return {
    initial,
    body,
    terminal,
    intakeTransition,
    completionTransition,
  };
}

function requiredTransition(transitions: StageTransition[], from: string, to: string): StageTransition & { guard_field: string } {
  const transition = transitions.find((candidate) => candidate.from === from && candidate.to === to);
  if (!transition) {
    throw new Error(`simoneos governed attach profile requires a ${from} -> ${to} transition`);
  }
  if (!transition.guard_field) {
    throw new Error(`simoneos governed attach profile requires ${from} -> ${to} to declare guard_field`);
  }
  return transition as StageTransition & { guard_field: string };
}

function assertSupportedMinimalTarget(initial: StageModel, body: StageModel, terminal: StageModel): void {
  const modeNames = [initial.slug, body.slug, terminal.slug].join(' -> ');
  if (modeNames !== 'intake -> draft_memo -> complete') {
    throw new Error(`simoneos governed attach profile P1 supports intake -> draft_memo -> complete; got ${modeNames}`);
  }

  const produced = body.domain_spec?.produces ?? {};
  if (!Object.prototype.hasOwnProperty.call(produced, 'work.memo_artifact')) {
    throw new Error('simoneos governed attach profile requires draft_memo to produce work.memo_artifact');
  }
}

function governedAskChannel(entryChannel: string): 'user_text' | 'user_messages' {
  return entryChannel === 'user_messages' ? 'user_messages' : 'user_text';
}

function stageRules(stage: StageModel): string[] {
  const rules = stage.domain_spec?.rules ?? [];
  const invariants = stage.domain_spec?.invariants ?? [];
  return [...rules, ...invariants].map((rule) => `STAGE RULE: ${rule}`);
}
