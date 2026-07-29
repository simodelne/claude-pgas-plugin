import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';
import { load } from 'js-yaml';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import { extractDocxText } from '../integration/fixtures/extract-docx.reference.js';
import { renderStructuredDocxDocument } from '../integration/fixtures/export-docx-render.golden.js';

describe('PR-E2 export stage synthesis', () => {
  it('emits deterministic DOCX export stages, result_path wiring, artifact policy, and standalone export artifacts', async () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const spec = load(artifact.spec_yaml) as {
      action_map: Record<string, Record<string, unknown>>;
      prompts: Record<string, string>;
      guidance: Record<string, string[]>;
    };
    const exportStage = artifact.stage_classification.find((stage) =>
      typeof stage === 'object' && stage && (stage as { slug?: unknown }).slug === 'export_document') as Record<string, unknown> | undefined;

    expect(exportStage).toMatchObject({
      slug: 'export_document',
      archetype: 'pure-compute',
      export_kind: 'export_docx',
    });
    expect(spec.action_map.complete_export_document?.result_path).toBe('export_document.output');
    expect(spec.action_map.complete_export_document?.channel).toBe('stage_output');
    expect(spec.prompts.export_document).toContain('Respond with EXACTLY ONE terminal action');
    expect(spec.prompts.export_document).toContain('complete_export_document');
    expect(spec.guidance.export_document.join('\n')).toContain('Respond with EXACTLY ONE terminal action');
    expect(spec.guidance.export_document.join('\n')).toContain('complete_export_document');

    expect(artifact.registration_ts).toContain('artifactPolicy');
    expect(artifact.registration_ts).toContain("artifactType: 'docx_export'");
    expect(artifact.registration_ts).toContain("payloadRef: 'export_document.output'");
    expect(artifact.registration_ts).toContain("whenAllPaths: ['export_document.output.result_json']");

    const plan = createStandaloneArtifactPlan(
      { slug: 'export-demo', name: 'Export Demo' },
      { stageSlugs: artifact.body_stage_slugs, exportSurfaces: artifact.export_surfaces },
    );
    expect(plan.artifacts.map((entry) => entry.path)).toContain('src/programs/export-demo/export/docx.ts');

    const generatorCalls: string[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-export-stage-synthesis-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-07-17T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async (request) => {
          generatorCalls.push(request.stage);
          return nonExportStageBody();
        },
      });
      const body = withBodies.stage_sources?.export_document ?? '';
      expect(generatorCalls).not.toContain('export_document');
      expect(body).toContain("from '../export/docx.js'");
      expect(body).toContain('renderStructuredDocxDocument');
      expect(body).toContain('Buffer.from(bytes).toString');
      expect(body).toContain('sha256Hex(bytes)');
    } finally {
      rmSync(cacheDir, { force: true, recursive: true });
    }
  });

  it('redacts deterministic export output shapes from the terminal action description', () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const spec = load(artifact.spec_yaml) as {
      action_map: Record<string, { description?: string }>;
    };
    const description = spec.action_map.complete_export_document?.description ?? '';

    expect(description).toContain('Author-provided domain spec for export_document');
    expect(description).toContain('"reads":["compose_memo.output.result_json"]');
    expect(description).toContain('Render accumulated stage state into a deterministic DOCX export.');
    expect(description).toContain('Do not call an LLM or provider while rendering export bytes.');
    expect(description).not.toContain('"produces"');
    expect(description).not.toContain('docx_base64');
  });

  it('tells deterministic export wrappers to emit empty payloads instead of output fields', () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const spec = load(artifact.spec_yaml) as {
      action_map: Record<string, { description?: string }>;
    };
    const description = spec.action_map.complete_export_document?.description ?? '';

    expect(description).toContain('emit this action with an EMPTY payload');
    expect(description).toContain('Do NOT author result_json');
    expect(description).toContain('output fields');
  });

  it('keeps reasoning stage produce shapes in terminal action descriptions', () => {
    const artifact = synthesizeProgramSpecFromDomain(reasoningDomain());
    const spec = load(artifact.spec_yaml) as {
      action_map: Record<string, { description?: string; arg_descriptions?: Record<string, string> }>;
    };
    const description = spec.action_map.complete_draft_opinion?.description ?? '';
    const resultArgDescription = spec.action_map.complete_draft_opinion?.arg_descriptions?.result_json ?? '';

    expect(description).toContain('"produces"');
    expect(description).toContain('"opinion_text":"string"');
    expect(resultArgDescription).toContain('"produces"');
    expect(resultArgDescription).toContain('"opinion_text":"string"');
  });

  it('keeps standalone export artifacts and artifactPolicy default-off without export demand', () => {
    const artifact = synthesizeProgramSpecFromDomain(noExportDomain());
    const plan = createStandaloneArtifactPlan(
      { slug: 'plain-demo', name: 'Plain Demo' },
      { stageSlugs: artifact.body_stage_slugs, exportSurfaces: artifact.export_surfaces },
    );
    const paths = plan.artifacts.map((entry) => entry.path);

    expect(paths.filter((path) => path.includes('/export/'))).toEqual([]);
    expect(artifact.export_surfaces).toBeUndefined();
    expect(artifact.registration_ts).toBeUndefined();
  });

  it('renders approved content collections without workflow-stage output sections', async () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-export-approved-only-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-07-29T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async () => nonExportStageBody(),
      });
      const runStage = loadGeneratedExportStage(withBodies.stage_sources?.export_document ?? '');
      const output = await runStage({
        stage: 'export_document',
        payload: {},
        domain: approvedContentWithReasoningOutputsDomain(),
        domain_spec: { reads: [], produces: {}, rules: [], invariants: [] },
      }, deterministicRuntime());
      const result = JSON.parse(output.result_json) as { docx_base64: string; section_count: number };
      const extracted = extractDocxText(Buffer.from(result.docx_base64, 'base64'));

      expect(extracted.ok).toBe(true);
      const docText = extracted.ok ? extracted.text : '';
      expect(result.section_count).toBe(2);
      expect(docText).toContain('Assumption 1');
      expect(docText).toContain('APPROVED-ASSUMPTION-BODY');
      expect(docText).toContain('Opinion 1');
      expect(docText).toContain('APPROVED-OPINION-BODY');
      for (const heading of [
        'Intake',
        'Upload Docs',
        'Transaction Understanding',
        'Dd Dispatch',
        'Legal Research',
        'Issue Analysis',
        'Draft Sections',
      ]) {
        expect(docText).not.toContain(heading);
      }
      expect(docText).not.toContain('Items Json');
      expect(docText).not.toContain('INTERNAL-RESULT-JSON-BLOB');
      expect(docText).not.toContain('INTERNAL-ITEMS-JSON-BLOB');
      expect(docText).not.toContain('UPLOAD-DOCS-INTERNAL');
      expect(docText).not.toContain('LEGAL-RESEARCH-INTERNAL');
    } finally {
      rmSync(cacheDir, { force: true, recursive: true });
    }
  });

  it('keeps rendering workflow-stage outputs when no approved content collection exists', async () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-export-no-content-fallback-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-07-29T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async () => nonExportStageBody(),
      });
      const runStage = loadGeneratedExportStage(withBodies.stage_sources?.export_document ?? '');
      const output = await runStage({
        stage: 'export_document',
        payload: {},
        domain: stageOutputsOnlyDomain(),
        domain_spec: { reads: [], produces: {}, rules: [], invariants: [] },
      }, deterministicRuntime());
      const result = JSON.parse(output.result_json) as { docx_base64: string; section_count: number };
      const extracted = extractDocxText(Buffer.from(result.docx_base64, 'base64'));

      expect(extracted.ok).toBe(true);
      const docText = extracted.ok ? extracted.text : '';
      expect(result.section_count).toBeGreaterThanOrEqual(3);
      expect(docText).toContain('Upload Docs');
      expect(docText).toContain('UPLOAD-DOCS-FALLBACK-CONTENT');
      expect(docText).toContain('Transaction Understanding');
      expect(docText).toContain('TRANSACTION-UNDERSTANDING-FALLBACK-CONTENT');
      expect(docText).toContain('Legal Research');
      expect(docText).toContain('LEGAL-RESEARCH-FALLBACK-CONTENT');
    } finally {
      rmSync(cacheDir, { force: true, recursive: true });
    }
  });
});

type GeneratedRunStage = (
  input: {
    stage: string;
    payload: Record<string, unknown>;
    domain: Record<string, unknown>;
    domain_spec: { reads: string[]; produces: Record<string, unknown>; rules: string[]; invariants: string[] };
  },
  runtime: { now(): string; random(): number; llm(prompt: string): Promise<string> },
) => Promise<{ result_json: string; items_json: string; digest: string }>;

function loadGeneratedExportStage(source: string): GeneratedRunStage {
  const transpiled = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({
    exports: exportsObject,
    module: moduleObject,
    Buffer,
    crypto: webcrypto,
    require: (specifier: string): Record<string, unknown> => {
      if (specifier === '../export/docx.js') {
        return { renderStructuredDocxDocument };
      }
      throw new Error(`unexpected generated export import: ${specifier}`);
    },
    TextEncoder,
  });
  new Script(transpiled.outputText, { filename: 'generated-export-stage.cjs' }).runInContext(context, {
    timeout: 1_000,
  });
  const exported = moduleObject.exports as Record<string, unknown>;
  if (typeof exported.runStage !== 'function') {
    throw new Error('generated export stage did not expose runStage');
  }
  return exported.runStage as GeneratedRunStage;
}

function deterministicRuntime(): { now(): string; random(): number; llm(prompt: string): Promise<string> } {
  return {
    now: () => '2026-07-29T00:00:00.000Z',
    random: () => 0.5,
    llm: async () => {
      throw new Error('llm unavailable in deterministic export test');
    },
  };
}

function approvedContentWithReasoningOutputsDomain(): Record<string, unknown> {
  return {
    'intake.output': stageOutput('intake', 'INTAKE-INTERNAL'),
    'upload_docs.output': stageOutput('upload_docs', 'UPLOAD-DOCS-INTERNAL'),
    'transaction_understanding.result_json': JSON.stringify({
      stage: 'transaction_understanding',
      result_json: 'INTERNAL-RESULT-JSON-BLOB',
    }),
    'dd_dispatch.output': stageOutput('dd_dispatch', 'DD-DISPATCH-INTERNAL'),
    'legal_research.output': stageOutput('legal_research', 'LEGAL-RESEARCH-INTERNAL'),
    'issue_analysis.output': stageOutput('issue_analysis', 'ISSUE-ANALYSIS-INTERNAL'),
    'draft_sections.output': stageOutput('draft_sections', 'DRAFT-SECTIONS-INTERNAL'),
    'work.opinion_sections.items': [
      {
        id: 'assumption-1',
        title: 'Assumption 1',
        status: 'accepted',
        body: 'APPROVED-ASSUMPTION-BODY',
      },
      {
        id: 'opinion-1',
        title: 'Opinion 1',
        status: 'approved',
        final_text: 'APPROVED-OPINION-BODY',
      },
    ],
    'work.opinion_sections.items.0.id': 'assumption-1',
    'work.opinion_sections.items.0.status': 'accepted',
    'work.opinion_sections.items.0.title': 'Assumption 1',
    'work.opinion_sections.items.0.body': 'APPROVED-ASSUMPTION-BODY',
    'work.opinion_sections.items.1.final_text': 'APPROVED-OPINION-BODY',
    'work.opinion_sections.items.1.id': 'opinion-1',
    'work.opinion_sections.items.1.status': 'approved',
    'work.opinion_sections.items.1.title': 'Opinion 1',
    'work.opinion_sections.items_json': 'INTERNAL-ITEMS-JSON-BLOB',
  };
}

function stageOutputsOnlyDomain(): Record<string, unknown> {
  return {
    'upload_docs.output': stageOutput('upload_docs', 'UPLOAD-DOCS-FALLBACK-CONTENT'),
    'transaction_understanding.result_json': JSON.stringify({
      stage: 'transaction_understanding',
      summary: 'TRANSACTION-UNDERSTANDING-FALLBACK-CONTENT',
    }),
    'legal_research.output': stageOutput('legal_research', 'LEGAL-RESEARCH-FALLBACK-CONTENT'),
  };
}

function stageOutput(stage: string, summary: string): { result_json: string; items_json: string; digest: string } {
  return {
    result_json: JSON.stringify({ stage, summary }),
    items_json: JSON.stringify([`${stage}:internal`]),
    digest: '',
  };
}

function exportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'export-demo',
    'program.name': 'Export Demo',
    'program.target_dir': '/tmp/export-demo',
    'intake.purpose': 'Compose a short memo and produce a DOCX export.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'compose_memo' },
      {
        slug: 'export_document',
        kind: 'export_docx',
        domain_spec: {
          reads: ['compose_memo.output.result_json'],
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
          rules: ['Render accumulated stage state into a deterministic DOCX export.'],
          invariants: ['Do not call an LLM or provider while rendering export bytes.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'compose_memo', trigger: 'started', guard_field: 'intake.started' },
      { from: 'compose_memo', to: 'export_document', trigger: 'composed', guard_field: 'compose_memo.ready' },
      { from: 'export_document', to: 'complete', trigger: 'exported', guard_field: 'export_document.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'export_document.ready' }),
  };
}

function reasoningDomain(): Record<string, unknown> {
  return {
    'program.slug': 'reasoning-guard-demo',
    'program.name': 'Reasoning Guard Demo',
    'program.target_dir': '/tmp/reasoning-guard-demo',
    'intake.purpose': 'Draft a reasoned opinion summary.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'draft_opinion',
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: {
            result_json: {
              stage: 'string',
              opinion_text: 'string',
              confidence: 'string',
            },
            items_json: ['opinion:<confidence>'],
          },
          rules: ['Draft an opinion from the request.'],
          invariants: ['result_json.stage must equal draft_opinion.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'draft_opinion', trigger: 'started', guard_field: 'intake.started' },
      { from: 'draft_opinion', to: 'complete', trigger: 'drafted', guard_field: 'draft_opinion.done' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        draft_opinion: { kind: 'llm-reasoning' },
      },
    }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'draft_opinion.done' }),
  };
}

function noExportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'plain-demo',
    'program.name': 'Plain Demo',
    'program.target_dir': '/tmp/plain-demo',
    'intake.purpose': 'Compose a short memo and finish.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'compose_memo' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'compose_memo', trigger: 'started', guard_field: 'intake.started' },
      { from: 'compose_memo', to: 'complete', trigger: 'composed', guard_field: 'compose_memo.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'compose_memo.ready' }),
  };
}

function nonExportStageBody(): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, ready: true, summary: input.stage + ' ready' }),
    items_json: JSON.stringify([input.stage + ':ready']),
    digest: '',
  };
}
`;
}
