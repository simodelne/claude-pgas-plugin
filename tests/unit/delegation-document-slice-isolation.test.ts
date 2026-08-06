import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

interface InputEnrichmentRule {
  source: string;
  target: string;
  targetProgram?: string;
}

interface ParsedSpec {
  schema: Record<string, unknown>;
  action_map: Record<string, { mutations?: Array<Record<string, unknown>> }>;
}

const DOCUMENTS = [
  {
    id: 'doc1',
    name: '01_customer-contracts.md',
    text: 'DOC1_ONLY_BODY customer concentration consent risk',
  },
  {
    id: 'doc2',
    name: '02_litigation.md',
    text: 'DOC2_ONLY_BODY distributor litigation reserve risk',
  },
  {
    id: 'doc3',
    name: '03_financials.md',
    text: 'DOC3_ONLY_BODY leverage covenant waiver risk',
  },
] as const;

describe('per-document delegation slice isolation', () => {
  it('materializes each static review child payload from only that child document slice', () => {
    const artifact = synthesizeProgramSpecFromDomain(perDocumentReviewDomain());
    const rules = inputEnrichmentRules(artifact.registration_ts ?? '');

    expect(rules.filter((rule) => rule.target === 'request.topic')).toEqual(
      DOCUMENTS.map((document) => ({
        source: 'work.source.current_document.text',
        target: 'request.topic',
        targetProgram: document.id,
      })),
    );

    for (const [index, document] of DOCUMENTS.entries()) {
      const payload = materializePayload(
        rulesForTargetProgram(rules, document.id),
        parentDomainWithActiveDocument(index),
      );
      const serialized = JSON.stringify(payload);

      expect(readNestedString(payload, 'request.topic')).toBe(document.text);
      expect(readNestedString(payload, 'request.document_id')).toBe(document.id);
      expect(readNestedString(payload, 'request.document_name')).toBe(document.name);

      for (const other of DOCUMENTS.filter((candidate) => candidate.id !== document.id)) {
        expect(serialized).not.toContain(other.text);
        expect(serialized).not.toContain(other.id);
        expect(serialized).not.toContain(other.name);
      }
    }

    expect(rules.some((rule) => rule.source === 'work.source.full_text')).toBe(false);

    const parsed = load(artifact.spec_yaml) as ParsedSpec;
    expect(parsed.schema).toMatchObject({
      'work.source.documents': 'array',
      'work.source.documents.*': 'object',
      'work.source.documents.*.id': 'string',
      'work.source.documents.*.name': 'string',
      'work.source.documents.*.text': 'string',
      'work.source.documents.*.provenance': 'object',
      'work.source.current_document': 'object',
      'work.source.current_document.id': 'string',
      'work.source.current_document.name': 'string',
      'work.source.current_document.text': 'string',
    });

    expect(mutationsFor(parsed, 'complete_upload_docs')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: 'MSet',
        path: 'work.source.current_document',
        from_state: 'work.source.documents.0',
      }),
    ]));
    expect(mutationsFor(parsed, 'complete_review_doc_1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: 'MSet',
        path: 'work.source.current_document',
        from_state: 'work.source.documents.1',
      }),
    ]));
    expect(mutationsFor(parsed, 'complete_review_doc_2')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: 'MSet',
        path: 'work.source.current_document',
        from_state: 'work.source.documents.2',
      }),
    ]));
  });
});

function perDocumentReviewDomain(): Record<string, unknown> {
  const reviewStages = ['review_doc_1', 'review_doc_2', 'review_doc_3'];
  return {
    'program.slug': 'document-slice-parent',
    'program.name': 'Document Slice Parent',
    'program.target_dir': '/tmp/document-slice-parent',
    'intake.purpose': 'Upload three VDR documents and delegate one review child per document.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'upload_docs',
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: { result_json: { source_ready: 'boolean' }, items_json: ['upload_docs:ready'] },
          rules: ['Upload source documents.'],
          invariants: ['Document text comes from upload ingestion.'],
        },
      },
      ...reviewStages.map((slug, index) => ({
        slug,
        domain_spec: {
          reads: ['work.source.full_text', 'work.source.files_json', 'inputs.initial_user_text'],
          produces: {
            result_json: {
              seeded_topic: 'string',
              document_id: 'string',
              summary: 'string',
            },
            items_json: [`doc${String(index + 1)}:<seeded_topic>`],
          },
          rules: [`Review uploaded document ${String(index + 1)} only.`],
          invariants: ['Do not use non-target uploaded documents.'],
        },
      })),
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'upload_docs', trigger: 'started', guard_field: 'intake.started' },
      { from: 'upload_docs', to: 'review_doc_1', trigger: 'uploaded', guard_field: 'work.source_ready' },
      { from: 'review_doc_1', to: 'review_doc_2', trigger: 'doc1_done', guard_field: 'review_doc_1.ready' },
      { from: 'review_doc_2', to: 'review_doc_3', trigger: 'doc2_done', guard_field: 'review_doc_2.ready' },
      { from: 'review_doc_3', to: 'complete', trigger: 'doc3_done', guard_field: 'review_doc_3.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        upload_docs: { kind: 'pure-compute' },
        review_doc_1: { kind: 'llm-reasoning', reasoning_per_turn: true },
        review_doc_2: { kind: 'llm-reasoning', reasoning_per_turn: true },
        review_doc_3: { kind: 'llm-reasoning', reasoning_per_turn: true },
      },
      children: reviewStages.map((stage, index) => ({
        id: `doc${String(index + 1)}`,
        stage,
        synthesize_child: {
          kind: 'worker',
          slug: `doc${String(index + 1)}`,
          purpose: `Review uploaded document ${String(index + 1)}.`,
          result_fields: {
            seeded_topic: 'string',
            document_id: 'string',
            summary: 'string',
          },
        },
        payload_map: {
          'request.topic': 'work.source.full_text',
          'domain_context.original_request': 'inputs.initial_user_text',
        },
        result_path: `${stage}.delegation.doc${String(index + 1)}.result`,
        max_delegated_rounds: 12,
        optional: true,
      })),
    }),
    'intake.documents_json': JSON.stringify({
      version: 1,
      stage: 'upload_docs',
      upload_types: ['text/plain', 'text/markdown'],
      extraction: 'self_contained',
      result_path: 'work.source',
      required: true,
      fidelity_floor: { min_chars: 1 },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'review_doc_3.ready',
    }),
  };
}

function inputEnrichmentRules(registrationSource: string): InputEnrichmentRule[] {
  return Array.from(
    registrationSource.matchAll(
      /\{\s*source:\s*'([^']+)',\s*target:\s*'([^']+)'(?:,\s*targetProgram:\s*'([^']+)')?\s*\}/gu,
    ),
    (match) => ({
      source: match[1] as string,
      target: match[2] as string,
      ...(match[3] ? { targetProgram: match[3] as string } : {}),
    }),
  );
}

function rulesForTargetProgram(rules: InputEnrichmentRule[], targetProgram: string): InputEnrichmentRule[] {
  return rules.filter((rule) => rule.targetProgram === undefined || rule.targetProgram === targetProgram);
}

function parentDomainWithActiveDocument(index: number): Map<string, unknown> {
  const active = DOCUMENTS[index]!;
  return new Map<string, unknown>([
    ['inputs.initial_user_text', 'prepare diligence'],
    ['work.source.full_text', DOCUMENTS.map((document) => `${document.id} ${document.name}\n${document.text}`).join('\n\n')],
    ['work.source.documents', DOCUMENTS],
    ...DOCUMENTS.flatMap((document, documentIndex) => [
      [`work.source.documents.${String(documentIndex)}`, document] as const,
      [`work.source.documents.${String(documentIndex)}.id`, document.id] as const,
      [`work.source.documents.${String(documentIndex)}.name`, document.name] as const,
      [`work.source.documents.${String(documentIndex)}.text`, document.text] as const,
    ]),
    ['work.source.current_document', active],
    ['work.source.current_document.id', active.id],
    ['work.source.current_document.name', active.name],
    ['work.source.current_document.text', active.text],
  ]);
}

function materializePayload(
  rules: InputEnrichmentRule[],
  parentDomain: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const rule of rules) {
    const value = parentDomain.get(rule.source);
    if (value !== undefined) {
      setNestedPath(payload, rule.target, value);
    }
  }
  return payload;
}

function setNestedPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
      continue;
    }
    const next: Record<string, unknown> = {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]!] = value;
}

function readNestedString(root: Record<string, unknown>, path: string): string {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    cursor = cursor && typeof cursor === 'object' && !Array.isArray(cursor)
      ? (cursor as Record<string, unknown>)[segment]
      : undefined;
  }
  return typeof cursor === 'string' ? cursor : '';
}

function mutationsFor(parsed: ParsedSpec, actionName: string): Array<Record<string, unknown>> {
  return parsed.action_map[actionName]?.mutations ?? [];
}
