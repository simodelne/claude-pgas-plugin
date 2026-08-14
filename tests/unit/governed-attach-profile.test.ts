import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderExistingRepoAttachment } from '../../src/pgas-new/template-renderer.js';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const SIMONEOS_MANIFEST: WiringManifest = {
  schema_version: 1,
  repo: { kind: 'existing_repo', package_manager: 'npm' },
  pgas: {
    server_package: '@simodelne/pgas-server',
    allowed_imports: [
      '@simodelne/pgas-server/plugin.js',
      '@simodelne/pgas-server/create-server.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/channels/index.js',
      '@simodelne/pgas-server/routes/index.js',
    ],
  },
  paths: {
    programs_dir: 'programs',
    audit_dir: 'audit',
    pgas_new_dir: '.pgas/pgas-new',
  },
  registration: { strategy: 'curator_request' },
  verification: {
    commands: {
      install: 'npm install --no-audit --no-fund',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    },
  },
  curator: { github_owner: 'simodelne', github_repo: 'simoneos' },
};

interface ParsedSpec {
  name: string;
  initial: string;
  terminal: string[];
  patterns?: Array<{ use: string; as?: Record<string, unknown> }>;
  channels: Record<string, unknown>;
  modes: Record<string, {
    vocabulary: string[];
    channels: string[];
    transitions?: Array<{ target: string; guard: { kind: string; path: string } }>;
  }>;
  schema: Record<string, string>;
  ingestion: Record<string, string[]>;
  action_map: Record<string, {
    description?: string;
    channel?: string;
    result_path?: string;
    mutations?: Array<{ op: string; path: string; value?: unknown; from_arg?: string }>;
  }>;
  guidance: Record<string, string[]>;
  prompts: Record<string, string>;
  projection?: Record<string, { include: string[]; exclude: string[] }>;
  view?: Array<{ key: string; from: string; label?: string }>;
  control_plane?: unknown;
}

interface FrontendWidget {
  widget: string;
  bind?: Record<string, unknown>;
  actions?: Array<{ label?: string; trigger?: { type?: string; name?: string; channel?: string }; emit?: string }>;
}

interface FrontendMode {
  layout: string;
  focus?: { enabled?: boolean };
  side?: FrontendWidget[];
  primary?: FrontendWidget[];
  secondary?: FrontendWidget[];
}

interface FrontendSpec {
  program: string;
  display?: { title?: string };
  modes: Record<string, FrontendMode>;
}

type GovernedFrontendRenderOptions = Parameters<typeof renderExistingRepoAttachment>[0] & {
  governedAttachFrontendMode?: 'backend-only' | 'user-facing';
};

describe('SimoneOS governed attach profile', () => {
  it('translates the minimal foundry stage model into a SimoneOS-composed backend specs.yml', () => {
    const artifact = synthesizeProgramSpecFromDomain(minimalGovernedMemoDomain());
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-governed-attach-'));
    try {
      const result = renderExistingRepoAttachment({
        repoRoot,
        manifest: SIMONEOS_MANIFEST,
        slug: 'governed-memo-mini',
        name: 'Governed Memo Mini',
        targetProfile: 'simoneos-governed-attach',
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedSynthesisContext: artifact.synthesis_context,
      });

      expect(result.written).toEqual([
        'programs/governed-memo-mini/specs.yml',
        'programs/governed-memo-mini/registration.ts',
        'programs/governed-memo-mini/projection.ts',
        'programs/governed-memo-mini/__tests__/spec-load.test.ts',
        'programs/governed-memo-mini/__tests__/projection.test.ts',
        'audit/PGAS-NEW-governed-memo-mini.curator-request.md',
      ]);
      expect(result.written).not.toEqual(expect.arrayContaining([
        'programs/governed-memo-mini/handlers.ts',
        'programs/governed-memo-mini/handlers/index.ts',
        'programs/governed-memo-mini/handlers/_resolver.ts',
        'programs/governed-memo-mini/tools.ts',
        'programs/governed-memo-mini/frontend.spec.yml',
        'tests/governed-memo-mini-deterministic.test.ts',
        'tests/live-provider.test.ts',
        'qc/e2e-frontend/governed-memo-mini.scenario.yml',
        'qc/facts/governed-memo-mini.facts.yml',
        'qc/e2e-coverage.yml',
        'frontend/src/runtime/cutover/v2-programs.ts',
      ]));
      for (const writtenPath of result.written) {
        expect(writtenPath).not.toMatch(/(?:^|\/)(?:live|e2e)(?:[-.]|\/)|(?:[-.])(?:live|e2e)(?:[-.]|$)/u);
      }

      const source = readFileSync(join(repoRoot, 'programs/governed-memo-mini/specs.yml'), 'utf8');
      const parsed = load(source) as ParsedSpec;

      expect(parsed.patterns).toEqual([
        {
          use: 'control-plane-standard',
          as: {
            program: 'governed-memo-mini',
            ask_channel: 'user_text',
            default_controls: ['ask', 'abort', 'new', 'history', 'status', 'help'],
            http_controls: ['ask', 'abort', 'history', 'status', 'help'],
          },
        },
      ]);
      expect(parsed.control_plane).toBeUndefined();

      expect(parsed.name).toBe('governed-memo-mini');
      expect(parsed.initial).toBe('intake');
      expect(parsed.terminal).toEqual(['complete']);
      expect(Object.keys(parsed.modes)).toEqual(['intake', 'draft_memo', 'complete']);
      expect(parsed.modes.intake.transitions).toEqual([
        { target: 'draft_memo', guard: { kind: 'FieldTruthy', path: 'work.intake_recorded' } },
      ]);
      expect(parsed.modes.draft_memo.transitions).toEqual([
        { target: 'complete', guard: { kind: 'FieldTruthy', path: 'work.memo_artifact.status' } },
      ]);

      expect(Object.keys(parsed.channels).sort()).toEqual([
        'system_mode_entry',
        'user_confirmation',
        'user_messages',
        'user_text',
        'widget_output',
      ]);
      expect(source).not.toMatch(/frontend_intake|document_upload|delegation|review_call|research_call|e2e-frontend|qc\/facts/u);

      expect(parsed.ingestion).toEqual({
        user_text: ['inputs.user_text'],
        user_messages: ['inputs.user_message_latest'],
        user_confirmation: ['inputs.user_decision.decision', 'inputs.user_decision.instruction'],
        system_mode_entry: ['inputs.mode_entry'],
      });
      expect(parsed.schema).toMatchObject({
        'inputs.user_text': 'string',
        'inputs.user_message_latest': 'string',
        'inputs.user_decision.decision': 'string',
        'inputs.user_decision.instruction': 'string',
        'inputs.mode_entry': 'object',
        'work.intake': 'object',
        'work.intake.facts': 'object',
        'work.intake_recorded': 'boolean',
        'work.memo_artifact': 'object',
        'work.memo_artifact.id': 'string',
        'work.memo_artifact.kind': 'string',
        'work.memo_artifact.title': 'string',
        'work.memo_artifact.body': 'string',
        'work.memo_artifact.status': 'string',
      });

      expect(parsed.action_map.record_intake.channel).toBe('widget_output');
      expect(parsed.action_map.record_intake.mutations).toEqual(expect.arrayContaining([
        { op: 'MSet', path: 'work.intake.facts', value: {}, from_arg: 'facts' },
        { op: 'MSet', path: 'work.intake_recorded', value: true },
      ]));
      expect(parsed.action_map.draft_memo.description).toMatch(/llm-reasoning/i);
      expect(parsed.action_map.draft_memo.channel).toBe('widget_output');
      expect(parsed.action_map.draft_memo.result_path).toBeUndefined();
      expect(parsed.action_map.draft_memo.mutations).toEqual(expect.arrayContaining([
        { op: 'MSet', path: 'work.memo_artifact.id', value: '', from_arg: 'id' },
        { op: 'MSet', path: 'work.memo_artifact.kind', value: 'markdown' },
        { op: 'MSet', path: 'work.memo_artifact.title', value: '', from_arg: 'title' },
        { op: 'MSet', path: 'work.memo_artifact.body', value: '', from_arg: 'body' },
        { op: 'MSet', path: 'work.memo_artifact.status', value: 'drafted', from_arg: 'status' },
      ]));

      expect(parsed.guidance.intake).toEqual(expect.arrayContaining([
        '$ref(core.query-first)',
        '$ref(core.terminal-action-invariant)',
      ]));
      expect(parsed.guidance.draft_memo).toEqual(expect.arrayContaining([
        '$ref(core.query-first)',
        '$ref(core.reasoning-required)',
        '$ref(core.terminal-action-invariant)',
      ]));
      expect(source).not.toContain('QUERY-FIRST RULE');
      expect(parsed.prompts.draft_memo).toContain('$ref(core.query-first)');
      expect(parsed.projection).toEqual({
        intake: {
          include: expect.arrayContaining(['inputs.user_text', 'inputs.user_message_latest', 'work.intake', 'work.intake_recorded']),
          exclude: [],
        },
        draft_memo: {
          include: expect.arrayContaining(['work.intake', 'work.intake.facts', 'work.memo_artifact', 'decisions.reasoning']),
          exclude: [],
        },
        complete: {
          include: expect.arrayContaining(['work.memo_artifact', 'work.status']),
          exclude: [],
        },
      });
      expect(parsed.view).toBeUndefined();

      const registration = readFileSync(join(repoRoot, 'programs/governed-memo-mini/registration.ts'), 'utf8');
      expect(registration).toContain("import { createProgramAdapters, enableNotebook, loadSpecWithPatterns, type ProgramEntry } from '@simodelne/pgas-server/plugin.js';");
      expect(registration).toContain('export function createProgramEntry(): ProgramEntry');
      expect(registration).toContain('const GOVERNED_MEMO_MINI_VIEW_PROFILE');
      expect(registration).toContain("loadSpecWithPatterns(path.join(dirname, 'specs.yml'))");
      expect(registration).toContain('viewProfile: GOVERNED_MEMO_MINI_VIEW_PROFILE');
      expect(registration).toContain('{ key: "work_status", from: "work.status", label: "Work Status" }');
      expect(registration).toContain('{ key: "memo_body", from: "work.memo_artifact.body", label: "Memo Body" }');
      expect(registration).toContain('projectionBuilderMigration:');
      expect(registration).toContain('trackingIssue: \'docs/ENGINE-DECLARATION-CATALOG.md#declarative-projection\'');
      expect(registration).toContain('"status_banner"');
      expect(registration).toContain('"completion_artifacts"');
      expect(registration).toContain('projectionBuilder: governedMemoMiniProjection');
      expect(registration).toContain('manifest: GOVERNED_MEMO_MINI_MANIFEST');
      expect(registration).toContain('presentation: GOVERNED_MEMO_MINI_PRESENTATION');
      expect(registration).toContain('artifactPolicy: GOVERNED_MEMO_MINI_ARTIFACT_POLICY');
      expect(registration).toContain('surrogatePolicy: GOVERNED_MEMO_MINI_SURROGATE_POLICY');
      expect(registration).toContain('continuationPolicy: GOVERNED_MEMO_MINI_CONTINUATION_POLICY');
      expect(registration).not.toContain('frontendSpecPath');
      expect(registration).not.toContain('createGovernedMemoMiniProgramEntry');
      expect(registration).not.toContain('../src/programs');

      const projection = readFileSync(join(repoRoot, 'programs/governed-memo-mini/projection.ts'), 'utf8');
      expect(projection).toContain("import type { DerivedMap, DomainMap, ProjectionBuilder } from '@simodelne/pgas-server/plugin.js';");
      expect(projection).toContain('export const governedMemoMiniProjection: ProjectionBuilder');
      expect(projection).toContain("'work.memo_artifact'");
      expect(projection).not.toMatch(/from ['"](?:\.{1,2}\/|\/)[^'"]*(?:server|frontend)[^'"]*['"]/u);
      expect(projection).toContain('interface GovernedMemoMiniDerived');
      expect(projection).toContain('memo_artifact: MemoArtifact | null');

      const specLoadTest = readFileSync(join(repoRoot, 'programs/governed-memo-mini/__tests__/spec-load.test.ts'), 'utf8');
      expect(specLoadTest).toContain("import { createProgramEntry } from '../registration.js';");
      expect(specLoadTest).toContain("expect(entry.spec.name).toBe('governed-memo-mini')");
      expect(specLoadTest).toContain("expect(entry.spec.modes.has('intake')).toBe(true)");
      expect(specLoadTest).toContain("expect(entry.spec.modes.has('draft_memo')).toBe(true)");
      expect(specLoadTest).toContain("expect(entry.spec.modes.has('complete')).toBe(true)");
      expect(specLoadTest).toContain("expect(entry.spec.terminal).toContain('complete')");
      expect(specLoadTest).toContain("expect(entry.spec.action_map.get('draft_memo')?.mutations)");
      expect(specLoadTest).toContain("expect(raw.patterns).toEqual(");
      expect(specLoadTest).toContain("expect(() => entry.createAdapters({ userId: 'u-test', sessionId: 's-test' })).not.toThrow()");
      expect(specLoadTest).not.toMatch(/(?:^|[-.])(live|e2e)([-.]|$)/u);

      const projectionTest = readFileSync(join(repoRoot, 'programs/governed-memo-mini/__tests__/projection.test.ts'), 'utf8');
      expect(projectionTest).toContain("import type { DomainMap } from '@simodelne/pgas-server/plugin.js';");
      expect(projectionTest).toContain("import { governedMemoMiniProjection } from '../projection.js';");
      expect(projectionTest).toContain("'work.memo_artifact'");
      expect(projectionTest).toContain("expect(derived.memo_artifact).toMatchObject({");
      expect(projectionTest).toContain("expect(derived.workspace_artifact_items).toEqual([");
      expect(projectionTest).toContain("expect(derived.phase_steps).toEqual([");
      expect(projectionTest).toContain('focus_object');
      expect(projectionTest).toContain('workspace_context_tabs');
      expect(projectionTest).toContain('completion_artifacts');
      expect(projectionTest).toContain('governed_memo_markdown');
      expect(projectionTest).not.toMatch(/(?:^|[-.])(live|e2e)([-.]|$)/u);

      const curatorRequest = readFileSync(join(repoRoot, 'audit/PGAS-NEW-governed-memo-mini.curator-request.md'), 'utf8');
      expect(curatorRequest).toContain('Boundary: CURATOR-REQUEST');
      expect(curatorRequest).toContain("server/src/registrations/index.ts");
      expect(curatorRequest).toContain("import { createProgramEntry as createGovernedMemoMiniProgramEntry } from '../../../programs/governed-memo-mini/registration.js';");
      expect(curatorRequest).toContain("registry.register('governed-memo-mini', asRegisterableProgramEntry(createGovernedMemoMiniProgramEntry()));");
      expect(curatorRequest).toContain("scripts/specs-loadcheck.ts");
      expect(curatorRequest).toContain("import { createProgramEntry as createGovernedMemoMini } from '../programs/governed-memo-mini/registration.js';");
      expect(curatorRequest).toContain("{ name: 'governed-memo-mini',         load: () => createGovernedMemoMini() },");
      expect(curatorRequest).toContain('tsx qc/drift-check.ts --update');
      expect(curatorRequest).toContain('tsx qc/integrity.ts --rotate --reason "Register governed-memo-mini from pgas-new governed attach"');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('emits the governed memo frontend spec and frontendSpecPath only in user-facing mode', () => {
    const backendOnlyRepo = mkdtempSync(join(tmpdir(), 'pgas-new-governed-attach-backend-'));
    const userFacingRepo = mkdtempSync(join(tmpdir(), 'pgas-new-governed-attach-frontend-'));
    try {
      const backendOnly = renderGovernedMemoAttachment(backendOnlyRepo);
      expect(backendOnly.written).not.toContain('programs/governed-memo-mini/frontend.spec.yml');
      expect(backendOnly.written).not.toContain('qc/facts/governed-memo-mini.facts.yml');
      expect(backendOnly.written).not.toContain('qc/e2e-frontend/governed-memo-mini.scenario.yml');
      expect(existsSync(join(backendOnlyRepo, 'programs/governed-memo-mini/frontend.spec.yml'))).toBe(false);
      expect(existsSync(join(backendOnlyRepo, 'qc/facts/governed-memo-mini.facts.yml'))).toBe(false);
      expect(existsSync(join(backendOnlyRepo, 'qc/e2e-frontend/governed-memo-mini.scenario.yml'))).toBe(false);
      expect(readFileSync(join(backendOnlyRepo, 'programs/governed-memo-mini/registration.ts'), 'utf8')).not.toContain('frontendSpecPath');
      const backendOnlyCuratorRequest = readFileSync(join(backendOnlyRepo, 'audit/PGAS-NEW-governed-memo-mini.curator-request.md'), 'utf8');
      expect(backendOnlyCuratorRequest).not.toContain('register-governed-memo-mini');
      expect(backendOnlyCuratorRequest).not.toContain('qc/USER_FACING_PROGRAMS.txt');
      expect(backendOnlyCuratorRequest).not.toContain('frontend/src/runtime/cutover/v2-programs.ts');

      const userFacing = renderGovernedMemoAttachment(userFacingRepo, { governedAttachFrontendMode: 'user-facing' });
      expect(userFacing.written).toContain('programs/governed-memo-mini/frontend.spec.yml');
      expect(userFacing.written).toContain('qc/facts/governed-memo-mini.facts.yml');
      expect(userFacing.written).toContain('qc/e2e-frontend/governed-memo-mini.scenario.yml');
      expect(userFacing.written).not.toEqual(expect.arrayContaining([
        'qc/e2e-coverage.yml',
        'qc/USER_FACING_PROGRAMS.txt',
        'frontend/src/runtime/cutover/v2-programs.ts',
        'frontend/src/lib/programNames.ts',
        'frontend/src/runtime/docx-authoring/register-governed-memo-mini.ts',
        'frontend/src/runtime/docx-authoring/__tests__/register-governed-memo-mini.test.ts',
        'frontend/src/main.tsx',
      ]));

      const registration = readFileSync(join(userFacingRepo, 'programs/governed-memo-mini/registration.ts'), 'utf8');
      expect(registration).toContain('frontendSpecPath: "programs/governed-memo-mini"');

      const frontendSpec = load(readFileSync(join(userFacingRepo, 'programs/governed-memo-mini/frontend.spec.yml'), 'utf8')) as FrontendSpec;
      expect(frontendSpec.program).toBe('governed-memo-mini');
      expect(frontendSpec.modes.intake.layout).toBe('workspace-3col');
      expect(frontendSpec.modes.draft_memo.layout).toBe('workspace-3col');
      expect(frontendSpec.modes.complete.layout).toBe('workspace-3col');
      expect(frontendSpec.modes.intake.side?.[0]?.widget).toBe('workspace-sidebar');
      expect(frontendSpec.modes.draft_memo.side?.[0]?.widget).toBe('workspace-sidebar');
      expect(frontendSpec.modes.intake.secondary?.[0]?.widget).toBe('workspace-context');
      expect(frontendSpec.modes.draft_memo.secondary?.[0]?.widget).toBe('workspace-context');
      expect(frontendSpec.modes.complete.primary?.[0]?.widget).toBe('completion-celebration');
      expect(frontendSpec.modes.complete.secondary?.[0]?.widget).toBe('workspace-context');
      expect(frontendSpec.modes.complete.secondary?.[1]).toMatchObject({
        widget: 'artifact-list',
        bind: {
          variant: 'literal:list',
          items: 'derived.completion_artifacts',
        },
        actions: [
          {
            trigger: { type: 'action', name: 'download_session_artifact' },
            emit: 'download',
          },
        ],
      });
      expect(JSON.stringify(frontendSpec)).not.toMatch(/approval/u);

      const facts = load(readFileSync(join(userFacingRepo, 'qc/facts/governed-memo-mini.facts.yml'), 'utf8')) as {
        program?: string;
        facts?: Record<string, unknown>;
      };
      expect(facts.program).toBe('governed-memo-mini');
      expect(facts.facts).toMatchObject({
        client: 'Acme Corp',
        issue: 'Renewal recommendation',
        audience: 'General Counsel',
        assumption: 'Only the provided renewal facts may be used.',
        required_conclusion: 'Renew the agreement with the negotiated liability cap.',
      });

      const scenario = load(readFileSync(join(userFacingRepo, 'qc/e2e-frontend/governed-memo-mini.scenario.yml'), 'utf8')) as {
        extends?: string;
        program?: string;
        channel?: string;
        kickoff_prompt?: string;
        user_responses?: unknown[];
        expected?: {
          modes_visited?: string[];
          final_artifacts?: Array<{ domain_path?: string; contains_keywords?: string[] }>;
        };
        llm_responder?: unknown;
      };
      expect(scenario.extends).toBe('../facts/governed-memo-mini.facts.yml');
      expect(scenario.program).toBe('governed-memo-mini');
      expect(scenario.channel).toBe('frontend');
      expect(scenario.kickoff_prompt).toContain('Acme Corp');
      expect(scenario.kickoff_prompt).toContain('Renewal recommendation');
      expect(scenario.kickoff_prompt).toContain('General Counsel');
      expect(scenario.user_responses).toEqual([
        {
          match: { widget_kind: 'notice' },
          action: 'approve',
        },
        {
          match: { widget_kind: 'confirmation' },
          action: 'approve',
        },
      ]);
      expect(scenario.expected?.modes_visited).toEqual(['intake', 'draft_memo', 'complete']);
      expect(scenario.expected?.final_artifacts).toEqual([
        {
          kind: 'memo_markdown',
          domain_path: 'work.memo_artifact.body',
          contains_keywords: ['Acme Corp', 'Renewal recommendation', 'liability cap'],
        },
      ]);
      expect(scenario.llm_responder).toBeUndefined();

      const curatorRequest = readFileSync(join(userFacingRepo, 'audit/PGAS-NEW-governed-memo-mini.curator-request.md'), 'utf8');
      expect(curatorRequest).toContain('Boundary: CURATOR-REQUEST');
      expect(curatorRequest).toContain('frontend/src/runtime/docx-authoring/register-governed-memo-mini.ts');
      expect(curatorRequest).toContain("registerArtifactRenderer('governed_memo_markdown'");
      expect(curatorRequest).toContain("mimeType: 'text/markdown;charset=utf-8'");
      expect(curatorRequest).toContain('frontend/src/runtime/docx-authoring/__tests__/register-governed-memo-mini.test.ts');
      expect(curatorRequest).toContain("renderArtifact(domain, 'governed_memo_markdown')");
      expect(curatorRequest).toContain('frontend/src/main.tsx');
      expect(curatorRequest).toContain("import './runtime/docx-authoring/register-governed-memo-mini';");
      expect(curatorRequest).toContain('qc/e2e-coverage.yml');
      expect(curatorRequest).toContain('facts: qc/facts/governed-memo-mini.facts.yml');
      expect(curatorRequest).toContain('channels: [frontend]');
      expect(curatorRequest).toContain('qc/USER_FACING_PROGRAMS.txt');
      expect(curatorRequest).toContain('frontend/src/runtime/cutover/v2-programs.ts');
      expect(curatorRequest).toContain('\'governed-memo-mini\': "Governed Memo Mini"');
    } finally {
      rmSync(backendOnlyRepo, { recursive: true, force: true });
      rmSync(userFacingRepo, { recursive: true, force: true });
    }
  });

  it('derives governed attach frontend renderer imports and symbols from the selected slug', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-governed-renderer-slug-'));
    try {
      renderGovernedMemoAttachment(repoRoot, {
        slug: 'policy-note',
        name: 'Policy Note',
        governedAttachFrontendMode: 'user-facing',
      });

      const curatorRequest = readFileSync(join(repoRoot, 'audit/PGAS-NEW-policy-note.curator-request.md'), 'utf8');
      expect(curatorRequest).toContain('frontend/src/runtime/docx-authoring/register-policy-note.ts');
      expect(curatorRequest).toContain('frontend/src/runtime/docx-authoring/__tests__/register-policy-note.test.ts');
      expect(curatorRequest).toContain("import { registerPolicyNoteRenderers } from '../register-policy-note';");
      expect(curatorRequest).toContain('registerPolicyNoteRenderers();');
      expect(curatorRequest).not.toContain('../register-governed-memo-mini');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('keeps frontend derived binding inventory backed by emitted projection output', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-governed-bindings-'));
    try {
      renderGovernedMemoAttachment(repoRoot, { governedAttachFrontendMode: 'user-facing' });
      const frontendSpec = load(readFileSync(join(repoRoot, 'programs/governed-memo-mini/frontend.spec.yml'), 'utf8')) as FrontendSpec;
      const boundDerivedKeys = derivedKeysFromFrontendSpec(frontendSpec);
      expect([...boundDerivedKeys].sort()).toEqual([
        'completion_artifacts',
        'completion_summary',
        'completion_title',
        'focus_object',
        'memo_sections',
        'phase_steps',
        'workspace_artifact_items',
        'workspace_checkpoints',
        'workspace_context_tabs',
        'workspace_domain_content',
        'workspace_metadata',
        'workspace_session_content',
        'workspace_stat_items',
      ]);

      const projectionModule = await import(pathToFileURL(join(repoRoot, 'programs/governed-memo-mini/projection.ts')).href) as {
        governedMemoMiniProjection: (domain: Map<string, unknown>, mode: string, context: unknown) => Record<string, unknown>;
      };
      const missing: string[] = [];
      for (const mode of ['intake', 'draft_memo', 'complete']) {
        const derived = projectionModule.governedMemoMiniProjection(representativeDomain(mode), mode, { state: { rounds: [] } });
        for (const key of boundDerivedKeys) {
          if (!Object.prototype.hasOwnProperty.call(derived, key)) {
            missing.push(`${mode}:${key}`);
          }
        }
      }

      expect(missing).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('emits the full governed memo frontend projection contract with widget phase statuses', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-governed-projection-contract-'));
    try {
      renderGovernedMemoAttachment(repoRoot, { governedAttachFrontendMode: 'user-facing' });
      const projectionModule = await import(pathToFileURL(join(repoRoot, 'programs/governed-memo-mini/projection.ts')).href) as {
        governedMemoMiniProjection: (domain: Map<string, unknown>, mode: string, context: unknown) => Record<string, unknown>;
      };

      const draft = projectionModule.governedMemoMiniProjection(representativeDomain('draft_memo'), 'draft_memo', { state: { rounds: [] } });
      expect(draft.phase_steps).toEqual([
        { id: 'intake', label: 'Intake', status: 'done' },
        { id: 'draft_memo', label: 'Draft Memo', status: 'current' },
        { id: 'complete', label: 'Complete', status: 'upcoming' },
      ]);
      for (const step of draft.phase_steps as Array<{ status: string }>) {
        expect(['done', 'current', 'upcoming']).toContain(step.status);
      }
      expect(draft.focus_object).toMatchObject({
        id: 'governed-memo-mini-draft_memo-focus',
        program: 'governed-memo-mini',
        phase: 'draft_memo',
        kind: 'section',
        title: 'Draft Memo',
        status: 'revising',
        actions: [],
      });
      expect(draft.workspace_context_tabs).toEqual([
        { id: 'session', label: 'Session' },
        { id: 'artifacts', label: 'Artifacts' },
        { id: 'stats', label: 'Stats' },
      ]);
      expect(draft.workspace_session_content).toEqual(expect.arrayContaining([
        { label: 'Current mode', value: 'draft memo' },
        { label: 'Memo status', value: 'intake_recorded' },
      ]));
      expect(draft.workspace_domain_content).toEqual(expect.arrayContaining([
        { label: 'client', value: 'Acme Corp' },
        { label: 'issue', value: 'Renewal recommendation' },
      ]));
      expect(draft.workspace_stat_items).toEqual(expect.arrayContaining([
        { label: 'Recorded facts', value: '2' },
        { label: 'Memo artifact', value: 'Pending' },
      ]));
      expect(draft.memo_sections).toEqual([]);

      const complete = projectionModule.governedMemoMiniProjection(representativeDomain('complete'), 'complete', { state: { rounds: [] } });
      expect(complete.focus_object).toMatchObject({
        id: 'governed-memo-mini-complete-focus',
        program: 'governed-memo-mini',
        phase: 'complete',
        kind: 'completion',
        title: 'Renewal Recommendation',
        status: 'approved',
        actions: [],
      });
      expect(complete.completion_title).toBe('Renewal Recommendation');
      expect(complete.completion_summary).toContain('Markdown memo drafted from recorded intake facts');
      expect(complete.memo_sections).toEqual([
        {
          id: 'memo',
          title: 'Renewal Recommendation',
          text: '## Recommendation\nRenew Acme Corp.',
          status: 'drafted',
        },
      ]);
      expect(complete.final_artifacts).toEqual([
        {
          id: 'governed_memo_markdown',
          extension: '.md',
          title: 'Governed memo - Markdown',
          subtitle: 'Plain text memo source',
          status: 'ready',
        },
      ]);
      expect(complete.completion_artifacts).toEqual(complete.final_artifacts);
      expect(complete.workspace_artifact_items).toEqual([
        {
          id: 'governed_memo_markdown',
          label: 'Governed memo - Markdown',
          kind: 'markdown',
          status: 'ready',
        },
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

function renderGovernedMemoAttachment(
  repoRoot: string,
  options: { governedAttachFrontendMode?: 'backend-only' | 'user-facing'; slug?: string; name?: string } = {},
) {
  const slug = options.slug ?? 'governed-memo-mini';
  const name = options.name ?? 'Governed Memo Mini';
  const artifact = synthesizeProgramSpecFromDomain({
    ...minimalGovernedMemoDomain(),
    'program.slug': slug,
    'program.name': name,
    'program.target_dir': `/tmp/${slug}`,
  });
  const renderOptions: GovernedFrontendRenderOptions = {
    repoRoot,
    manifest: SIMONEOS_MANIFEST,
    slug,
    name,
    targetProfile: 'simoneos-governed-attach',
    governedAttachFrontendMode: options.governedAttachFrontendMode,
    synthesizedSpecYaml: artifact.spec_yaml,
    synthesizedSynthesisContext: artifact.synthesis_context,
  };
  return renderExistingRepoAttachment(renderOptions);
}

function derivedKeysFromFrontendSpec(spec: FrontendSpec): Set<string> {
  const keys = new Set<string>();
  collectDerivedKeys(spec, keys);
  return keys;
}

function collectDerivedKeys(value: unknown, keys: Set<string>): void {
  if (typeof value === 'string') {
    const match = value.match(/^derived\.([A-Za-z0-9_]+)$/u);
    if (match?.[1]) {
      keys.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDerivedKeys(item, keys);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      collectDerivedKeys(child, keys);
    }
  }
}

function representativeDomain(mode: string): Map<string, unknown> {
  if (mode === 'complete') {
    return new Map(Object.entries({
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
        body: '## Recommendation\nRenew Acme Corp.',
        status: 'drafted',
      },
    }));
  }
  if (mode === 'draft_memo') {
    return new Map(Object.entries({
      'work.status': 'intake_recorded',
      'work.intake_recorded': true,
      'work.intake.facts': {
        client: 'Acme Corp',
        issue: 'Renewal recommendation',
      },
    }));
  }
  return new Map(Object.entries({
    'work.status': 'pending',
    'inputs.user_text': 'Draft a memo for Acme Corp.',
  }));
}

function minimalGovernedMemoDomain(): Record<string, unknown> {
  return {
    'program.slug': 'governed-memo-mini',
    'program.name': 'Governed Memo Mini',
    'program.target_dir': '/tmp/governed-memo-mini',
    'program.design_path': 'governed-attach',
    'intake.purpose': 'Capture intake facts and draft a concise governed markdown memo.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'draft_memo',
        kind: 'llm-reasoning',
        domain_spec: {
          reads: ['work.intake.facts'],
          produces: {
            'work.memo_artifact': {
              id: 'string',
              kind: 'markdown',
              title: 'string',
              body: 'string',
              status: 'drafted',
            },
          },
          rules: ['Use only recorded intake facts.'],
          invariants: ['work.memo_artifact.kind is always markdown.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'draft_memo', trigger: 'intake_recorded', guard_field: 'work.intake_recorded' },
      { from: 'draft_memo', to: 'complete', trigger: 'memo_drafted', guard_field: 'work.memo_artifact.status' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'work.memo_artifact.status',
    }),
  };
}
