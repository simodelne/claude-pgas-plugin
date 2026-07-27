import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  control_plane?: unknown;
}

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
        'audit/PGAS-NEW-governed-memo-mini.curator-request.md',
      ]);

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

      const registration = readFileSync(join(repoRoot, 'programs/governed-memo-mini/registration.ts'), 'utf8');
      expect(registration).toContain("import { createProgramAdapters, enableNotebook, loadSpecWithPatterns, type ProgramEntry } from '@simodelne/pgas-server/plugin.js';");
      expect(registration).toContain('export function createProgramEntry(): ProgramEntry');
      expect(registration).toContain("loadSpecWithPatterns(path.join(dirname, 'specs.yml'))");
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
});

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
