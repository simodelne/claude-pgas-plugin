import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { extractDocxText } from '../integration/fixtures/extract-docx.reference.js';
import { renderStructuredDocxDocument } from '../integration/fixtures/export-docx-render.golden.js';

const RAW_CORPUS = 'RAW-CORPUS-EXPORT-LEAK must never appear in client export bytes.';
const APPROVED_SECTION_BODY = 'APPROVED-REPORT-SECTION retained for the client artifact.';
const FINDING_TEXT = 'FINDING-SUMMARY retained for the client artifact.';
const APPROVED_OPINION_TITLE = 'Duty Analysis';
const APPROVED_OPINION_TEXT = 'APPROVED-OPINION-CONTENT retained for the client artifact.';
const APPROVED_DEFECT_TITLE = 'Defect Analysis';
const APPROVED_DEFECT_TEXT = 'DEFECT-ANALYSIS-CONTENT retained for the client artifact.';
const PENDING_OPINION_TEXT = 'PENDING-OPINION-DRAFT must not appear in the client artifact.';

describe('synthesized report export source redaction', () => {
  it('renders report sections and findings without raw uploaded corpus keys', async () => {
    const artifact = synthesizeProgramSpecFromDomain(reportExportDomain());
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-export-source-redaction-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-07-27T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async () => nonExportStageBody(),
      });
      const runStage = loadGeneratedExportStage(withBodies.stage_sources?.export_document ?? '');
      const output = await runStage({
        stage: 'export_document',
        payload: {},
        domain: reportRuntimeDomain(),
        domain_spec: { reads: [], produces: {}, rules: [], invariants: [] },
      }, {
        now: () => '2026-07-27T00:00:00.000Z',
        random: () => 0.5,
        llm: async () => {
          throw new Error('llm unavailable in deterministic export test');
        },
      });
      const result = JSON.parse(output.result_json) as { docx_base64: string; section_count: number };
      const extracted = extractDocxText(Buffer.from(result.docx_base64, 'base64'));

      expect(extracted.ok).toBe(true);
      const docText = extracted.ok ? extracted.text : '';
      expect(result.section_count).toBeGreaterThan(0);
      expect(docText).toContain('Executive Summary');
      expect(docText).toContain(APPROVED_SECTION_BODY);
      expect(docText).toContain(FINDING_TEXT);
      expect(docText).not.toContain('Work Report Sections Items');
      expect(docText).not.toContain('Work Source Full Text');
      expect(docText).not.toContain('Work Source Current Document Text');
      expect(docText).not.toContain('Fan Out Results');
      expect(docText).not.toContain(RAW_CORPUS);
      expect(docText).not.toContain('work.source.full_text');
    } finally {
      rmSync(cacheDir, { force: true, recursive: true });
    }
  });

  it('renders approved non-report confirmation-loop sections without loop bookkeeping', async () => {
    const artifact = synthesizeProgramSpecFromDomain(opinionExportDomain());
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-export-loop-redaction-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-07-27T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async () => nonExportStageBody(),
      });
      const runStage = loadGeneratedExportStage(withBodies.stage_sources?.assemble_export ?? '');
      const output = await runStage({
        stage: 'assemble_export',
        payload: {},
        domain: opinionRuntimeDomain(),
        domain_spec: { reads: [], produces: {}, rules: [], invariants: [] },
      }, {
        now: () => '2026-07-27T00:00:00.000Z',
        random: () => 0.5,
        llm: async () => {
          throw new Error('llm unavailable in deterministic export test');
        },
      });
      const result = JSON.parse(output.result_json) as { docx_base64: string; section_count: number };
      const extracted = extractDocxText(Buffer.from(result.docx_base64, 'base64'));

      expect(extracted.ok).toBe(true);
      const docText = extracted.ok ? extracted.text : '';
      expect(result.section_count).toBe(2);
      expect(docText).toContain(APPROVED_OPINION_TITLE);
      expect(docText).toContain(APPROVED_OPINION_TEXT);
      expect(docText).toContain(APPROVED_DEFECT_TITLE);
      expect(docText).toContain(APPROVED_DEFECT_TEXT);
      expect(docText).not.toContain(PENDING_OPINION_TEXT);
      expect(docText).not.toContain('Work Opinion Sections');
      expect(docText).not.toContain('Pending Approval Action');
      expect(docText).not.toContain('Work Opinion Sections Items 0 Status');
      expect(docText).not.toContain('Work Opinion Sections Items 0 Index');
      expect(docText).not.toContain('Work Opinion Sections All Terminal');
      expect(docText).not.toContain('Work Opinion Sections Confirmation Summary');
      expect(docText).not.toContain('work.opinion_sections.items.0.status');
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

function reportRuntimeDomain(): Record<string, unknown> {
  return {
    'aggregate_findings.result_json': JSON.stringify({
      significant_findings: FINDING_TEXT,
      reviewed_document_count: 2,
    }),
    'draft_sections.result_json': JSON.stringify({
      section_count: 1,
      key_findings: FINDING_TEXT,
    }),
    'review_documents.fan_out.results.0.result_json': JSON.stringify({
      significant_findings: RAW_CORPUS,
    }),
    'work.report_sections.items.0': {
      id: 'section-1',
      title: 'Executive Summary',
      status: 'accepted',
      proposed_text: APPROVED_SECTION_BODY,
    },
    'work.report_sections.items.0.id': 'section-1',
    'work.report_sections.items.0.title': 'Executive Summary',
    'work.report_sections.items.0.status': 'accepted',
    'work.report_sections.items.0.proposed_text': APPROVED_SECTION_BODY,
    'work.source.full_text': RAW_CORPUS,
    'work.source.current_document.text': RAW_CORPUS,
    'work.source.documents': [
      { id: 'doc1', name: 'raw-source.md', text: RAW_CORPUS },
    ],
    'work.source.status': 'extracted',
    'work.source_ready': true,
  };
}

function opinionRuntimeDomain(): Record<string, unknown> {
  return {
    'work.opinion_sections': 762,
    'work.opinion_sections.items': [
      {
        id: 'opinion-1',
        title: APPROVED_OPINION_TITLE,
        status: 'approved',
        text: APPROVED_OPINION_TEXT,
      },
      {
        id: 'opinion-2',
        title: APPROVED_DEFECT_TITLE,
        status: 'accepted',
        body: APPROVED_DEFECT_TEXT,
      },
      {
        id: 'opinion-3',
        title: 'Unapproved Draft',
        status: 'pending_review',
        text: PENDING_OPINION_TEXT,
      },
    ],
    'work.opinion_sections.items.0.id': 'opinion-1',
    'work.opinion_sections.items.0.index': 0,
    'work.opinion_sections.items.0.status': 'approved',
    'work.opinion_sections.items.0.text': APPROVED_OPINION_TEXT,
    'work.opinion_sections.items.0.title': APPROVED_OPINION_TITLE,
    'work.opinion_sections.items.1.body': APPROVED_DEFECT_TEXT,
    'work.opinion_sections.items.1.id': 'opinion-2',
    'work.opinion_sections.items.1.index': 1,
    'work.opinion_sections.items.1.status': 'accepted',
    'work.opinion_sections.items.1.title': APPROVED_DEFECT_TITLE,
    'work.opinion_sections.items.2.id': 'opinion-3',
    'work.opinion_sections.items.2.index': 2,
    'work.opinion_sections.items.2.status': 'pending_review',
    'work.opinion_sections.items.2.text': PENDING_OPINION_TEXT,
    'work.opinion_sections.items.2.title': 'Unapproved Draft',
    'work.opinion_sections.all_terminal': true,
    'work.opinion_sections.current_index': 2,
    'work.opinion_sections.confirmation_summary': {
      total_items: 3,
      terminal_items: 2,
      pending_items: 1,
      current_index: 2,
    },
    'work.opinion_sections.confirmation_summary.total_items': 3,
    'work.opinion_sections.confirmation_summary.terminal_items': 2,
    'work.opinion_sections.confirmation_summary.pending_items': 1,
    'work.opinion_sections.confirmation_summary.current_index': 2,
    'work.opinion_sections.confirmation_summary.active_item.title': 'Unapproved Draft',
    'work.pending_approval.action': 1,
    'work.pending_approval.decision': 'approve',
  };
}

function reportExportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'report-export-redaction',
    'program.name': 'Report Export Redaction',
    'program.target_dir': '/tmp/report-export-redaction',
    'intake.purpose': 'Produce an approved diligence report from uploaded source documents and export a DOCX.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'aggregate_findings' },
      { slug: 'draft_sections' },
      {
        slug: 'export_document',
        kind: 'export_docx',
        domain_spec: {
          reads: ['work.report_sections.items.*.proposed_text', 'aggregate_findings.result_json'],
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
          rules: ['Render approved report sections and findings into a deterministic DOCX export.'],
          invariants: ['Never render work.source.full_text or uploaded document bodies.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'aggregate_findings', trigger: 'started', guard_field: 'intake.started' },
      { from: 'aggregate_findings', to: 'draft_sections', trigger: 'aggregated', guard_field: 'aggregate_findings.done' },
      { from: 'draft_sections', to: 'export_document', trigger: 'drafted', guard_field: 'draft_sections.done' },
      { from: 'export_document', to: 'complete', trigger: 'exported', guard_field: 'export_document.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        aggregate_findings: { kind: 'pure-compute' },
        draft_sections: { kind: 'pure-compute' },
      },
    }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'export_document.ready' }),
  };
}

function opinionExportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'opinion-export-redaction',
    'program.name': 'Opinion Export Redaction',
    'program.target_dir': '/tmp/opinion-export-redaction',
    'intake.purpose': 'Produce an approved legal opinion from reviewed sections and export a DOCX.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'draft_opinion' },
      { slug: 'review_opinion_sections' },
      {
        slug: 'assemble_export',
        kind: 'export_docx',
        domain_spec: {
          reads: [
            'work.opinion_sections.items.*.title',
            'work.opinion_sections.items.*.text',
            'work.opinion_sections.items.*.body',
          ],
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
          rules: ['Render only approved opinion sections into a deterministic DOCX export.'],
          invariants: ['Never render confirmation-loop bookkeeping or pending approval state.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'draft_opinion', trigger: 'started', guard_field: 'intake.started' },
      { from: 'draft_opinion', to: 'review_opinion_sections', trigger: 'drafted', guard_field: 'draft_opinion.done' },
      { from: 'review_opinion_sections', to: 'assemble_export', trigger: 'reviewed', guard_field: 'work.opinion_sections.all_terminal' },
      { from: 'assemble_export', to: 'complete', trigger: 'exported', guard_field: 'assemble_export.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        draft_opinion: { kind: 'llm-reasoning' },
        review_opinion_sections: { kind: 'llm-reasoning' },
      },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'assemble_export.ready',
      collection_lifecycle: opinionSectionLifecycle(),
    }),
    'intake.interaction_json': JSON.stringify({
      confirmation_loops: [opinionSectionApprovalLoop()],
    }),
  };
}

function opinionSectionLifecycle(): Record<string, unknown> {
  return {
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
        text: 'string',
        body: 'string',
        user_instruction: 'string',
        status: 'string',
      },
    },
    statuses: [
      { name: 'pending_review', initial: true },
      { name: 'proposed' },
      { name: 'approved', terminal: true },
      { name: 'accepted', terminal: true },
      { name: 'omitted', terminal: true },
    ],
    transitions: [],
    aggregate: {
      guard_field: 'work.opinion_sections.all_terminal',
      terminal_statuses: ['approved', 'accepted', 'omitted'],
      require_non_empty: true,
    },
  };
}

function opinionSectionApprovalLoop(): Record<string, unknown> {
  return {
    collection: 'work.opinion_sections.items',
    proposed_status: 'proposed',
    seed: { source_stage: 'draft_opinion', id_prefix: 'opinion' },
    decisions: {
      approve: { to: 'approved' },
      revise: {
        to: 'proposed',
        requires_instruction: true,
        instruction_path: 'work.opinion_sections.items.*.user_instruction',
        re_propose: true,
      },
      skip: { to: 'omitted' },
    },
    one_proposed_at_a_time: true,
    aggregate: {
      guard_field: 'work.opinion_sections.all_terminal',
      terminal_statuses: ['approved', 'accepted', 'omitted'],
    },
    stage: 'review_opinion_sections',
    summary_path: 'work.opinion_sections.confirmation_summary',
    pending_action_path: 'work.pending_approval.action',
  };
}

function nonExportStageBody(): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, done: true }),
    items_json: JSON.stringify([input.stage + ':done']),
    digest: '',
  };
}
`;
}
