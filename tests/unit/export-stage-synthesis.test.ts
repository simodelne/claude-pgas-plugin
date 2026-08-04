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
      features: string[];
      pure: boolean;
      modes: Record<string, Record<string, unknown>>;
      channels: Record<string, Record<string, unknown>>;
      reactions: Record<string, Record<string, unknown>>;
      integrations: Record<string, { channel: string; hooks: Array<Record<string, unknown>> }>;
      proceed_to: Record<string, string>;
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
    expect(spec.features).toEqual(expect.arrayContaining(['decision_only', 'integrations']));
    expect(spec.pure).toBe(false);
    expect(spec.modes.export_document).toMatchObject({
      decision_only: true,
      vocabulary: [],
      channels: [],
      transitions: [{ target: 'complete' }],
    });
    expect(spec.action_map.complete_export_document).toBeUndefined();
    expect(spec.proceed_to.complete_export_document).toBeUndefined();
    expect(spec.prompts.export_document).toBeUndefined();
    expect(spec.guidance.export_document).toBeUndefined();
    expect(spec.channels.export_stage_hook).toEqual({ direction: 'Out', sync: 'Sync' });
    expect(spec.reactions.mark_export_document_export_render_pending).toEqual({
      event: 'OnTransition',
      write_scope: ['export_document.render_pending'],
    });
    expect(spec.integrations.export_stage_hooks).toEqual({
      channel: 'export_stage_hook',
      hooks: [
        {
          action: 'render_export_document_export',
          event: 'OnTransition',
          result_path: 'export_document.output',
        },
      ],
    });

    expect(artifact.registration_ts).toContain('artifactPolicy');
    expect(artifact.registration_ts).toContain('createExportHookAdapter');
    expect(artifact.registration_ts).toContain("artifactType: 'docx_export'");
    expect(artifact.registration_ts).toContain("payloadRef: 'export_document.output'");
    expect(artifact.registration_ts).toContain("whenAllPaths: ['export_document.output.result_json']");
    expect(artifact.handlers_ts).toContain('createExportHookAdapter');
    expect(artifact.handlers_ts).toContain('runExportDocument');
    expect(artifact.handlers_ts).toContain('render_export_document_export');
    expect(artifact.handlers_ts).not.toContain('async complete_export_document');

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

  it('normalizes DOCX export result contracts before domain_synthesis and bypasses the body generator for export stages', async () => {
    const artifact = synthesizeProgramSpecFromDomain(customContractExportDomain());
    const generatorCalls: string[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-export-custom-contract-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-08-04T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async (request) => {
          generatorCalls.push(request.stage);
          return nonExportStageBody();
        },
      });

      expect(generatorCalls).not.toContain('finalize_export');
      const body = withBodies.stage_sources?.finalize_export ?? '';
      expect(body).toContain("from '../export/docx.js'");
      expect(body).toContain('renderStructuredDocxDocument');
      expect(body).toContain('Buffer.from(bytes).toString');

      const exportStage = withBodies.synthesis_context?.stages.find((stage) => stage.slug === 'finalize_export');
      const resultContract = exportStage?.domain_spec?.produces.result_json as Record<string, unknown> | undefined;
      expect(Object.keys(resultContract ?? {})).toEqual([
        'stage',
        'docx_base64',
        'docx_bytes',
        'sha256',
        'section_count',
      ]);
      expect(exportStage?.domain_spec?.produces.items_json).toEqual(['docx_export:<sha256>']);

      const runStage = loadGeneratedExportStage(body);
      const output = await runStage({
        stage: 'finalize_export',
        payload: {},
        domain: approvedDocumentFinalizationDomain(),
        domain_spec: exportStage?.domain_spec ?? { reads: [], produces: {}, rules: [], invariants: [] },
      }, deterministicRuntime());
      const result = JSON.parse(output.result_json) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(Object.keys(resultContract ?? {}));
      expect(JSON.parse(output.items_json)).toEqual([`docx_export:${String(result.sha256)}`]);
      expect(Object.keys(result)).not.toEqual(['docx_ready', 'amended_docx_path']);
    } finally {
      rmSync(cacheDir, { force: true, recursive: true });
    }
  });

  it('removes export output shapes from all author-facing action surfaces', () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const spec = load(artifact.spec_yaml) as {
      action_map: Record<string, { description?: string }>;
    };
    const authorSurfaces = [
      artifact.spec_yaml,
      artifact.tools_ts,
      artifact.handlers_ts,
      artifact.smoke_test_ts,
    ].join('\n');

    expect(spec.action_map.complete_export_document).toBeUndefined();
    expect(authorSurfaces).not.toContain('complete_export_document');
    expect(authorSurfaces).not.toContain('docx_base64');
    expect(authorSurfaces).not.toContain('"produces"');
  });

  it('preserves all externally guarded decision-only export transitions from one source mode', () => {
    const artifact = synthesizeProgramSpecFromDomain(branchedExportDomain());
    const spec = load(artifact.spec_yaml) as {
      modes: Record<string, { decision_only?: boolean; vocabulary?: string[]; channels?: string[]; transitions?: Array<{ target: string; guard?: { kind: string; path: string } }> }>;
      action_map: Record<string, unknown>;
      proceed_to: Record<string, string>;
    };

    expect(spec.modes.export_document).toMatchObject({
      decision_only: true,
      vocabulary: [],
      channels: [],
    });
    expect(spec.modes.export_document.transitions).toEqual([
      { target: 'complete', guard: { kind: 'FieldTruthy', path: 'routing.export_ready' } },
      { target: 'blocked', guard: { kind: 'FieldTruthy', path: 'routing.export_blocked' } },
    ]);
    expect(Object.keys(spec.action_map).filter((name) => name.startsWith('advance_export_document'))).toEqual([]);
    expect(Object.keys(spec.proceed_to).filter((name) => name.startsWith('advance_export_document'))).toEqual([]);
  });

  it('rejects branched decision-only export transitions with source-local guards', () => {
    expect(() => synthesizeProgramSpecFromDomain(branchedExportDomain({
      completeGuard: 'export_document.ready',
      blockedGuard: 'export_document.blocked',
    }))).toThrow(/decision-only export.*export_document.*source-local guard/u);
  });

  it('does not ask the model to emit a deterministic export wrapper action', () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const spec = load(artifact.spec_yaml) as {
      action_map: Record<string, { description?: string }>;
      modes: Record<string, { vocabulary?: string[] }>;
    };

    expect(spec.action_map.complete_export_document).toBeUndefined();
    expect(spec.modes.export_document?.vocabulary).toEqual([]);
    expect(artifact.handlers_ts).toContain("domain[`${stage}.render_pending`] !== true");
    expect(artifact.handlers_ts).toContain('return renderExportStage(stage, domain)');
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
    expect(artifact.registration_ts).toContain('queryPolicy');
    expect(artifact.registration_ts).not.toContain('artifactPolicy');
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

function approvedDocumentFinalizationDomain(): Record<string, unknown> {
  return {
    'work.document.sections': [
      {
        id: 'section-1',
        heading: 'Approved Amendment',
        status: 'approved',
        text: 'APPROVED-AMENDED-DOCX-CONTENT',
      },
    ],
    'work.document.sections.0.id': 'section-1',
    'work.document.sections.0.heading': 'Approved Amendment',
    'work.document.sections.0.status': 'approved',
    'work.document.sections.0.text': 'APPROVED-AMENDED-DOCX-CONTENT',
    'work.document.summary': 'Document finalization complete.',
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

function customContractExportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'document-finalization',
    'program.name': 'Document Finalization',
    'program.target_dir': '/tmp/document-finalization',
    'intake.purpose': 'Finalize approved amendments and export the amended document as DOCX.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'finalize_export',
        kind: 'export_docx',
        export_kind: 'export_docx',
        domain_spec: {
          reads: ['work.document.sections.*.text', 'work.document.summary'],
          produces: {
            result_json: { docx_ready: 'boolean', amended_docx_path: 'string' },
            items_json: ['docx:<amended_docx_path>'],
          },
          rules: ['Render accumulated approved amendments into a deterministic DOCX export.'],
          invariants: ['No LLM round is required in finalize_export.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'finalize_export', trigger: 'finalize', guard_field: 'intake.started' },
      { from: 'finalize_export', to: 'complete', trigger: 'exported', guard_field: 'finalize_export.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'finalize_export.ready' }),
  };
}

function branchedExportDomain(overrides: {
  completeGuard?: string;
  blockedGuard?: string;
} = {}): Record<string, unknown> {
  const completeGuard = overrides.completeGuard ?? 'routing.export_ready';
  const blockedGuard = overrides.blockedGuard ?? 'routing.export_blocked';
  return {
    'program.slug': 'branched-export-demo',
    'program.name': 'Branched Export Demo',
    'program.target_dir': '/tmp/branched-export-demo',
    'intake.purpose': 'Compose a short memo and route the deterministic export to complete or blocked.',
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
      { slug: 'blocked', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'compose_memo', trigger: 'started', guard_field: 'intake.started' },
      { from: 'compose_memo', to: 'export_document', trigger: 'composed', guard_field: 'compose_memo.ready' },
      { from: 'export_document', to: 'complete', trigger: 'exported', guard_field: completeGuard },
      { from: 'export_document', to: 'blocked', trigger: 'blocked', guard_field: blockedGuard },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: completeGuard }),
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
