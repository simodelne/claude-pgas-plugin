import { dump } from 'js-yaml';
import type { SynthesisContext } from '../foundry-program/synthesizer-store.js';
import { canonicalBlueprintRootOrder } from '../foundry-program/synthesizer/modular-spec.js';

export type ExistingRepoTargetProfile = 'simoneos-governed-attach';
export type SimoneOsGovernedAttachFrontendMode = 'backend-only' | 'user-facing';

interface SimoneOsGovernedSpecOptions {
  slug: string;
  name: string;
  context: SynthesisContext;
}

interface SimoneOsGovernedProgramOptions {
  slug: string;
  name: string;
  frontendSpecPath?: string;
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

const SIMONEOS_GOVERNED_ATTACH_VIEW_SECTIONS = [
  { key: 'work_status', from: 'work.status', label: 'Work Status' },
  { key: 'intake_facts', from: 'work.intake.facts', label: 'Intake Facts' },
  { key: 'memo_title', from: 'work.memo_artifact.title', label: 'Memo Title' },
  { key: 'memo_body', from: 'work.memo_artifact.body', label: 'Memo Body' },
  { key: 'memo_status', from: 'work.memo_artifact.status', label: 'Memo Status' },
] as const;

const SIMONEOS_GOVERNED_ATTACH_PROJECTION_RESIDUAL_KEYS = [
  'program_title',
  'program_slug',
  'mode',
  'status_banner',
  'focus_object',
  'phase_steps',
  'workspace_checkpoints',
  'workspace_metadata',
  'workspace_context_tabs',
  'workspace_session_content',
  'workspace_domain_content',
  'workspace_stat_items',
  'memo_sections',
  'memo_artifact',
  'workspace_artifact_items',
  'completion_title',
  'completion_summary',
  'final_artifacts',
  'completion_artifacts',
] as const;

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
            when: { kind: 'FieldTruthy', path: model.intakeTransition.guard_field },
          },
        ],
      },
      [model.body.slug]: {
        vocabulary: [model.body.slug],
        channels: ['system_mode_entry', 'user_messages', 'widget_output'],
        transitions: [
          {
            target: model.terminal.slug,
            when: { kind: 'FieldTruthy', path: model.completionTransition.guard_field },
          },
        ],
      },
      [model.terminal.slug]: {
        vocabulary: [],
        channels: ['system_mode_entry', 'widget_output'],
      },
    },
    proceeds_to: {
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

  // Canonical blueprint block order (pgas#946). This profile also carries a
  // `patterns:` manifest key, which the engine requires to LEAD the spec
  // (MANIFEST_NOT_LEADING); `canonicalBlueprintRootOrder` hoists it.
  return dump(canonicalBlueprintRootOrder(spec), { lineWidth: -1, noRefs: true, sortKeys: false });
}

export function renderSimoneOsGovernedAttachRegistration(options: SimoneOsGovernedProgramOptions): string {
  const constantPrefix = toConstantPrefix(options.slug);
  const projectionName = `${toCamelCase(options.slug)}Projection`;
  const frontendSpecPathLine = options.frontendSpecPath ? `    frontendSpecPath: ${tsString(options.frontendSpecPath)},\n` : '';
  const manifestDescription = options.frontendSpecPath
    ? 'Governed markdown memo drafting from recorded intake facts with an opt-in workspace frontend.'
    : 'Backend-only governed markdown memo drafting from recorded intake facts.';
  const manifestKeywords = options.frontendSpecPath
    ? "['memo', 'governed attach', 'markdown', 'frontend']"
    : "['memo', 'governed attach', 'markdown', 'backend']";
  const manifestInteractive = options.frontendSpecPath ? 'true' : 'false';
  return `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgramAdapters, enableNotebook, loadSpecWithPatterns, type ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { ${projectionName} } from './projection.js';

const ${constantPrefix}_MANIFEST: ProgramEntry['manifest'] = {
  description: '${manifestDescription}',
  keywords: ${manifestKeywords},
  interactive: ${manifestInteractive},
};

const ${constantPrefix}_PRESENTATION: ProgramEntry['presentation'] = {
  labels: {
    program: ${tsString(options.name)},
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
      title: ${tsString(`${options.name} Markdown Memo`)},
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

const ${constantPrefix}_VIEW_PROFILE: ProgramEntry['viewProfile'] = {
  sections: ${renderTsValue(SIMONEOS_GOVERNED_ATTACH_VIEW_SECTIONS)},
};

export function createProgramEntry(): ProgramEntry {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const { spec: loadedSpec } = loadSpecWithPatterns(path.join(dirname, 'specs.yml'));
  const spec = enableNotebook(loadedSpec, { modes: ['intake', 'draft_memo'] });

  return {
    spec,
${frontendSpecPathLine}    createAdapters: (ctx) => createProgramAdapters(spec, ctx, {}),
    viewProfile: ${constantPrefix}_VIEW_PROFILE,
    projectionBuilderMigration: {
      trackingIssue: 'docs/ENGINE-DECLARATION-CATALOG.md#declarative-projection',
      remainingKeys: ${renderTsValue([...SIMONEOS_GOVERNED_ATTACH_PROJECTION_RESIDUAL_KEYS])},
    },
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

export function renderSimoneOsGovernedAttachFrontendSpec(options: SimoneOsGovernedProgramOptions): string {
  return `program: ${options.slug}
display:
  title: ${yamlString(options.name)}

modes:
  intake:
    layout: workspace-3col
    focus: { enabled: true }
    side: &workspace_side
      - widget: workspace-sidebar
        bind:
          phaseSteps: derived.phase_steps
          phaseTitle: literal:Memo workflow
          checkpoints: derived.workspace_checkpoints
    primary:
      - widget: focus-panel
        bind:
          focusObject: derived.focus_object
      - widget: chat-thread
        bind: &chat_bind
          messages: channels.user_messages
          composerPlaceholder: literal:Describe the facts, issue, audience, and conclusion you need...
        actions: &chat_actions
          - label: Send
            trigger: { type: channel_publish, channel: user_messages }
            emit: send
    secondary: &workspace_context
      - widget: workspace-context
        bind:
          metadata: derived.workspace_metadata
          tabs: derived.workspace_context_tabs
          sessionContent: derived.workspace_session_content
          domainContent: derived.workspace_domain_content
          artifactItems: derived.workspace_artifact_items
          statItems: derived.workspace_stat_items

  draft_memo:
    layout: workspace-3col
    focus: { enabled: true }
    side: *workspace_side
    primary:
      - widget: focus-panel
        bind:
          focusObject: derived.focus_object
      - widget: chat-thread
        bind: *chat_bind
        actions: *chat_actions
    secondary: *workspace_context

  complete:
    layout: workspace-3col
    side: *workspace_side
    primary:
      - widget: completion-celebration
        bind:
          eyebrow: literal:Session complete
          title: derived.completion_title
          summary: derived.completion_summary
          metadata: derived.workspace_stat_items
          artifacts: derived.completion_artifacts
          primaryLabel: literal:Continue
          auditLabel: literal:View audit trail
        actions:
          - label: Download
            trigger: { type: action, name: download_session_artifact }
            emit: download
    secondary:
      - widget: workspace-context
        bind:
          metadata: derived.workspace_metadata
          tabs: derived.workspace_context_tabs
          sessionContent: derived.workspace_session_content
          artifactItems: derived.workspace_artifact_items
          artifactSections: derived.memo_sections
          statItems: derived.workspace_stat_items
          drawerMode: literal:true
      - widget: artifact-list
        bind:
          title: literal:Memo outputs
          items: derived.completion_artifacts
          emptyLabel: literal:Memo output is not ready yet.
          variant: literal:list
        actions:
          - label: Download
            trigger: { type: action, name: download_session_artifact }
            emit: download
`;
}

export function renderSimoneOsGovernedAttachFacts(options: SimoneOsGovernedProgramOptions): string {
  return dump({
    program: options.slug,
    description: `${options.name} deterministic memo frontend QC facts`,
    facts: {
      client: 'Acme Corp',
      issue: 'Renewal recommendation',
      audience: 'General Counsel',
      assumption: 'Only the provided renewal facts may be used.',
      required_conclusion: 'Renew the agreement with the negotiated liability cap.',
    },
    expected_modes: ['intake', 'draft_memo', 'complete'],
    expected_artifacts: [
      {
        kind: 'memo_markdown',
        domain_path: 'work.memo_artifact.body',
        contains_keywords: ['Acme Corp', 'Renewal recommendation', 'liability cap'],
      },
    ],
    acceptance: {
      max_duration_minutes: 30,
      max_repair_rate: 0.2,
      max_fallback_rate: 0,
    },
  }, { lineWidth: -1, noRefs: true, sortKeys: false });
}

export function renderSimoneOsGovernedAttachFrontendScenario(options: SimoneOsGovernedProgramOptions): string {
  return dump({
    extends: `../facts/${options.slug}.facts.yml`,
    program: options.slug,
    channel: 'frontend',
    description: `${options.name} frontend deterministic memo drafting flow`,
    kickoff_prompt: [
      'Please draft a concise governed markdown memo using only these facts:',
      '- Client: Acme Corp.',
      '- Issue: Renewal recommendation.',
      '- Audience: General Counsel.',
      '- Assumption: Only the provided renewal facts may be used.',
      '- Required conclusion: Renew the agreement with the negotiated liability cap.',
      '',
      'Provide the final memo as markdown and do not introduce unstated facts.',
    ].join('\n'),
    user_responses: [
      {
        match: { widget_kind: 'notice' },
        action: 'approve',
      },
      {
        match: { widget_kind: 'confirmation' },
        action: 'approve',
      },
    ],
    expected: {
      modes_visited: ['intake', 'draft_memo', 'complete'],
      final_artifacts: [
        {
          kind: 'memo_markdown',
          domain_path: 'work.memo_artifact.body',
          contains_keywords: ['Acme Corp', 'Renewal recommendation', 'liability cap'],
        },
      ],
    },
    acceptance: {
      max_duration_minutes: 30,
      max_repair_rate: 0.2,
      max_fallback_rate: 0,
    },
  }, { lineWidth: -1, noRefs: true, sortKeys: false });
}

export function renderSimoneOsGovernedAttachProjection(options: SimoneOsGovernedProgramOptions): string {
  const projectionName = `${toCamelCase(options.slug)}Projection`;
  const deriveName = `derive${toPascalCase(options.slug)}Projection`;
  return `import type { DerivedMap, DomainMap, ProjectionBuilder } from '@simodelne/pgas-server/plugin.js';

type StageStatus = 'done' | 'current' | 'upcoming';
type FocusObjectKind = 'schema_field' | 'section' | 'completion';
type FocusObjectStatus = 'ready_for_review' | 'revising' | 'approved';

interface MemoArtifact {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
}

interface FocusObject {
  id: string;
  program: string;
  phase: string;
  kind: FocusObjectKind;
  title: string;
  body: string;
  status: FocusObjectStatus;
  actions: [];
}

interface StatusBanner {
  tone: 'success' | 'info';
  label: string;
  detail: string;
}

interface PhaseStep {
  id: string;
  label: string;
  status: StageStatus;
}

interface WorkspaceCheckpoint {
  label: string;
  complete: boolean;
  status: 'complete' | 'pending';
}

interface WorkspaceMetadata {
  label: string;
  value: string;
}

interface WorkspaceArtifactItem {
  id: string;
  label: string;
  kind: string;
  status: string;
}

interface WorkspaceContextTab {
  id: 'session' | 'artifacts' | 'stats';
  label: string;
}

interface WorkspaceContentRow {
  label: string;
  value: string;
  meta?: string;
}

interface WorkspaceStatItem {
  label: string;
  value: string;
}

interface MemoSection {
  id: string;
  title: string;
  text: string;
  status: string;
}

interface CompletionArtifact {
  id: string;
  extension: string;
  title: string;
  subtitle: string;
  status: string;
}

interface GovernedMemoMiniDerived {
  program_title: string;
  program_slug: string;
  mode: string;
  status_banner: StatusBanner;
  focus_object: FocusObject;
  phase_steps: PhaseStep[];
  workspace_checkpoints: WorkspaceCheckpoint[];
  workspace_metadata: WorkspaceMetadata[];
  workspace_context_tabs: WorkspaceContextTab[];
  workspace_session_content: WorkspaceContentRow[];
  workspace_domain_content: WorkspaceContentRow[];
  workspace_stat_items: WorkspaceStatItem[];
  memo_sections: MemoSection[];
  memo_artifact: MemoArtifact | null;
  workspace_artifact_items: WorkspaceArtifactItem[];
  completion_title: string;
  completion_summary: string;
  final_artifacts: CompletionArtifact[];
  completion_artifacts: CompletionArtifact[];
}

const PROGRAM_SLUG = '${options.slug}';
const PROGRAM_TITLE = ${tsString(options.name)};
const STABLE_MEMO_ARTIFACT_ID = 'governed_memo_markdown';

const PHASES = [
  ['intake', 'Intake'],
  ['draft_memo', 'Draft Memo'],
  ['complete', 'Complete'],
] as const;

export const ${projectionName}: ProjectionBuilder = (domain, mode) => {
  return ${deriveName}(domain, mode);
};

function ${deriveName}(domain: DomainMap, mode: string): DerivedMap {
  const memoArtifact = readMemoArtifact(domain);
  const intake = readRecord(domain, 'work.intake');
  const intakeFacts = {
    ...readRecord(intake, 'facts'),
    ...readRecord(domain, 'work.intake.facts'),
  };
  const status = readString(domain, 'work.status') || memoArtifact?.status || 'pending';
  const workflowComplete = mode === 'complete' || status === 'memo_drafted' || memoArtifact?.status === 'drafted';
  const memoReady = Boolean(memoArtifact?.body);
  const finalArtifacts = completionArtifacts(memoReady);
  const factRows = rowsFromRecord(intakeFacts);

  const derived: GovernedMemoMiniDerived = {
    program_title: PROGRAM_TITLE,
    program_slug: PROGRAM_SLUG,
    mode,
    status_banner: workflowComplete && memoReady
      ? { tone: 'success', label: 'Memo drafted', detail: memoArtifact?.title || 'Markdown memo artifact is available.' }
      : { tone: 'info', label: 'In progress', detail: 'Currently in ' + mode.replace(/_/g, ' ') + '.' },
    focus_object: focusObjectFor(mode, memoArtifact, intakeFacts, status),
    phase_steps: PHASES.map(([id, label]) => ({
      id,
      label,
      status: phaseStatus(id, mode, workflowComplete),
    })),
    workspace_checkpoints: [
      checkpoint('Intake facts recorded', Object.keys(intakeFacts).length > 0 || isTruthy(domain.get('work.intake_recorded'))),
      checkpoint('Memo artifact drafted', memoReady),
    ],
    workspace_metadata: [
      { label: 'Program', value: PROGRAM_TITLE },
      { label: 'Mode', value: mode.replace(/_/g, ' ') },
      { label: 'Status', value: status },
    ],
    workspace_context_tabs: [
      { id: 'session', label: 'Session' },
      { id: 'artifacts', label: 'Artifacts' },
      { id: 'stats', label: 'Stats' },
    ],
    workspace_session_content: [
      { label: 'Program', value: PROGRAM_TITLE },
      { label: 'Current mode', value: mode.replace(/_/g, ' ') },
      { label: 'Memo status', value: status },
    ],
    workspace_domain_content: factRows,
    workspace_stat_items: [
      { label: 'Recorded facts', value: String(Object.keys(intakeFacts).length) },
      { label: 'Memo artifact', value: memoReady ? 'Ready' : 'Pending' },
    ],
    memo_sections: memoReady && memoArtifact
      ? [
          {
            id: 'memo',
            title: memoArtifact.title || PROGRAM_TITLE + ' Markdown Memo',
            text: memoArtifact.body,
            status: memoArtifact.status || 'drafted',
          },
        ]
      : [],
    memo_artifact: memoArtifact,
    workspace_artifact_items: finalArtifacts.map((artifact) => ({
      id: artifact.id,
      label: artifact.title,
      kind: 'markdown',
      status: artifact.status,
    })),
    completion_title: memoArtifact?.title || PROGRAM_TITLE + ' complete',
    completion_summary: memoReady
      ? 'Markdown memo drafted from recorded intake facts and ready for download.'
      : 'Memo output is not ready yet.',
    final_artifacts: finalArtifacts,
    completion_artifacts: finalArtifacts,
  };

  return { ...derived };
}

function phaseStatus(id: string, mode: string, complete: boolean): StageStatus {
  if (complete) return 'done';
  if (id === mode) return 'current';
  const phaseIndex = PHASES.findIndex(([phase]) => phase === id);
  const modeIndex = PHASES.findIndex(([phase]) => phase === mode);
  if (modeIndex >= 0 && phaseIndex >= 0 && phaseIndex < modeIndex) {
    return 'done';
  }
  return 'upcoming';
}

function checkpoint(label: string, complete: boolean): WorkspaceCheckpoint {
  return { label, complete, status: complete ? 'complete' : 'pending' };
}

function focusObjectFor(
  mode: string,
  memoArtifact: MemoArtifact | null,
  intakeFacts: Record<string, unknown>,
  status: string,
): FocusObject {
  const memoReady = Boolean(memoArtifact?.body);
  if (mode === 'complete') {
    return {
      id: PROGRAM_SLUG + '-complete-focus',
      program: PROGRAM_SLUG,
      phase: mode,
      kind: 'completion',
      title: memoArtifact?.title || PROGRAM_TITLE + ' complete',
      body: memoArtifact?.body || 'Session complete.',
      status: memoReady ? 'approved' : 'revising',
      actions: [],
    };
  }
  if (mode === 'draft_memo') {
    return {
      id: PROGRAM_SLUG + '-draft_memo-focus',
      program: PROGRAM_SLUG,
      phase: mode,
      kind: 'section',
      title: memoArtifact?.title || 'Draft Memo',
      body: memoArtifact?.body || 'Memo draft pending. Continue steering the drafter with user messages.',
      status: memoReady ? 'ready_for_review' : 'revising',
      actions: [],
    };
  }
  return {
    id: PROGRAM_SLUG + '-intake-focus',
    program: PROGRAM_SLUG,
    phase: mode,
    kind: 'schema_field',
    title: 'Memo Intake',
    body: intakeSummary(intakeFacts),
    status: Object.keys(intakeFacts).length > 0 || status === 'intake_recorded' ? 'ready_for_review' : 'revising',
    actions: [],
  };
}

function completionArtifacts(memoReady: boolean): CompletionArtifact[] {
  return memoReady
    ? [
        {
          id: STABLE_MEMO_ARTIFACT_ID,
          extension: '.md',
          title: 'Governed memo - Markdown',
          subtitle: 'Plain text memo source',
          status: 'ready',
        },
      ]
    : [];
}

function intakeSummary(intakeFacts: Record<string, unknown>): string {
  const rows = rowsFromRecord(intakeFacts);
  if (rows.length === 0) {
    return 'Share the facts, issue, audience, and requested conclusion for the memo.';
  }
  return 'Recorded facts: ' + rows.map((row) => row.label + ': ' + row.value).join('; ') + '.';
}

function rowsFromRecord(record: Record<string, unknown>): WorkspaceContentRow[] {
  return Object.entries(record).map(([label, value]) => ({
    label,
    value: valueToDisplay(value),
  }));
}

function valueToDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function readRecord(domain: DomainMap | Record<string, unknown>, path: string): Record<string, unknown> {
  const value = domain instanceof Map ? domain.get(path) : domain[path];
  return isRecord(value) ? value : {};
}

function readMemoArtifact(domain: DomainMap): MemoArtifact | null {
  const record = readRecord(domain, 'work.memo_artifact');
  if (Object.keys(record).length === 0) {
    return null;
  }
  return {
    id: readStringFromRecord(record, 'id') || 'memo-artifact',
    kind: readStringFromRecord(record, 'kind') || 'markdown',
    title: readStringFromRecord(record, 'title'),
    body: readStringFromRecord(record, 'body'),
    status: readStringFromRecord(record, 'status') || 'drafted',
  };
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

export function renderSimoneOsGovernedAttachSpecLoadTest(options: SimoneOsGovernedProgramOptions): string {
  const frontendPathExpectation = options.frontendSpecPath
    ? `    expect(entry.frontendSpecPath).toBe('${options.frontendSpecPath}');`
    : '    expect(entry.frontendSpecPath).toBeUndefined();';
  const manifestInteractiveExpectation = options.frontendSpecPath ? 'true' : 'false';
  const manifestKeywordExpectation = options.frontendSpecPath ? 'frontend' : 'backend';
  return `import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createProgramEntry } from '../registration.js';

interface RawSpec {
  patterns?: Array<{ use: string; as?: Record<string, unknown> }>;
  channels?: Record<string, unknown>;
  action_map?: Record<string, { description?: string }>;
}

function loadRawSpec(): RawSpec {
  return parse(readFileSync(resolve(__dirname, '../specs.yml'), 'utf8')) as RawSpec;
}

describe('${options.slug} spec load', () => {
  it('loads backend modes, terminal state, action map, and composition patterns', () => {
    const entry = createProgramEntry();
    const raw = loadRawSpec();

${frontendPathExpectation}
    expect(entry.projectionBuilder).toBeDefined();
    expect(entry.manifest).toMatchObject({
      interactive: ${manifestInteractiveExpectation},
      keywords: expect.arrayContaining(['memo', '${manifestKeywordExpectation}']),
    });
    expect(entry.spec.name).toBe('${options.slug}');
    expect(entry.spec.modes.has('intake')).toBe(true);
    expect(entry.spec.modes.has('draft_memo')).toBe(true);
    expect(entry.spec.modes.has('complete')).toBe(true);
    expect(entry.spec.terminal).toContain('complete');

    expect(entry.spec.modes.get('intake')?.vocabulary).toContain('record_intake');
    expect(entry.spec.modes.get('draft_memo')?.vocabulary).toContain('draft_memo');
    expect(entry.spec.modes.get('complete')?.vocabulary).toEqual([]);
    expect(entry.spec.action_map.get('record_intake')?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'MSet', path: 'work.intake.facts', from_arg: 'facts' }),
      expect.objectContaining({ op: 'MSet', path: 'work.intake_recorded', value: true }),
    ]));
    expect(entry.spec.action_map.get('draft_memo')?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'MSet', path: 'work.memo_artifact.id', from_arg: 'id' }),
      expect.objectContaining({ op: 'MSet', path: 'work.memo_artifact.kind', value: 'markdown' }),
      expect.objectContaining({ op: 'MSet', path: 'work.memo_artifact.title', from_arg: 'title' }),
      expect.objectContaining({ op: 'MSet', path: 'work.memo_artifact.body', from_arg: 'body' }),
      expect.objectContaining({ op: 'MSet', path: 'work.memo_artifact.status', from_arg: 'status' }),
    ]));

    expect(raw.patterns).toEqual([
      {
        use: 'control-plane-standard',
        as: {
          program: '${options.slug}',
          ask_channel: 'user_text',
          default_controls: ['ask', 'abort', 'new', 'history', 'status', 'help'],
          http_controls: ['ask', 'abort', 'history', 'status', 'help'],
        },
      },
    ]);
    expect(raw.channels).toHaveProperty('user_text');
    expect(raw.channels).toHaveProperty('widget_output');
    expect(raw.action_map?.draft_memo?.description).toMatch(/LLM-reasoning/i);
  });

  it('uses engine-native action mutations without custom handlers or tools', () => {
    const entry = createProgramEntry();

    expect(entry.reactionHandlers).toBeUndefined();
    expect(() => entry.createAdapters({ userId: 'u-test', sessionId: 's-test' })).not.toThrow();
  });
});
`;
}

export function renderSimoneOsGovernedAttachProjectionTest(options: SimoneOsGovernedProgramOptions): string {
  const projectionName = `${toCamelCase(options.slug)}Projection`;
  return `import { describe, expect, it } from 'vitest';
import type { DomainMap } from '@simodelne/pgas-server/plugin.js';
import { ${projectionName} } from '../projection.js';

function domain(entries: Record<string, unknown>): DomainMap {
  return new Map(Object.entries(entries)) as DomainMap;
}

describe('${projectionName}', () => {
  it('derives the complete governed memo frontend contract from domain state', () => {
    const derived = ${projectionName}(
      domain({
        'work.status': 'memo_drafted',
        'work.intake_recorded': true,
        'work.intake.facts': {
          client: 'Acme Corp',
          issue: 'Renewal recommendation',
        },
        'work.memo_artifact': {
          id: 'memo-001',
          kind: 'markdown',
          title: 'Renewal Recommendation',
          body: '## Recommendation\\nRenew Acme Corp.',
          status: 'drafted',
        },
      }),
      'complete',
      { state: { rounds: [] } },
    );

    expect(derived.focus_object).toMatchObject({
      id: '${options.slug}-complete-focus',
      program: '${options.slug}',
      phase: 'complete',
      kind: 'completion',
      title: 'Renewal Recommendation',
      body: expect.stringContaining('Renew Acme Corp'),
      status: 'approved',
      actions: [],
    });
    expect(derived.memo_artifact).toMatchObject({
      id: 'memo-001',
      kind: 'markdown',
      title: 'Renewal Recommendation',
      body: expect.stringContaining('Renew Acme Corp'),
      status: 'drafted',
    });
    expect(derived.status_banner).toMatchObject({
      tone: 'success',
      label: 'Memo drafted',
      detail: 'Renewal Recommendation',
    });
    expect(derived.workspace_context_tabs).toEqual([
      { id: 'session', label: 'Session' },
      { id: 'artifacts', label: 'Artifacts' },
      { id: 'stats', label: 'Stats' },
    ]);
    expect(derived.workspace_session_content).toEqual(expect.arrayContaining([
      { label: 'Current mode', value: 'complete' },
      { label: 'Memo status', value: 'memo_drafted' },
    ]));
    expect(derived.workspace_domain_content).toEqual(expect.arrayContaining([
      { label: 'client', value: 'Acme Corp' },
      { label: 'issue', value: 'Renewal recommendation' },
    ]));
    expect(derived.workspace_stat_items).toEqual(expect.arrayContaining([
      { label: 'Recorded facts', value: '2' },
      { label: 'Memo artifact', value: 'Ready' },
    ]));
    expect(derived.memo_sections).toEqual([
      {
        id: 'memo',
        title: 'Renewal Recommendation',
        text: '## Recommendation\\nRenew Acme Corp.',
        status: 'drafted',
      },
    ]);
    expect(derived.workspace_artifact_items).toEqual([
      {
        id: 'governed_memo_markdown',
        label: 'Governed memo - Markdown',
        kind: 'markdown',
        status: 'ready',
      },
    ]);
    expect(derived.phase_steps).toEqual([
      { id: 'intake', label: 'Intake', status: 'done' },
      { id: 'draft_memo', label: 'Draft Memo', status: 'done' },
      { id: 'complete', label: 'Complete', status: 'done' },
    ]);
    expect(derived.workspace_checkpoints).toEqual([
      { label: 'Intake facts recorded', complete: true, status: 'complete' },
      { label: 'Memo artifact drafted', complete: true, status: 'complete' },
    ]);
    expect(derived.completion_title).toBe('Renewal Recommendation');
    expect(derived.completion_summary).toContain('Markdown memo drafted from recorded intake facts');
    expect(derived.final_artifacts).toEqual([
      {
        id: 'governed_memo_markdown',
        extension: '.md',
        title: 'Governed memo - Markdown',
        subtitle: 'Plain text memo source',
        status: 'ready',
      },
    ]);
    expect(derived.completion_artifacts).toEqual(derived.final_artifacts);
  });

  it('keeps draft mode frontend fields explicit before the memo is drafted', () => {
    const derived = ${projectionName}(
      domain({
        'work.status': 'intake_recorded',
        'work.intake_recorded': true,
        'work.intake.facts': {
          topic: 'Risk summary',
        },
      }),
      'draft_memo',
      { state: { rounds: [] } },
    );

    expect(derived.memo_artifact).toBeNull();
    expect(derived.workspace_artifact_items).toEqual([]);
    expect(derived.completion_artifacts).toEqual([]);
    expect(derived.final_artifacts).toEqual([]);
    expect(derived.memo_sections).toEqual([]);
    expect(derived.focus_object).toMatchObject({
      id: '${options.slug}-draft_memo-focus',
      program: '${options.slug}',
      phase: 'draft_memo',
      kind: 'section',
      title: 'Draft Memo',
      status: 'revising',
      actions: [],
    });
    expect(derived.status_banner).toMatchObject({
      tone: 'info',
      label: 'In progress',
      detail: 'Currently in draft memo.',
    });
    expect(derived.phase_steps).toEqual([
      { id: 'intake', label: 'Intake', status: 'done' },
      { id: 'draft_memo', label: 'Draft Memo', status: 'current' },
      { id: 'complete', label: 'Complete', status: 'upcoming' },
    ]);
    for (const step of derived.phase_steps as Array<{ status: string }>) {
      expect(['done', 'current', 'upcoming']).toContain(step.status);
    }
    expect(derived.workspace_checkpoints).toEqual([
      { label: 'Intake facts recorded', complete: true, status: 'complete' },
      { label: 'Memo artifact drafted', complete: false, status: 'pending' },
    ]);
    expect(derived.workspace_domain_content).toEqual([
      { label: 'topic', value: 'Risk summary' },
    ]);
    expect(derived.workspace_stat_items).toEqual(expect.arrayContaining([
      { label: 'Recorded facts', value: '1' },
      { label: 'Memo artifact', value: 'Pending' },
    ]));
  });
});
`;
}

export function renderSimoneOsGovernedAttachCuratorRequest(options: SimoneOsGovernedProgramOptions): string {
  const registryImport = `import { createProgramEntry as create${toPascalCase(options.slug)}ProgramEntry } from '../../../programs/${options.slug}/registration.js';`;
  const registryRegister = `registry.register('${options.slug}', asRegisterableProgramEntry(create${toPascalCase(options.slug)}ProgramEntry()));`;
  const loadcheckImport = `import { createProgramEntry as create${toPascalCase(options.slug)} } from '../programs/${options.slug}/registration.js';`;
  const loadcheckRosterEntry = `{ name: '${options.slug}',         load: () => create${toPascalCase(options.slug)}() },`;
  const frontendArtifactBullet = options.frontendSpecPath
    ? `- \`programs/${options.slug}/frontend.spec.yml\`\n- \`qc/facts/${options.slug}.facts.yml\`\n- \`qc/e2e-frontend/${options.slug}.scenario.yml\`\n`
    : '';
  const frontendBoundaryNote = options.frontendSpecPath
    ? `## Frontend Boundary Note

This generated program includes a program-local \`frontend.spec.yml\`, sets \`frontendSpecPath: '${options.frontendSpecPath}'\` in \`programs/${options.slug}/registration.ts\`, and directly emits the paired program QC files \`qc/facts/${options.slug}.facts.yml\` plus \`qc/e2e-frontend/${options.slug}.scenario.yml\`. The central frontend runtime, frontend roster, display-name registry, coverage matrix, user-facing roster, backend registry, specs-loadcheck roster, drift, and integrity updates remain curator-owned text below.
`
    : `## Backend-Only QC Note

This generated program is backend-only. pgas-new intentionally emitted no \`frontend.spec.yml\`, no \`frontendSpecPath\`, no \`qc/facts/${options.slug}.facts.yml\`, no \`qc/e2e-frontend/${options.slug}.scenario.yml\`, no \`qc/e2e-coverage.yml\` entry, and no V2 frontend roster entry. If SimoneOS policy requires every registered program to be user-facing, treat that as a SimoneOS backend-only program policy finding rather than adding frontend/QC placeholders.
`;
  const frontendCuratorSections = options.frontendSpecPath ? renderFrontendCuratorSections(options) : '';
  const frontendUnifiedDiffShape = options.frontendSpecPath ? renderFrontendUnifiedDiffShape(options) : '';

  return `# PGAS-New Curator Request: ${options.name}

Boundary: CURATOR-REQUEST. pgas-new generated SimoneOS-conformant program artifacts and did not edit SimoneOS central files.

Program: \`${options.slug}\`
Generated program directory: \`programs/${options.slug}\`

## Generated Artifacts

- \`programs/${options.slug}/specs.yml\`
- \`programs/${options.slug}/registration.ts\`
- \`programs/${options.slug}/projection.ts\`
${frontendArtifactBullet}- \`programs/${options.slug}/__tests__/spec-load.test.ts\`
- \`programs/${options.slug}/__tests__/projection.test.ts\`

${frontendBoundaryNote}

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

${frontendCuratorSections}

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
${frontendUnifiedDiffShape}
\`\`\`

## Curator QC Commands

\`\`\`bash
tsx qc/integrity.ts --rotate --reason "Pre-rotate governed-memo-mini curator patch before drift update"
tsx qc/drift-check.ts --update
tsx qc/integrity.ts --rotate --reason "Register governed-memo-mini from pgas-new governed attach"
\`\`\`
`;
}

function renderFrontendCuratorSections(options: SimoneOsGovernedProgramOptions): string {
  const rendererPath = `frontend/src/runtime/docx-authoring/register-${options.slug}.ts`;
  const rendererTestPath = `frontend/src/runtime/docx-authoring/__tests__/register-${options.slug}.test.ts`;
  const mainImport = `import './runtime/docx-authoring/register-${options.slug}';`;
  const rendererSymbol = rendererSymbolForSlug(options.slug);
  return [
    `### \`${rendererPath}\``,
    '',
    'Create this file:',
    '',
    '~~~ts',
    renderGovernedMemoMarkdownRendererSource({ slug: options.slug, rendererSymbol }),
    '~~~',
    '',
    `### \`${rendererTestPath}\``,
    '',
    'Create this test file:',
    '',
    '~~~ts',
    renderGovernedMemoMarkdownRendererTestSource({ slug: options.slug, rendererSymbol }),
    '~~~',
    '',
    '### `frontend/src/main.tsx`',
    '',
    'Insert this side-effect import after the existing due-diligence-report renderer import:',
    '',
    'Anchor:',
    '~~~ts',
    "import './runtime/docx-authoring/register-due-diligence-report';",
    '~~~',
    '',
    'Insert after anchor:',
    '~~~ts',
    mainImport,
    '~~~',
    '',
    '### `qc/e2e-coverage.yml`',
    '',
    'Insert this user-facing roster entry after `fee-proposal-drafter`:',
    '',
    '~~~yaml',
    `  - ${options.slug}`,
    '~~~',
    '',
    'Insert this program coverage block after the existing `fee-proposal-drafter` block and before `legal-memo`:',
    '',
    '~~~yaml',
    `  ${options.slug}:`,
    `    facts: qc/facts/${options.slug}.facts.yml`,
    '    e2e-frontend:',
    '      channels: [frontend]',
    '      required: true',
    '~~~',
    '',
    '### `qc/USER_FACING_PROGRAMS.txt`',
    '',
    'Insert this roster line after `fee-proposal-drafter`:',
    '',
    '~~~text',
    options.slug,
    '~~~',
    '',
    '### `frontend/src/runtime/cutover/v2-programs.ts`',
    '',
    'Insert this V2 roster entry after `fee-proposal-drafter`:',
    '',
    '~~~ts',
    `  '${options.slug}',`,
    '~~~',
    '',
    '### `frontend/src/lib/programNames.ts`',
    '',
    'Insert this canonical display-name entry after `fee-proposal-drafter`:',
    '',
    '~~~ts',
    `  '${options.slug}': ${tsString(options.name)},`,
    '~~~',
  ].join('\n');
}

function renderFrontendUnifiedDiffShape(options: SimoneOsGovernedProgramOptions): string {
  return [
    'diff --git a/frontend/src/main.tsx b/frontend/src/main.tsx',
    '--- a/frontend/src/main.tsx',
    '+++ b/frontend/src/main.tsx',
    '@@',
    " import './runtime/docx-authoring/register-due-diligence-report';",
    `+import './runtime/docx-authoring/register-${options.slug}';`,
    'diff --git a/qc/e2e-coverage.yml b/qc/e2e-coverage.yml',
    '--- a/qc/e2e-coverage.yml',
    '+++ b/qc/e2e-coverage.yml',
    '@@',
    '   - fee-proposal-drafter',
    `+  - ${options.slug}`,
    '   - legal-memo',
    '@@',
    '   fee-proposal-drafter:',
    '     facts: qc/facts/fee-proposal-drafter.facts.yml',
    '     e2e-frontend:',
    '       channels: [frontend]',
    '       required: true',
    '+',
    `+  ${options.slug}:`,
    `+    facts: qc/facts/${options.slug}.facts.yml`,
    '+    e2e-frontend:',
    '+      channels: [frontend]',
    '+      required: true',
    '+',
    '   legal-memo:',
    'diff --git a/qc/USER_FACING_PROGRAMS.txt b/qc/USER_FACING_PROGRAMS.txt',
    '--- a/qc/USER_FACING_PROGRAMS.txt',
    '+++ b/qc/USER_FACING_PROGRAMS.txt',
    '@@',
    ' fee-proposal-drafter',
    `+${options.slug}`,
    'diff --git a/frontend/src/runtime/cutover/v2-programs.ts b/frontend/src/runtime/cutover/v2-programs.ts',
    '--- a/frontend/src/runtime/cutover/v2-programs.ts',
    '+++ b/frontend/src/runtime/cutover/v2-programs.ts',
    '@@',
    "   'fee-proposal-drafter',",
    `+  '${options.slug}',`,
    'diff --git a/frontend/src/lib/programNames.ts b/frontend/src/lib/programNames.ts',
    '--- a/frontend/src/lib/programNames.ts',
    '+++ b/frontend/src/lib/programNames.ts',
    '@@',
    "   'fee-proposal-drafter': 'Fee Proposal Drafter',",
    `+  '${options.slug}': ${tsString(options.name)},`,
  ].join('\n');
}

function renderGovernedMemoMarkdownRendererSource(options: { slug: string; rendererSymbol: string }): string {
  return [
    "import {",
    "  registerArtifactRenderer,",
    "  type ArtifactRenderResult,",
    "} from '../host/artifact-renderer';",
    '',
    'type RecordValue = Record<string, unknown>;',
    '',
    `export function ${options.rendererSymbol}(): void {`,
    "  registerArtifactRenderer('governed_memo_markdown', (domain) => {",
    "    const artifact = readRecord(domain.get('work.memo_artifact'));",
    "    const body = readString(domain.get('work.memo_artifact.body')) || readString(artifact.body);",
    '    if (!body) return null;',
    "    const title = readString(domain.get('work.memo_artifact.title')) || readString(artifact.title) || 'Governed Memo';",
    '',
    '    return {',
    "      filename: slugify(title) + '.md',",
    '      content: body,',
    "      mimeType: 'text/markdown;charset=utf-8',",
    '    } satisfies ArtifactRenderResult;',
    '  });',
    '}',
    '',
    'function readRecord(value: unknown): RecordValue {',
    "  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RecordValue;",
    '  return {};',
    '}',
    '',
    'function readString(value: unknown): string {',
    "  return typeof value === 'string' ? value.trim() : '';",
    '}',
    '',
    'function slugify(value: string): string {',
    "  const base = (value || 'governed-memo')",
    '    .trim()',
    "    .replace(/\\s+/g, '-')",
    "    .replace(/[^A-Za-z0-9._-]/g, '')",
    "    .replace(/-+/g, '-')",
    "    .replace(/^[-.]+|[-.]+$/g, '')",
    '    .slice(0, 80);',
    "  return base.length > 0 ? base : 'governed-memo';",
    '}',
    '',
    `${options.rendererSymbol}();`,
  ].join('\n');
}

function renderGovernedMemoMarkdownRendererTestSource(options: { slug: string; rendererSymbol: string }): string {
  return [
    "import { afterEach, beforeEach, describe, expect, it } from 'vitest';",
    "import {",
    "  renderArtifact,",
    "  _clearArtifactRendererRegistryForTests,",
    "} from '../../host/artifact-renderer';",
    `import { ${options.rendererSymbol} } from '../register-${options.slug}';`,
    '',
    'function makeDomain(entries: Array<[string, unknown]>): ReadonlyMap<string, unknown> {',
    '  return new Map(entries);',
    '}',
    '',
    `describe('${options.slug} Markdown renderer', () => {`,
    '  beforeEach(() => {',
    '    _clearArtifactRendererRegistryForTests();',
    `    ${options.rendererSymbol}();`,
    '  });',
    '',
    '  afterEach(() => {',
    '    _clearArtifactRendererRegistryForTests();',
    '  });',
    '',
    "  it('renders the memo artifact body as markdown', async () => {",
    '    const domain = makeDomain([',
    "      ['work.memo_artifact.title', 'Renewal Recommendation'],",
    "      ['work.memo_artifact.body', '## Recommendation\\nRenew Acme Corp.'],",
    '    ]);',
    "    const artifact = await renderArtifact(domain, 'governed_memo_markdown');",
    '',
    '    expect(artifact).not.toBeNull();',
    "    expect(artifact!.filename).toBe('Renewal-Recommendation.md');",
    "    expect(artifact!.mimeType).toBe('text/markdown;charset=utf-8');",
    "    expect(artifact!.content).toBe('## Recommendation\\nRenew Acme Corp.');",
    '  });',
    '',
    "  it('returns null when the memo body is absent', async () => {",
    '    const artifact = await renderArtifact(makeDomain([',
    "      ['work.memo_artifact.title', 'Missing Body'],",
    "    ]), 'governed_memo_markdown');",
    '',
    '    expect(artifact).toBeNull();',
    '  });',
    '});',
  ].join('\n');
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

function rendererSymbolForSlug(slug: string): string {
  return `register${toPascalCase(slug)}Renderers`;
}

function toConstantPrefix(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase())
    .join('_');
}

function renderTsValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(renderTsValue).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => `${key}: ${renderTsValue(entryValue)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof value === 'string') {
    return tsString(value);
  }
  return JSON.stringify(value);
}

function tsString(value: string): string {
  return JSON.stringify(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
