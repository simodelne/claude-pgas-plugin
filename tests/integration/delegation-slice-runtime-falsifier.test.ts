import { File } from 'node:buffer';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { dump, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain, type SynthesizedSpec } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold, type RenderStandaloneOptions } from '../../src/pgas-new/template-renderer.js';

const PROGRAM_SLUG = 'document-slice-runtime';
const PROGRAM_NAME = 'Document Slice Runtime';

const DOCUMENTS = [
  {
    id: 'doc1',
    name: '01-alpha-contract.txt',
    text: 'PGAS770_DOC1_SENTINEL customer concentration consent risk',
  },
  {
    id: 'doc2',
    name: '02-beta-litigation.txt',
    text: 'PGAS770_DOC2_SENTINEL litigation reserve exclusivity risk',
  },
  {
    id: 'doc3',
    name: '03-gamma-financials.txt',
    text: 'PGAS770_DOC3_SENTINEL covenant waiver leverage risk',
  },
] as const;
const TARGET_DOCUMENT_INDEX = 0;
const TARGET_DOCUMENT = DOCUMENTS[TARGET_DOCUMENT_INDEX]!;
const TARGET_STAGE = `review_doc_${String(TARGET_DOCUMENT_INDEX + 1)}`;
const UPSTREAM_SUMMARY = '{"transaction_summary":"UPSTREAM_SUMMARY_SHOULD_NOT_OVERWRITE_DOCUMENT_SLICE"}';
const REQUEST_PROJECTION_PATHS = [
  'inputs.request',
  'inputs.request.topic',
  'inputs.request.document_id',
  'inputs.request.document_name',
] as const;

describe('delegation slice runtime delivery falsifier', () => {
  it('delivers per-dispatch inputEnrichment into each child round-0 request projection', { timeout: 120_000 }, async () => {
    const artifact = artifactFromDomain(perDocumentReviewDomain());
    const childArtifacts = childArtifactsWithRequestProjection(artifact.child_artifacts ?? []);
    const parsed = load(artifact.spec_yaml) as {
      projection: Record<string, { include: string[]; exclude: string[] }>;
    };
    const targetChild = childArtifacts.find((child) => child.slug === TARGET_DOCUMENT.id);
    const targetChildSpec = load(String(targetChild?.spec_yaml ?? '')) as {
      projection: Record<string, { include: string[]; exclude: string[] }>;
    };

    expect(parsed.projection[TARGET_STAGE]?.include).toContain('work.source.current_document.id');
    expect(parsed.projection[TARGET_STAGE]?.include).not.toContain('work.source.current_document.text');
    expect(targetChildSpec.projection.work.include).toEqual(expect.arrayContaining([...REQUEST_PROJECTION_PATHS]));
    expect(artifact.registration_ts).toContain("{ source: 'work.source.current_document.text', target: 'request.topic' }");
    expect(artifact.registration_ts).toContain("{ source: 'work.source.current_document.id', target: 'request.document_id' }");
    expect(artifact.registration_ts).toContain("{ source: 'work.source.current_document.name', target: 'request.document_name' }");
    expect(artifact.registration_ts).toContain("source: 'transaction_understanding.result_json'");

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-slice-runtime-'));
    try {
      renderStandaloneScaffold({
        slug: PROGRAM_SLUG,
        name: PROGRAM_NAME,
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
  return {
    result_json: JSON.stringify({ stage: input.stage, file_count: 3, source_ready: true, at: runtime.now() }),
    items_json: JSON.stringify(['upload_docs:3']),
    digest: '',
  };
}
`,
        },
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
        synthesizedChildArtifacts: childArtifacts,
      } satisfies RenderStandaloneOptions & DelegationRenderOptions);
      linkRootNodeModules(targetDir);

      const evidence = await runRenderedSliceScenario(targetDir);
      expect(evidence.target.parentRequestTopic).toBe(TARGET_DOCUMENT.text);
      expect(evidence.target.seededTopic).toBe(TARGET_DOCUMENT.text);
      expect(evidence.target.documentId).toBe(TARGET_DOCUMENT.id);
      expect(evidence.target.documentName).toBe(TARGET_DOCUMENT.name);
      expect(evidence.target.seededTopic).not.toBe(`raw-${TARGET_DOCUMENT.id}-slug`);
      expect(evidence.target.seededTopic).not.toBe(UPSTREAM_SUMMARY);

      for (const other of DOCUMENTS.filter((candidate) => candidate.id !== TARGET_DOCUMENT.id)) {
        expect(JSON.stringify(evidence.target)).not.toContain(other.text);
      }

      expect(duplicateInputEnrichmentTargets(artifact.registration_ts ?? '')).toEqual([]);

      process.stdout.write(`[delegation-slice-runtime-falsifier] GREEN ${JSON.stringify(evidence.target)}\n`);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

interface DelegationArtifactExtension {
  registration_ts?: string;
  child_artifacts?: Array<SynthesizedSpec & {
    slug: string;
    name: string;
    registration_ts?: string;
    stage_sources?: Record<string, string>;
  }>;
}

interface DelegationRenderOptions {
  synthesizedRegistrationTs?: string;
  synthesizedChildArtifacts?: NonNullable<DelegationArtifactExtension['child_artifacts']>;
}

interface SliceEvidence {
  mode: string | null;
  target: {
    documentId: string;
    documentName: string;
    parentRequestDocumentId: string;
    parentRequestDocumentName: string;
    parentRequestTopic: string;
    seededTopic: string;
    status: string;
    sessionId: string;
  };
}

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact & DelegationArtifactExtension {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

function childArtifactsWithRequestProjection(
  childArtifacts: NonNullable<DelegationArtifactExtension['child_artifacts']>,
): NonNullable<DelegationArtifactExtension['child_artifacts']> {
  return childArtifacts.map((child) => {
    if (child.slug !== TARGET_DOCUMENT.id) {
      return child;
    }
    const parsed = load(child.spec_yaml) as {
      projection?: Record<string, { include?: string[]; exclude?: string[] }>;
    };
    const projection = parsed.projection ?? {};
    for (const mode of ['receive', 'work']) {
      const existing = projection[mode] ?? {};
      projection[mode] = {
        include: uniqueStrings([...(existing.include ?? []), ...REQUEST_PROJECTION_PATHS]),
        exclude: existing.exclude ?? [],
      };
    }
    parsed.projection = projection;
    return {
      ...child,
      spec_yaml: dump(parsed, { lineWidth: -1 }),
    };
  });
}

function perDocumentReviewDomain(): Record<string, unknown> {
  const reviewStages = DOCUMENTS.map((_, index) => `review_doc_${String(index + 1)}`);
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
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
      {
        slug: 'transaction_understanding',
        domain_spec: {
          reads: ['inputs.initial_user_text', 'work.source.files_json', 'work.source.document_count'],
          produces: {
            result_json: {
              transaction_summary: 'string',
              review_context: 'string',
            },
            items_json: ['transaction:<transaction_summary>'],
          },
          rules: ['Summarize the uploaded transaction before document review.'],
          invariants: ['This summary is context and must not replace the per-document review text.'],
        },
      },
      ...reviewStages.map((slug, index) => {
        const document = DOCUMENTS[index]!;
        return {
          slug,
          domain_spec: {
            reads: ['work.source.full_text', 'work.source.files_json', 'inputs.initial_user_text'],
            produces: {
              result_json: {
                document_id: 'string',
                document_name: 'string',
                summary: 'string',
              },
              items_json: [`${document.id}:<document_id>`],
            },
            rules: [`Review uploaded document ${String(index + 1)} only.`],
            invariants: ['Do not use non-target uploaded documents.'],
          },
        };
      }),
      {
        slug: 'summary_context',
        domain_spec: {
          reads: ['transaction_understanding.result_json', 'inputs.initial_user_text'],
          produces: {
            result_json: {
              summary: 'string',
            },
            items_json: ['summary_context:<summary>'],
          },
          rules: ['Review transaction summary context after per-document review.'],
          invariants: ['This stage is not allowed to overwrite per-document DD inputs.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'upload_docs', trigger: 'started', guard_field: 'intake.started' },
      { from: 'upload_docs', to: 'transaction_understanding', trigger: 'uploaded', guard_field: 'work.source_ready' },
      { from: 'transaction_understanding', to: 'review_doc_1', trigger: 'transaction_understood', guard_field: 'transaction_understanding.done' },
      { from: 'review_doc_1', to: 'review_doc_2', trigger: 'doc1_done', guard_field: 'review_doc_1.ready' },
      { from: 'review_doc_2', to: 'review_doc_3', trigger: 'doc2_done', guard_field: 'review_doc_2.ready' },
      { from: 'review_doc_3', to: 'summary_context', trigger: 'doc3_done', guard_field: 'review_doc_3.ready' },
      { from: 'summary_context', to: 'complete', trigger: 'summary_context_done', guard_field: 'summary_context.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        upload_docs: { kind: 'pure-compute' },
        transaction_understanding: { kind: 'llm-reasoning', reasoning_per_turn: true },
        [TARGET_STAGE]: { kind: 'llm-reasoning', reasoning_per_turn: true },
        summary_context: { kind: 'llm-reasoning', reasoning_per_turn: true },
      },
      children: [
        ...DOCUMENTS.map((document, index) => ({
          id: document.id,
          stage: `review_doc_${String(index + 1)}`,
          synthesize_child: {
            kind: 'worker',
            slug: document.id,
            purpose: `Review uploaded document ${String(index + 1)}.`,
            result_fields: {
              seeded_topic: 'string',
              document_id: 'string',
              document_name: 'string',
              summary: 'string',
            },
          },
          payload_map: {
            'request.topic': 'work.source.full_text',
            'domain_context.original_request': 'inputs.initial_user_text',
          },
          result_path: `review_doc_${String(index + 1)}.delegation.${document.id}.result`,
          max_delegated_rounds: 12,
          optional: true,
        })),
        {
          id: 'summary_context',
          stage: 'summary_context',
          synthesize_child: {
            kind: 'worker',
            slug: 'summary-context-worker',
            purpose: 'Review the upstream transaction summary.',
            result_fields: {
              seeded_topic: 'string',
              summary: 'string',
            },
          },
          payload_map: {
            'request.topic': 'transaction_understanding.result_json',
            'domain_context.original_request': 'inputs.initial_user_text',
          },
          result_path: 'summary_context.delegation.summary_context.result',
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
      guard_field: 'summary_context.ready',
    }),
  };
}

async function runRenderedSliceScenario(targetDir: string): Promise<SliceEvidence> {
  const parentModule = await import(pathToFileURL(join(targetDir, `src/programs/${PROGRAM_SLUG}/registration.ts`)).href);
  const childModule = await import(pathToFileURL(join(targetDir, `src/programs/${TARGET_DOCUMENT.id}/registration.ts`)).href);
  const uploadDir = mkdtempSync(join(tmpdir(), 'pgas-new-slice-runtime-upload-'));
  const author = createProjectionEchoAuthor();
  const server = await createPgasServer({
    programs: [
      { name: PROGRAM_SLUG, entry: programEntryFromModule(parentModule) },
      { name: TARGET_DOCUMENT.id, entry: programEntryFromModule(childModule) },
    ],
    drivers: {
      authorHandle: author,
      observerHandle: {
        modelId: 'delegation-slice-runtime-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    storage: { uploadsDir: uploadDir },
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));

  try {
    const created = await client.sessions.create({ program: PROGRAM_SLUG });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start document slice runtime falsifier' });
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'request document uploads' });
    const refs = refsFromUpload(await uploadTextFiles(client, sessionId));
    expect(refs).toHaveLength(DOCUMENTS.length);
    await client.sessions.trigger(sessionId, {
      channel: 'document_upload',
      payload: { 'inputs.document_intake.file_refs': refs.map((ref) => ({ fileId: ref.fileId, name: ref.name })) },
    });
    author.setUploadedDocuments(uploadedDocumentsFromDomain((await readSnapshot(client, sessionId)).domain));

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const snapshot = await readSnapshot(client, sessionId);
      if (snapshot.mode === 'complete') {
        return sliceEvidence(snapshot.mode, snapshot.domain);
      }
      const evidence = sliceEvidence(snapshot.mode, snapshot.domain);
      if (evidence.target.sessionId.length > 0) {
        return evidence;
      }
      await client.sessions.trigger(sessionId, {
        channel: 'user_text',
        payload: `continue document slice runtime falsifier ${String(attempt + 1)}`,
      });
    }

    const snapshot = await readSnapshot(client, sessionId);
    return sliceEvidence(snapshot.mode, snapshot.domain);
  } finally {
    await server.close();
    rmSync(uploadDir, { recursive: true, force: true });
  }
}

function createProjectionEchoAuthor() {
  let started = false;
  let requestedDocuments = false;
  let ingestedDocuments = false;
  let uploadCompleted = false;
  let transactionUnderstood = false;
  let uploadedDocuments: Record<string, unknown>[] = [];
  const requested = new Set<string>();
  const completed = new Set<string>();

  return {
    modelId: 'delegation-slice-runtime-author',
    setUploadedDocuments(documents: Record<string, unknown>[]) {
      uploadedDocuments = documents;
    },
    async complete(prompt: string) {
      const world = worldFromPrompt(prompt);
      const actionNames = availableActionNames(prompt);
      const requestTopic = readWorldString(world, 'inputs.request.topic');
      const requestDocumentId = readWorldString(world, 'inputs.request.document_id');
      const requestDocumentName = readWorldString(world, 'inputs.request.document_name');

      if (hasAction(actionNames, prompt, 'complete_work')) {
        const result = {
          seeded_topic: requestTopic,
          document_id: requestDocumentId,
          document_name: requestDocumentName,
          summary: requestTopic ? `saw ${requestDocumentId}` : 'missing request topic',
        };
        return JSON.stringify(effect('complete_work', {
          result_json: JSON.stringify(result),
          items_json: JSON.stringify([`${requestDocumentId || 'missing'}:summary`]),
          ...result,
        }));
      }

      if (prompt.includes('Accept the delegated request') && hasAction(actionNames, prompt, 'begin_work')) {
        return JSON.stringify(effect('begin_work', {}));
      }

      if (hasAction(actionNames, prompt, 'begin_work') && !started) {
        started = true;
        return JSON.stringify(effect('begin_work', {}));
      }
      if (hasAction(actionNames, prompt, 'request_documents') && !requestedDocuments) {
        requestedDocuments = true;
        return JSON.stringify(effect('request_documents', {}));
      }
      if (hasAction(actionNames, prompt, 'ingest_documents') && !ingestedDocuments) {
        ingestedDocuments = true;
        return JSON.stringify(effect('ingest_documents', {}, 'stage_output'));
      }
      if (hasAction(actionNames, prompt, 'complete_upload_docs') && !uploadCompleted) {
        uploadCompleted = true;
        return JSON.stringify(effect('complete_upload_docs', {
          __stage_runtime: { now_iso: '2026-07-26T00:00:00.000Z', random: 0.25 },
        }, 'stage_output'));
      }
      if (hasAction(actionNames, prompt, 'complete_transaction_understanding') && !transactionUnderstood) {
        transactionUnderstood = true;
        return JSON.stringify(effect('complete_transaction_understanding', {
          result_json: UPSTREAM_SUMMARY,
          items_json: JSON.stringify(['transaction:upstream-summary']),
          transaction_summary: 'UPSTREAM_SUMMARY_SHOULD_NOT_OVERWRITE_DOCUMENT_SLICE',
          review_context: 'upstream context only',
          [`document_slice_doc${String(TARGET_DOCUMENT_INDEX + 1)}`]: requiredUploadedDocument(world, uploadedDocuments, TARGET_DOCUMENT_INDEX),
        }));
      }

      for (const document of DOCUMENTS) {
        const index = DOCUMENTS.indexOf(document);
        const requestAction = `request_doc${String(index + 1)}`;
        if (hasAction(actionNames, prompt, requestAction) && !requested.has(document.id)) {
          requested.add(document.id);
          return JSON.stringify(effect(requestAction, {
            query: `review ${document.id} using parent decoy query`,
            request: {
              topic: `raw-${document.id}-slug`,
              query: `review ${document.id} using raw nested query`,
              document_id: `raw-${document.id}`,
              document_name: `raw-${document.name}`,
            },
          }, `${document.id}_call`));
        }
      }

      for (const document of DOCUMENTS) {
        const index = DOCUMENTS.indexOf(document);
        const completeAction = `complete_review_doc_${String(index + 1)}`;
        const generatedCompleteAction = actionNames.includes(completeAction)
          ? completeAction
          : actionNames.find((name) =>
            name.startsWith('complete_') &&
            name.includes('review') &&
            name.includes(String(index + 1))
          );
        if (generatedCompleteAction && requested.has(document.id) && !completed.has(document.id)) {
          completed.add(document.id);
          return JSON.stringify(effect(generatedCompleteAction, {
            result_json: JSON.stringify({ document_id: document.id, document_name: document.name, summary: 'parent observed child result' }),
            items_json: JSON.stringify([`${document.id}:parent-complete`]),
            document_id: document.id,
            document_name: document.name,
            summary: 'parent observed child result',
            ...(index + 1 < DOCUMENTS.length
              ? { [`document_slice_doc${String(index + 2)}`]: requiredUploadedDocument(world, uploadedDocuments, index + 1) }
              : {}),
          }));
        }
      }

      throw new Error(`delegation slice author could not choose an action; actions=${JSON.stringify(actionNames)}, world_keys=${JSON.stringify(Object.keys(world).sort())}`);
    },
  };
}

async function uploadTextFiles(client: PgasClient, sessionId: string): Promise<unknown> {
  const form = new FormData();
  for (const document of DOCUMENTS) {
    const file = new File([document.text], document.name, { type: 'text/plain' });
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

function sliceEvidence(mode: string | null, domain: Record<string, unknown>): SliceEvidence {
  const result = resultAt(domain, `${TARGET_STAGE}.delegation.${TARGET_DOCUMENT.id}.result`);
  const request = resultAt(domain, `${TARGET_STAGE}.delegation.${TARGET_DOCUMENT.id}.request`);
  return {
    mode,
    target: {
      documentId: String(result.document_id ?? ''),
      documentName: String(result.document_name ?? ''),
      parentRequestDocumentId: String(request.document_id ?? ''),
      parentRequestDocumentName: String(request.document_name ?? ''),
      parentRequestTopic: String(request.topic ?? ''),
      seededTopic: String(result.seeded_topic ?? ''),
      status: String(result.status ?? ''),
      sessionId: String(result.sessionId ?? ''),
    },
  };
}

function programEntryFromModule(module: Record<string, unknown>): ProgramEntry {
  const factory = Object.values(module).find((value) =>
    typeof value === 'function' &&
    /^create[A-Z].*ProgramEntry$/u.test(value.name)
  );
  if (typeof factory !== 'function') {
    throw new Error(`generated registration did not export a create*ProgramEntry function: ${Object.keys(module).join(', ')}`);
  }
  return factory() as ProgramEntry;
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
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

function uploadedDocumentsFromDomain(domain: Record<string, unknown>): Record<string, unknown>[] {
  const direct = domain['work.source.documents'];
  if (Array.isArray(direct) && direct.every(isRecord)) {
    return direct;
  }
  const nested = readWorldValue(domain, 'work.source.documents');
  if (Array.isArray(nested) && nested.every(isRecord)) {
    return nested;
  }
  throw new Error('uploaded document registry is missing work.source.documents in route world');
}

function worldFromPrompt(prompt: string): Record<string, unknown> {
  const framed = prompt.match(/WorldView:\n([\s\S]*?)\n\nVocabulary:/u);
  if (framed) {
    return parseRecord(framed[1]!);
  }
  const active = prompt.match(/World \(active\):\n([\s\S]*)$/u);
  if (active) {
    return parseRecord(active[1]!);
  }
  const marker = 'Current state:\n';
  const index = prompt.lastIndexOf(marker);
  if (index < 0) {
    return {};
  }
  return parseRecord(prompt.slice(index + marker.length));
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw.trim());
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readWorldString(world: Record<string, unknown>, path: string): string {
  const direct = world[path];
  if (typeof direct === 'string') {
    return direct;
  }
  let cursor: unknown = world;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor)) {
      return '';
    }
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' ? cursor : '';
}

function requiredUploadedDocument(
  world: Record<string, unknown>,
  uploadedDocuments: Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  const direct = readWorldValue(world, `work.source.documents.${String(index)}`);
  if (isRecord(direct)) {
    return direct;
  }
  const documents = readWorldValue(world, 'work.source.documents');
  if (Array.isArray(documents) && isRecord(documents[index])) {
    return documents[index];
  }
  const uploaded = uploadedDocuments[index];
  if (isRecord(uploaded)) {
    return uploaded;
  }
  throw new Error(`upload registry is missing work.source.documents.${String(index)}`);
}

function readWorldValue(world: Record<string, unknown>, path: string): unknown {
  if (path in world) {
    return world[path];
  }
  let cursor: unknown = world;
  for (const segment of path.split('.')) {
    if (Array.isArray(cursor)) {
      const index = Number.parseInt(segment, 10);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
      continue;
    }
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function availableActionNames(prompt: string): string[] {
  return Array.from(
    prompt.matchAll(/^\s*-\s+([a-zA-Z_][a-zA-Z0-9_]*):/gmu),
    (match) => match[1]!,
  );
}

function hasAction(actionNames: string[], prompt: string, actionName: string): boolean {
  return actionNames.includes(actionName) || prompt.includes(actionName);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function duplicateInputEnrichmentTargets(registrationSource: string): string[] {
  const targets = Array.from(
    registrationSource.matchAll(/\{\s*source:\s*'[^']+',\s*target:\s*'([^']+)'\s*\}/gu),
    (match) => match[1]!,
  );
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const target of targets) {
    if (seen.has(target)) {
      duplicates.add(target);
    }
    seen.add(target);
  }
  return [...duplicates].sort();
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
