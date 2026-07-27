import { dump } from 'js-yaml';
import type { SynthesisContext } from '../foundry-program/synthesizer-store.js';

export type ExistingRepoTargetProfile = 'simoneos-governed-attach';

interface SimoneOsGovernedSpecOptions {
  slug: string;
  name: string;
  context: SynthesisContext;
}

interface SimoneOsGovernedProgramOptions {
  slug: string;
  name: string;
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

export function renderSimoneOsGovernedAttachRegistration(options: SimoneOsGovernedProgramOptions): string {
  const constantPrefix = toConstantPrefix(options.slug);
  const projectionName = `${toCamelCase(options.slug)}Projection`;
  return `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgramAdapters, enableNotebook, loadSpecWithPatterns, type ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { ${projectionName} } from './projection.js';

const ${constantPrefix}_MANIFEST: ProgramEntry['manifest'] = {
  description: 'Backend-only governed markdown memo drafting from recorded intake facts.',
  keywords: ['memo', 'governed attach', 'markdown', 'backend'],
  interactive: false,
};

const ${constantPrefix}_PRESENTATION: ProgramEntry['presentation'] = {
  labels: {
    program: '${options.name}',
    modes: {
      intake: 'Intake',
      draft_memo: 'Draft Memo',
      complete: 'Complete',
    },
    actions: {
      record_intake: 'Record intake',
      draft_memo: 'Draft memo',
    },
    paths: {
      'work.intake.facts': 'Recorded facts',
      'work.memo_artifact': 'Memo artifact',
    },
  },
  ui: {
    contextTabs: ['session', 'domain', 'artifacts'],
  },
  behavior: {
    autoContinuationMode: 'draft_memo',
  },
};

const ${constantPrefix}_ARTIFACT_POLICY: ProgramEntry['artifactPolicy'] = {
  rules: [
    {
      artifactType: 'memo_markdown',
      title: '${options.name} Markdown Memo',
      summary: 'Markdown memo drafted from recorded intake facts.',
      payloadRef: 'work.memo_artifact',
      whenAnyPath: ['work.memo_artifact'],
    },
  ],
  fallbackStatusPath: 'work.status',
};

const ${constantPrefix}_SURROGATE_POLICY: ProgramEntry['surrogatePolicy'] = {
  autoBindEligible: true,
  suggestedRole: 'governed memo drafter',
  suggestedPersona: 'You draft concise markdown memos using only recorded intake facts and stop when the memo artifact is drafted.',
  goalHints: ['Capture intake facts, draft the markdown memo, and avoid introducing unstated facts.'],
  expectedModes: ['intake', 'draft_memo', 'complete'],
  domainProjectionPaths: ['work.intake', 'work.memo_artifact', 'work.status'],
  intakeHints: ['Memo topic', 'Material facts to use', 'Requested conclusion or audience'],
  intakeExample: 'Draft a short governed memo from these facts.',
};

const ${constantPrefix}_CONTINUATION_POLICY: ProgramEntry['continuationPolicy'] = {
  modeEntryAutoContinue: true,
  autoStart: {
    channel: 'user_text',
    payloadPath: 'inputs.domain_context.kickoff_message',
    defaultPayload: 'Begin the governed memo intake.',
  },
};

export function createProgramEntry(): ProgramEntry {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const { spec: loadedSpec } = loadSpecWithPatterns(path.join(dirname, 'specs.yml'));
  const spec = enableNotebook(loadedSpec, { modes: ['intake', 'draft_memo'] });

  return {
    spec,
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, {}),
    projectionBuilder: ${projectionName},
    manifest: ${constantPrefix}_MANIFEST,
    presentation: ${constantPrefix}_PRESENTATION,
    artifactPolicy: ${constantPrefix}_ARTIFACT_POLICY,
    surrogatePolicy: ${constantPrefix}_SURROGATE_POLICY,
    continuationPolicy: ${constantPrefix}_CONTINUATION_POLICY,
  };
}
`;
}

export function renderSimoneOsGovernedAttachProjection(options: SimoneOsGovernedProgramOptions): string {
  const projectionName = `${toCamelCase(options.slug)}Projection`;
  const deriveName = `derive${toPascalCase(options.slug)}Projection`;
  return `import type { DerivedMap, DomainMap, ProjectionBuilder } from '@simodelne/pgas-server/plugin.js';

type StageStatus = 'complete' | 'current' | 'pending';

const PHASES = [
  ['intake', 'Intake'],
  ['draft_memo', 'Draft Memo'],
  ['complete', 'Complete'],
] as const;

export const ${projectionName}: ProjectionBuilder = (domain, mode) => {
  return ${deriveName}(domain, mode);
};

function ${deriveName}(domain: DomainMap, mode: string): DerivedMap {
  const memoArtifact = readRecord(domain, 'work.memo_artifact');
  const intake = readRecord(domain, 'work.intake');
  const intakeFacts = readRecord(domain, 'work.intake.facts');
  const status = readString(domain, 'work.status') || readStringFromRecord(memoArtifact, 'status') || 'pending';
  const complete = mode === 'complete' || status === 'memo_drafted' || status === 'drafted';

  return {
    program_title: '${options.name}',
    program_slug: '${options.slug}',
    mode,
    status_banner: complete
      ? { tone: 'success', label: 'Memo drafted', detail: readStringFromRecord(memoArtifact, 'title') || 'Markdown memo artifact is available.' }
      : { tone: 'info', label: 'In progress', detail: \`Currently in \${mode.replace(/_/g, ' ')}.\` },
    phase_steps: PHASES.map(([id, label]) => ({
      id,
      label,
      status: phaseStatus(id, mode, complete),
    })),
    workspace_checkpoints: [
      checkpoint('Intake facts recorded', Object.keys(intakeFacts).length > 0 || Object.keys(readRecord(intake, 'facts')).length > 0 || isTruthy(domain.get('work.intake_recorded'))),
      checkpoint('Memo artifact drafted', Object.keys(memoArtifact).length > 0 && readStringFromRecord(memoArtifact, 'kind') === 'markdown'),
    ],
    workspace_metadata: [
      { label: 'Program', value: '${options.name}' },
      { label: 'Mode', value: mode.replace(/_/g, ' ') },
      { label: 'Status', value: status },
    ],
    memo_artifact: memoArtifact,
    workspace_artifact_items: Object.keys(memoArtifact).length > 0
      ? [
          {
            id: readStringFromRecord(memoArtifact, 'id') || 'memo-artifact',
            label: readStringFromRecord(memoArtifact, 'title') || '${options.name} Markdown Memo',
            kind: readStringFromRecord(memoArtifact, 'kind') || 'markdown',
            status: readStringFromRecord(memoArtifact, 'status') || status,
          },
        ]
      : [],
  };
}

function phaseStatus(id: string, mode: string, complete: boolean): StageStatus {
  if (complete) return 'complete';
  if (id === mode) return 'current';
  return 'pending';
}

function checkpoint(label: string, complete: boolean): Record<string, unknown> {
  return { label, complete, status: complete ? 'complete' : 'pending' };
}

function readRecord(domain: DomainMap | Record<string, unknown>, path: string): Record<string, unknown> {
  const value = domain instanceof Map ? domain.get(path) : domain[path];
  return isRecord(value) ? value : {};
}

function readString(domain: DomainMap, path: string): string {
  const value = domain.get(path);
  return typeof value === 'string' ? value : '';
}

function readStringFromRecord(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
`;
}

export function renderSimoneOsGovernedAttachCuratorRequest(options: SimoneOsGovernedProgramOptions): string {
  const registryImport = `import { createProgramEntry as create${toPascalCase(options.slug)}ProgramEntry } from '../../../programs/${options.slug}/registration.js';`;
  const registryRegister = `registry.register('${options.slug}', asRegisterableProgramEntry(create${toPascalCase(options.slug)}ProgramEntry()));`;
  const loadcheckImport = `import { createProgramEntry as create${toPascalCase(options.slug)} } from '../programs/${options.slug}/registration.js';`;
  const loadcheckRosterEntry = `{ name: '${options.slug}',         load: () => create${toPascalCase(options.slug)}() },`;

  return `# PGAS-New Curator Request: ${options.name}

Boundary: CURATOR-REQUEST. pgas-new generated SimoneOS-conformant program artifacts and did not edit SimoneOS central files.

Program: \`${options.slug}\`
Generated program directory: \`programs/${options.slug}\`

## Generated Artifacts

- \`programs/${options.slug}/specs.yml\`
- \`programs/${options.slug}/registration.ts\`
- \`programs/${options.slug}/projection.ts\`

## Central Edits For Curator

Apply these exact edits in the SimoneOS repo after reviewing the generated artifacts.

### \`server/src/registrations/index.ts\`

Insert this import after the existing anchor:

Anchor:
\`\`\`ts
import { createProgramEntry as createMinutesDrafterProgramEntry } from '../../../programs/minutes-drafter/registration.js';
\`\`\`

Insert:
\`\`\`ts
${registryImport}
\`\`\`

Insert this registry line after the existing minutes-drafter registration block and before the \`fee-proposal-drafter\` registration:

Anchor:
\`\`\`ts
  registry.register('fee-proposal-drafter', asRegisterableProgramEntry(createFeeProposalDrafterProgramEntry()));
\`\`\`

Insert before anchor:
\`\`\`ts
  ${registryRegister}
\`\`\`

### \`scripts/specs-loadcheck.ts\`

Insert this import after the existing anchor:

Anchor:
\`\`\`ts
import { createProgramEntry as createMinutesDrafter } from '../programs/minutes-drafter/registration.js';
\`\`\`

Insert:
\`\`\`ts
${loadcheckImport}
\`\`\`

Insert this PROGRAMS-roster entry after the existing \`minutes-drafter\` entry and before \`user-surrogate\`:

Anchor:
\`\`\`ts
  { name: 'user-surrogate',             load: () => createUserSurrogate({ targetPort: noopSurrogatePort as never }) },
\`\`\`

Insert before anchor:
\`\`\`ts
  ${loadcheckRosterEntry}
\`\`\`

## Unified Diff Shape

\`\`\`diff
diff --git a/server/src/registrations/index.ts b/server/src/registrations/index.ts
--- a/server/src/registrations/index.ts
+++ b/server/src/registrations/index.ts
@@
 import { createProgramEntry as createLegalMemoProgramEntry } from '../../../programs/legal-memo/registration.js';
 import { createProgramEntry as createMinutesDrafterProgramEntry } from '../../../programs/minutes-drafter/registration.js';
+${registryImport}
 import { createFeeProposalDrafterProgramEntry } from '../../../programs/fee-proposal-drafter/registration.js';
@@
   registry.register('minutes-drafter', asRegisterableProgramEntry(createMinutesDrafterProgramEntry({
     authorComplete: options.authorComplete,
     transcribeAudio: minutesDrafterTranscribeAudio,
   })));
+  ${registryRegister}
   registry.register('fee-proposal-drafter', asRegisterableProgramEntry(createFeeProposalDrafterProgramEntry()));
diff --git a/scripts/specs-loadcheck.ts b/scripts/specs-loadcheck.ts
--- a/scripts/specs-loadcheck.ts
+++ b/scripts/specs-loadcheck.ts
@@
 import { createDraftPolicyProgramEntry as createDraftPolicy } from '../programs/draft-policy/registration.js';
 import { createProgramEntry as createMinutesDrafter } from '../programs/minutes-drafter/registration.js';
+${loadcheckImport}
 import { createProgramEntry as createUserSurrogate } from '../programs/user-surrogate/registration.js';
@@
   { name: 'legal-memo',                 load: () => createLegalMemo() },
   { name: 'draft-policy',               load: () => createDraftPolicy() },
   { name: 'minutes-drafter',            load: () => createMinutesDrafter() },
+  ${loadcheckRosterEntry}
   { name: 'user-surrogate',             load: () => createUserSurrogate({ targetPort: noopSurrogatePort as never }) },
\`\`\`

## Curator QC Commands

\`\`\`bash
tsx qc/drift-check.ts --update
tsx qc/integrity.ts --rotate --reason "Register governed-memo-mini from pgas-new governed attach"
\`\`\`
`;
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

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return `${pascal[0]?.toLowerCase() ?? ''}${pascal.slice(1)}`;
}

function toConstantPrefix(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase())
    .join('_');
}
