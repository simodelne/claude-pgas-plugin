import { File } from 'node:buffer';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold, type RenderStandaloneOptions } from '../../src/pgas-new/template-renderer.js';
import { stripConventionSidecars } from '../fixtures/convention-sidecars.js';
import { loadRenderedGeneratedProgramEntry } from '../fixtures/generated-convention-entry.js';

interface ParsedSpec {
  channels: Record<string, Record<string, unknown>>;
  modes: Record<string, {
    vocabulary?: string[];
    channels?: string[];
    preconditions?: Record<string, unknown[]>;
    transitions?: Array<{ target: string; when?: { kind: string; path: string } }>;
  }>;
  schema: Record<string, string>;
  projection: Record<string, { include: string[]; exclude: string[] }>;
  reactions: Record<string, { event: string; write_scope: string[] }>;
  action_map: Record<string, Record<string, unknown>>;
}

describe('dynamic document delegation fan-out synthesis', () => {
  it('emits one runtime per-document review child loop without predeclared review_doc_N stages', { timeout: 120_000 }, async () => {
    const artifact = synthesizeProgramSpecFromDomain(dynamicDocumentReviewDomain());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(Object.keys(parsed.modes).filter((mode) => /^review_doc_\d+$/u.test(mode))).toEqual([]);
    expect(parsed.modes.review_documents.vocabulary).toContain('request_review');
    expect(parsed.modes.review_documents.vocabulary).toContain('complete_review_documents');
    expect(parsed.channels.review_call).toMatchObject({
      direction: 'Out',
      sync: 'Sync',
      target_spec: 'document-review-worker',
      result_path: 'review_documents.delegation.review.result',
      max_delegated_rounds: 12,
      optional: true,
    });
    expect(parsed.action_map.request_review).toMatchObject({
      channel: 'review_call',
      result_path: 'review_documents.delegation.review.result',
    });
    expect(parsed.action_map.request_review.mutations).toEqual(expect.arrayContaining([
      { op: 'MSet', path: 'review_documents.delegation.review.requested', value: true },
    ]));
    expect(parsed.modes.review_documents.preconditions?.request_review).toEqual(expect.arrayContaining([
      { kind: 'FieldFalsy', path: 'review_documents.delegation.review.requested' },
      { kind: 'FieldFalsy', path: 'review_documents.fan_out.complete' },
    ]));
    expect(parsed.modes.review_documents.preconditions?.complete_review_documents).toEqual([
      { kind: 'FieldTruthy', path: 'review_documents.fan_out.complete' },
    ]);
    expect(parsed.modes.review_documents.transitions).toEqual([
      { target: 'complete', when: { kind: 'FieldTruthy', path: 'review_documents.fan_out.complete' } },
    ]);

    expect(parsed.schema).toMatchObject({
      'review_documents.fan_out.index': 'number',
      'review_documents.fan_out.complete': 'boolean',
      'review_documents.fan_out.results': 'object',
      'review_documents.fan_out.results.*': 'object',
      'review_documents.fan_out.results.*.document_id': 'string',
      'review_documents.fan_out.results.*.sessionId': 'string',
      'work.source.documents': 'array',
      'work.source.current_document': 'object',
      'work.source.current_document.id': 'string',
      'work.source.current_document.text': 'string',
    });
    expect(parsed.reactions.advance_review_document_fan_out).toEqual({
      event: 'AfterRound',
      watch: [],
      write_scope: expect.arrayContaining([
        'review_documents.fan_out.index',
        'review_documents.fan_out.complete',
        'review_documents.fan_out.results.*',
        'review_documents.delegation.review.settled',
        'review_documents.delegation.review.degraded',
        'review_documents.delegation.review.degrade_reason',
        'review_documents.delegation.review.requested',
        'work.source.current_document',
        'work.source.current_document.id',
        'work.source.current_document.text',
      ]),
    });
    expect(parsed.projection.review_documents.include).toEqual(expect.arrayContaining([
      'work.source.current_document.id',
      'work.source.current_document.name',
      'work.source.document_count',
      'review_documents.fan_out.index',
      'review_documents.fan_out.complete',
      'review_documents.fan_out.results.*.document_id',
      'review_documents.fan_out.results.*.summary',
    ]));
    expect(parsed.projection.review_documents.include).not.toContain('work.source.documents');
    expect(parsed.projection.review_documents.include).not.toContain('work.source.current_document.text');
    expect(parsed.projection.review_documents.include).not.toContain('review_documents.fan_out.results');
    expect(parsed.projection.review_documents.include).not.toContain('review_documents.fan_out.results.*');
    expect(parsed.projection.review_documents.include).not.toContain('review_documents.fan_out.results.*.result');
    expect(parsed.projection.review_documents.include).not.toContain('review_documents.fan_out.results.*.seeded_topic');

    expect(artifact.registration_ts).toContain("{ source: 'work.source.current_document.text', target: 'request.topic' }");
    expect(artifact.registration_ts).toContain("{ source: 'work.source.current_document.id', target: 'request.document_id' }");
    expect(artifact.registration_ts).toContain("{ source: 'work.source.current_document.name', target: 'request.document_name' }");
    expect(artifact.handlers_ts).toContain('...(documentArtifactMutations(documentPath, documentArtifactsFromIngestResult(result)) ?? [])');
    expect(artifact.handlers_ts).not.toContain('...documentArtifactMutations(documentPath, documentArtifactsFromIngestResult(result)),');
    expect(artifact.handlers_ts).toContain('...(documentSliceMutations(config.currentDocumentPath, nextDocument) ?? [])');
    expect(artifact.handlers_ts).not.toContain('...documentSliceMutations(config.currentDocumentPath, nextDocument),');
    expect(artifact.smoke_test_ts).toContain('document fan-out review smoke');
    expect(artifact.smoke_test_ts).toContain('five document review delegations');
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-dynamic-doc-fanout-render-'));
    try {
      const childArtifacts = (
        artifact as typeof artifact & { child_artifacts?: RenderStandaloneOptions['synthesizedChildArtifacts'] }
      ).child_artifacts;
      const workerChild = childArtifacts?.find((child) => child.slug === 'document-review-worker');
      renderStandaloneScaffold({
        slug: 'dynamic-document-review',
        name: 'Dynamic Document Review',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedRegistrationTs: artifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: {
          ...artifact.stage_sources,
          upload_docs: `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void input;
  return {
    result_json: JSON.stringify({ source_ready: true, at: runtime.now() }),
    items_json: JSON.stringify(['document-source-ready']),
    digest: '',
  };
}
`,
        },
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
        synthesizedChildArtifacts: childArtifacts,
      } satisfies RenderStandaloneOptions);
      linkRootNodeModules(targetDir);

      const runtime = await runRenderedFanOutScenario(targetDir, workerChild?.delegation_result_policy);
      expect(runtime.resultKeys).toEqual(runtime.documentIds);
      expect(runtime.sessionCount).toBe(5);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

function dynamicDocumentReviewDomain(): Record<string, unknown> {
  return {
    'program.slug': 'dynamic-document-review',
    'program.name': 'Dynamic Document Review',
    'program.target_dir': '/tmp/dynamic-document-review',
    'intake.purpose': 'Upload any number of VDR documents and delegate one review child per document at runtime.',
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
      {
        slug: 'review_documents',
        domain_spec: {
          reads: ['work.source.documents', 'work.source.current_document', 'inputs.initial_user_text'],
          produces: {
            result_json: {
              reviewed_document_count: 'number',
              status: 'string',
            },
            items_json: ['review:<reviewed_document_count>'],
          },
          rules: ['Delegate exactly one isolated review child per uploaded document.'],
          invariants: ['Each child receives only work.source.current_document.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'upload_docs', trigger: 'started', guard_field: 'intake.started' },
      { from: 'upload_docs', to: 'review_documents', trigger: 'uploaded', guard_field: 'work.source_ready' },
      { from: 'review_documents', to: 'complete', trigger: 'done', guard_field: 'review_documents.fan_out.complete' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        upload_docs: { kind: 'pure-compute' },
        review_documents: { kind: 'llm-reasoning', reasoning_per_turn: true },
      },
      children: [
        {
          id: 'review',
          stage: 'review_documents',
          synthesize_child: {
            kind: 'worker',
            slug: 'document-review-worker',
            purpose: 'Review the current uploaded document only.',
            result_fields: {
              seeded_topic: 'string',
              document_id: 'string',
              summary: 'string',
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
      stage: 'upload_docs',
      upload_types: ['text/plain', 'text/markdown'],
      extraction: 'self_contained',
      result_path: 'work.source',
      required: true,
      fidelity_floor: { min_chars: 1 },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'review_documents.fan_out.complete',
    }),
  };
}

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-dynamic-doc-fanout-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, stripConventionSidecars(specYaml));
  process.once('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return specPath;
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

async function runRenderedFanOutScenario(
  targetDir: string,
  childDelegationResultPolicy: { fields: Array<{ path: string; key: string }> } | undefined,
): Promise<{ resultKeys: string[]; documentIds: string[]; sessionCount: number }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-new-dynamic-doc-fanout-upload-'));
  const fixtures = [
    { name: 'doc-1.txt', content: 'Document one material contract text.' },
    { name: 'doc-2.txt', content: 'Document two diligence exhibit text.' },
    { name: 'doc-3.txt', content: 'Document three lease schedule text.' },
    { name: 'doc-4.txt', content: 'Document four financial statement text.' },
    { name: 'doc-5.txt', content: 'Document five board consent text.' },
  ];
  const server = await createPgasServer({
    programs: [
      { name: 'dynamic-document-review', entry: await loadRenderedGeneratedProgramEntry(targetDir, 'dynamic-document-review') },
      {
        name: 'document-review-worker',
        entry: await loadRenderedGeneratedProgramEntry(targetDir, 'document-review-worker', {
          entryOverrides: childDelegationResultPolicy ? { delegationResultPolicy: childDelegationResultPolicy } : undefined,
        }),
      },
    ],
    drivers: {
      authorHandle: createFanOutAuthor(fixtures),
      observerHandle: {
        modelId: 'dynamic-doc-fanout-unit-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    storage: { uploadsDir: join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));

  try {
    const created = await client.sessions.create({ program: 'dynamic-document-review' });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start dynamic document fan-out unit smoke' });
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'request upload' });
    const upload = await uploadTextFiles(client, sessionId, fixtures);
    const refs = refsFromUpload(upload);
    expect(refs).toHaveLength(5);
    const documentIds = fixtures.map((_, index) => `doc${String(index + 1)}`).sort();
    await client.sessions.trigger(sessionId, {
      channel: 'document_upload',
      payload: { 'inputs.document_intake.file_refs': refs.map((ref) => ({ fileId: ref.fileId, name: ref.name })) },
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const snapshot = await readSnapshot(client, sessionId);
      if (snapshot.mode === 'complete' || snapshot.domain['review_documents.fan_out.complete'] === true) {
        return fanOutRuntimeResult(snapshot.domain, documentIds);
      }
      try {
        await client.sessions.trigger(sessionId, { channel: 'user_text', payload: `continue dynamic document fan-out ${String(attempt + 1)}` });
      } catch (error) {
        if (!String((error as Error).message).includes('terminal')) {
          throw error;
        }
        const terminalSnapshot = await readSnapshot(client, sessionId);
        return fanOutRuntimeResult(terminalSnapshot.domain, documentIds);
      }
    }
    const snapshot = await readSnapshot(client, sessionId);
    throw new Error(`dynamic document fan-out did not complete in mode ${String(snapshot.mode)}: ${JSON.stringify(snapshot.domain)}`);
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function fanOutRuntimeResult(
  domain: Record<string, unknown>,
  documentIds: string[],
): { resultKeys: string[]; documentIds: string[]; sessionCount: number } {
  const fanOutResults = fanOutResultsAt(domain, 'review_documents.fan_out.results');
  const resultKeys = Object.keys(fanOutResults).sort();
  const sessionIds = new Set(resultKeys.map((key) => String((fanOutResults[key] as Record<string, unknown>).sessionId)));
  return { resultKeys, documentIds, sessionCount: sessionIds.size };
}

function fanOutResultsAt(domain: Record<string, unknown>, pathKey: string): Record<string, Record<string, unknown>> {
  const raw = resultAt(domain, pathKey);
  const grouped: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const [documentId, ...fieldParts] = key.split('.');
    if (!documentId) {
      continue;
    }
    const record = grouped[documentId] ?? {};
    if (fieldParts.length === 0 && isRecord(value)) {
      grouped[documentId] = { ...record, ...value };
    } else if (fieldParts.length > 0) {
      record[fieldParts.join('.')] = value;
      grouped[documentId] = record;
    }
  }
  return grouped;
}

async function uploadTextFiles(
  client: PgasClient,
  sessionId: string,
  fixtures: Array<{ name: string; content: string }>,
): Promise<unknown> {
  const form = new FormData();
  for (const fixture of fixtures) {
    const file = new File([fixture.content], fixture.name, { type: 'text/plain' });
    form.append('files', file as unknown as Blob, file.name);
  }
  return client.files.upload(sessionId, form);
}

function refsFromUpload(response: unknown): Array<Record<string, unknown>> {
  if (isRecord(response) && Array.isArray(response.files)) {
    return response.files.filter(isRecord);
  }
  return [];
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<{ mode: string | null; domain: Record<string, unknown> }> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    domain: world.domain as Record<string, unknown>,
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (isRecord(direct)) {
    return direct;
  }
  const prefix = `${pathKey}.`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function createFanOutAuthor(fixtures: Array<{ name: string; content: string }>) {
  let started = false;
  let requestedDocuments = false;
  let ingestedDocuments = false;
  let uploadCompleted = false;
  let requestedReviews = 0;
  let completedReviews = 0;
  let finalCompleted = false;
  return {
    modelId: 'dynamic-doc-fanout-unit-author',
    async complete(prompt: string) {
      if (prompt.includes('begin_work') && !started) {
        started = true;
        return JSON.stringify(effect('begin_work', {}));
      }
      if (prompt.includes('request_documents') && !requestedDocuments) {
        requestedDocuments = true;
        return JSON.stringify(effect('request_documents', {}));
      }
      if (prompt.includes('ingest_documents') && !ingestedDocuments) {
        ingestedDocuments = true;
        return JSON.stringify(effect('ingest_documents', {}, 'stage_output'));
      }
      if (prompt.includes('complete_upload_docs') && !uploadCompleted) {
        uploadCompleted = true;
        return JSON.stringify(effect('complete_upload_docs', { __stage_runtime: { now_iso: '2026-07-26T00:00:00.000Z', random: 0.25 } }, 'stage_output'));
      }
      if (prompt.includes('complete_work') && completedReviews < requestedReviews) {
        const fixture = fixtures[completedReviews] as { name: string; content: string };
        const documentId = `doc${String(completedReviews + 1)}`;
        completedReviews += 1;
        return JSON.stringify(effect('complete_work', {
          result_json: JSON.stringify({ summary: 'reviewed current document', seeded_topic: fixture.content, document_id: documentId }),
          items_json: JSON.stringify([`reviewed-${documentId}`]),
          summary: 'reviewed current document',
          seeded_topic: fixture.content,
          document_id: documentId,
        }, 'widget_output'));
      }
      if (prompt.includes('begin_work') && completedReviews < requestedReviews) {
        return JSON.stringify(effect('begin_work', {}));
      }
      if (prompt.includes('request_review') && requestedReviews < fixtures.length) {
        requestedReviews += 1;
        return JSON.stringify(effect('request_review', { request: { intent: 'review-current-document' } }, 'review_call'));
      }
      if (prompt.includes('complete_review_documents') && !finalCompleted) {
        finalCompleted = true;
        return JSON.stringify(effect('complete_review_documents', {
          result_json: JSON.stringify({ reviewed_document_count: 5, status: 'complete' }),
          items_json: JSON.stringify(['five document review delegations']),
        }, 'widget_output'));
      }
      return JSON.stringify(effect('', {}));
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
