import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

interface ParsedSpec {
  projection: Record<string, { include: string[]; exclude?: string[] }>;
}

describe('scale-safe synthesized projections', () => {
  it('keeps document fan-out and approval projections bounded and mode-specific', () => {
    const small = projectionForDocumentCount(3);
    const large = projectionForDocumentCount(1000);

    expect(projectionShape(large)).toEqual(projectionShape(small));

    for (const [mode, projection] of Object.entries(large)) {
      expect(projection.include, `${mode} must not include full uploaded corpus`).not.toContain('work.source.full_text');
      expect(projection.include, `${mode} must not include uploaded document collection body`).not.toContain('work.source.documents');
      expect(projection.include, `${mode} must not include uploaded document item bodies`).not.toContain('work.source.documents.*.text');
      expect(projection.include, `${mode} must not include raw fan-out result bag`).not.toContain('review_documents.fan_out.results');
      expect(projection.include, `${mode} must not include raw fan-out result items`).not.toContain('review_documents.fan_out.results.*');
      expect(projection.include, `${mode} must not include raw fan-out child report objects`).not.toContain('review_documents.fan_out.results.*.result');
    }
    for (const [mode, projection] of Object.entries(large)) {
      expect(projection.include.length, `${mode} projection path count`).toBeLessThanOrEqual(36);
    }

    expect(large.review_documents.include).toEqual(expect.arrayContaining([
      'work.source.document_count',
      'work.source.current_document.id',
      'work.source.current_document.name',
      'review_documents.fan_out.index',
      'review_documents.fan_out.complete',
      'review_documents.fan_out.results.*.document_id',
      'review_documents.fan_out.results.*.summary',
    ]));
    expect(large.review_documents.include).not.toContain('review_documents.fan_out.results.*.seeded_topic');

    for (const mode of ['aggregate_findings', 'draft_sections', 'assemble_report']) {
      expect(large[mode]?.include, `${mode} sees document metadata counts`).toEqual(expect.arrayContaining([
        'work.source.document_count',
        'work.source.current_document.id',
        'work.source.current_document.name',
      ]));
      expect(large[mode]?.include, `${mode} uses aggregate review output`).toContain('review_documents.result_json');
      expect(large[mode]?.include, `${mode} does not see per-child fan-out reports`).not.toContain('review_documents.fan_out.results.*.summary');
    }

    expect(large.approve_sections.include).toEqual(expect.arrayContaining([
      'inputs.user_decision.target_item_index',
      'inputs.user_decision.target_item_id',
      'inputs.user_decision.target_item_title',
      'inputs.user_decision.target_item_status',
      'report.all_sections_resolved',
      'summary.approved_sections',
      'summary.approved_sections.active_item',
      'summary.approved_sections.total_items',
      'summary.approved_sections.terminal_items',
      'summary.approved_sections.pending_items',
      'summary.approved_sections.current_index',
    ]));
    expect(large.approve_sections.include).not.toContain('report.sections');
    expect(large.approve_sections.include).not.toContain('report.sections.*.id');
    expect(large.approve_sections.include).not.toContain('report.sections.*.title');
    expect(large.approve_sections.include).not.toContain('report.sections.*.status');
    expect(large.approve_sections.include).not.toContain('draft_sections.items_json');
    expect(large.approve_sections.include).not.toContain('review_documents.result_json');
    expect(large.approve_sections.include).not.toContain('aggregate_findings.result_json');

    expect(large.assemble_report.include).toEqual(expect.arrayContaining([
      'report.sections.*.id',
      'report.sections.*.title',
      'report.sections.*.status',
      'summary.approved_sections',
      'aggregate_findings.result_json',
      'draft_sections.items_json',
    ]));
    expect(large.assemble_report.include).not.toContain('report.sections');
  });

  it('keeps large per-item approval loops on a bounded active-item projection', () => {
    const smallApprove = approvalProjectionForItemCount(5);
    const largeApprove = approvalProjectionForItemCount(60);

    expect([...largeApprove.include].sort()).toEqual([...smallApprove.include].sort());
    expect(largeApprove.include.length).toBeLessThanOrEqual(18);
    expect(largeApprove.include).toEqual(expect.arrayContaining([
      'inputs.user_decision.target_item_index',
      'inputs.user_decision.target_item_id',
      'inputs.user_decision.target_item_title',
      'inputs.user_decision.target_item_status',
      'report.all_sections_resolved',
      'summary.approved_sections',
      'summary.approved_sections.active_item',
      'summary.approved_sections.total_items',
      'summary.approved_sections.terminal_items',
      'summary.approved_sections.pending_items',
      'summary.approved_sections.current_index',
    ]));

    for (const forbidden of [
      'report.sections',
      'report.sections.*.id',
      'report.sections.*.title',
      'report.sections.*.status',
      'report.sections.*.summary',
      'report.sections.*.draft_text',
      'draft_sections.items_json',
      'review_documents.result_json',
      'review_documents.items_json',
      'aggregate_findings.result_json',
      'aggregate_findings.items_json',
      'work.source.full_text',
      'work.source.documents',
      'work.source.documents.*.text',
      'review_documents.fan_out.results',
      'review_documents.fan_out.results.*',
      'review_documents.fan_out.results.*.result',
    ]) {
      expect(largeApprove.include, `approve projection must not include ${forbidden}`).not.toContain(forbidden);
    }
    expect(
      largeApprove.include.filter((path) => path.startsWith('report.sections.*')),
      'approve projection must not expand the whole approval collection',
    ).toEqual([]);
  });
});

function projectionForDocumentCount(documentCount: number): ParsedSpec['projection'] {
  const artifact = synthesizeProgramSpecFromDomain(documentReviewApprovalDomain(documentCount));
  const parsed = load(artifact.spec_yaml) as ParsedSpec;
  return parsed.projection;
}

function approvalProjectionForItemCount(approvalItemCount: number): { include: string[]; exclude?: string[] } {
  const artifact = synthesizeProgramSpecFromDomain(documentReviewApprovalDomain(3, approvalItemCount));
  const parsed = load(artifact.spec_yaml) as ParsedSpec;
  return parsed.projection.approve_sections;
}

function projectionShape(projection: ParsedSpec['projection']): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(projection).map(([mode, modeProjection]) => [
      mode,
      [...modeProjection.include].sort(),
    ]),
  );
}

function documentReviewApprovalDomain(documentCount: number, approvalItemCount = 1): Record<string, unknown> {
  return {
    'program.slug': `bounded-dd-report-${String(documentCount)}`,
    'program.name': `Bounded DD Report ${String(documentCount)}`,
    'program.target_dir': `/tmp/bounded-dd-report-${String(documentCount)}`,
    'intake.purpose': `Review ${String(documentCount)} uploaded diligence documents, aggregate red flags, approve report sections, and assemble the final report.`,
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'upload_sources',
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: { result_json: { source_ready: 'boolean' }, items_json: ['sources:ready'] },
          rules: ['Upload diligence documents.'],
          invariants: ['Uploaded source document bodies must not be projected downstream as a corpus.'],
        },
      },
      {
        slug: 'review_documents',
        domain_spec: {
          reads: ['work.source.current_document', 'work.source.document_count', 'inputs.initial_user_text'],
          produces: {
            result_json: {
              reviewed_document_count: 'number',
              red_flag_summary: 'string',
            },
            items_json: ['review:<red_flag_summary>'],
          },
          rules: ['Delegate one isolated review child per uploaded document and summarize findings.'],
          invariants: ['Downstream modes consume review summaries, not raw child result objects.'],
        },
      },
      {
        slug: 'aggregate_findings',
        domain_spec: {
          reads: ['review_documents.result_json', 'review_documents.items_json', 'work.source.document_count'],
          produces: {
            result_json: {
              red_flag_summary: 'string',
              reviewed_document_count: 'number',
            },
            items_json: ['aggregate:<red_flag_summary>'],
          },
          rules: ['Aggregate document review summaries into report findings.'],
          invariants: ['Do not inspect uploaded document bodies.'],
        },
      },
      {
        slug: 'draft_sections',
        domain_spec: {
          reads: ['aggregate_findings.result_json', 'review_documents.result_json'],
          produces: {
            result_json: {
              section_count: 'number',
            },
            items_json: draftSectionItemTemplates(approvalItemCount),
          },
          rules: ['Draft report sections from aggregate summaries.'],
          invariants: ['Drafting uses summarized findings only.'],
        },
      },
      {
        slug: 'approve_sections',
        domain_spec: {
          reads: ['report.sections.*.id', 'report.sections.*.title', 'report.sections.*.status', 'summary.approved_sections'],
          produces: {
            result_json: {
              approved_section_count: 'number',
            },
            items_json: ['approve:<approved_section_count>'],
          },
          rules: ['Present report sections for approval one at a time.'],
          invariants: ['User approval changes section status; the model must not write statuses directly.'],
        },
      },
      {
        slug: 'assemble_report',
        domain_spec: {
          reads: ['report.sections.*.id', 'report.sections.*.title', 'report.sections.*.status', 'summary.approved_sections', 'aggregate_findings.result_json'],
          produces: {
            result_json: {
              assembled: 'boolean',
            },
            items_json: ['assemble:complete'],
          },
          rules: ['Assemble only approved report sections and aggregate summaries.'],
          invariants: ['Assembly never receives the full uploaded corpus or raw child reports.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'upload_sources', trigger: 'started', guard_field: 'intake.started' },
      { from: 'upload_sources', to: 'review_documents', trigger: 'uploaded', guard_field: 'work.source_ready' },
      { from: 'review_documents', to: 'aggregate_findings', trigger: 'reviewed', guard_field: 'review_documents.fan_out.complete' },
      { from: 'aggregate_findings', to: 'draft_sections', trigger: 'aggregated', guard_field: 'aggregate_findings.done' },
      { from: 'draft_sections', to: 'approve_sections', trigger: 'drafted', guard_field: 'draft_sections.done' },
      { from: 'approve_sections', to: 'assemble_report', trigger: 'approved', guard_field: 'report.all_sections_resolved' },
      { from: 'assemble_report', to: 'complete', trigger: 'assembled', guard_field: 'assemble_report.done' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        upload_sources: { kind: 'pure-compute' },
        review_documents: { kind: 'llm-reasoning', reasoning_per_turn: true },
        aggregate_findings: { kind: 'llm-reasoning', reasoning_per_turn: true },
        draft_sections: { kind: 'llm-reasoning', reasoning_per_turn: true },
        approve_sections: { kind: 'llm-reasoning', reasoning_per_turn: true },
        assemble_report: { kind: 'llm-reasoning', reasoning_per_turn: true },
      },
      children: [
        {
          id: 'review',
          stage: 'review_documents',
          synthesize_child: {
            kind: 'worker',
            slug: 'bounded-document-review-worker',
            purpose: 'Review only the current uploaded diligence document.',
            result_fields: {
              seeded_topic: 'string',
              document_id: 'string',
              summary: 'string',
              red_flags: 'string',
            },
          },
          fan_out: {
            source: 'work.source.documents',
            current_document: 'work.source.current_document',
            result_path: 'review_documents.fan_out.results',
            completion_guard: 'review_documents.fan_out.complete',
          },
          payload_map: {
            'request.topic': 'work.source.full_text',
            'domain_context.original_request': 'inputs.initial_user_text',
          },
          result_path: 'review_documents.delegation.review.result',
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
    'intake.documents_json': JSON.stringify({
      version: 1,
      stage: 'upload_sources',
      upload_types: ['text/plain', 'text/markdown'],
      extraction: 'self_contained',
      result_path: 'work.source',
      required: true,
      fidelity_floor: { min_chars: 1 },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'assemble_report.done',
      collection_lifecycle: reportSectionLifecycle(),
    }),
    'intake.interaction_json': JSON.stringify({
      confirmation_loops: [reportSectionApprovalLoop()],
    }),
  };
}

function draftSectionItemTemplates(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const itemNumber = index + 1;
    return JSON.stringify({
      id: `section-${String(itemNumber)}`,
      title: `Report Section ${String(itemNumber)}`,
      summary: `Red flag summary ${String(itemNumber)}`,
      draft_text: `Draft section text ${String(itemNumber)}`,
    });
  });
}

function reportSectionLifecycle(): Record<string, unknown> {
  return {
    version: 1,
    name: 'report_sections',
    item_label: 'report section',
    storage: {
      items_path: 'report.sections',
      event_path: 'report.pending_section_event_json',
      violation_path: 'report.section_lifecycle_violation_json',
      representation: 'indexed_array',
    },
    item: {
      id_field: 'id',
      status_field: 'status',
      schema: {
        id: 'string',
        title: 'string',
        summary: 'string',
        draft_text: 'string',
        user_instruction: 'string',
        status: 'string',
      },
    },
    statuses: [
      { name: 'pending_review', initial: true },
      { name: 'proposed' },
      { name: 'approved', terminal: true },
      { name: 'omitted', terminal: true },
    ],
    transitions: [],
    aggregate: {
      guard_field: 'report.all_sections_resolved',
      terminal_statuses: ['approved', 'omitted'],
      require_non_empty: true,
    },
  };
}

function reportSectionApprovalLoop(): Record<string, unknown> {
  return {
    collection: 'report.sections',
    proposed_status: 'proposed',
    seed: { source_stage: 'draft_sections', id_prefix: 'section' },
    decisions: {
      approve: { to: 'approved' },
      revise: {
        to: 'proposed',
        requires_instruction: true,
        instruction_path: 'report.sections.*.user_instruction',
        re_propose: true,
      },
      skip: { to: 'omitted' },
    },
    one_proposed_at_a_time: true,
    aggregate: {
      guard_field: 'report.all_sections_resolved',
      terminal_statuses: ['approved', 'omitted'],
    },
    stage: 'approve_sections',
    summary_path: 'summary.approved_sections',
    violation_path: 'report.section_confirmation_violation_json',
    pending_action_path: 'decisions.pending_section_approval',
  };
}
