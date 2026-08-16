import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold, type RenderStandaloneOptions } from '../../src/pgas-new/template-renderer.js';

const uploadDomain = {
  'program.slug': 'document-upload-hermetic',
  'program.name': 'Document Upload Hermetic',
  'program.target_dir': '/tmp/document-upload-hermetic',
  'program.design_path': 'design',
  'intake.purpose': 'Request an uploaded text document, ingest its text deterministically, and complete.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'ingest_source' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'ingest_source', trigger: 'started', guard_field: 'intake.started' },
    { from: 'ingest_source', to: 'complete', trigger: 'source_ready', guard_field: 'work.source_ready' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.documents_json': JSON.stringify({
    version: 1,
    stage: 'ingest_source',
    upload_types: ['text/plain', 'text/markdown'],
    extraction: 'self_contained',
    target: { root: 'work.source' },
    required: false,
    fidelity_floor: { min_chars: 40 },
  }),
  'intake.completion_json': JSON.stringify({
    final_stage: 'complete',
    guard_field: 'work.source_ready',
  }),
};

const uploadDomainWithPostIngestStage = {
  ...uploadDomain,
  'program.slug': 'document-upload-review',
  'program.name': 'Document Upload Review',
  'program.target_dir': '/tmp/document-upload-review',
  'intake.purpose': 'Request an uploaded text document, ingest its text deterministically, then review it in a later stage.',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'ingest_source' },
    { slug: 'review_source' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'ingest_source', trigger: 'started', guard_field: 'intake.started' },
    { from: 'ingest_source', to: 'review_source', trigger: 'source_ready', guard_field: 'work.source_ready' },
    { from: 'review_source', to: 'complete', trigger: 'reviewed', guard_field: 'review_source.ready' },
  ]),
  'intake.completion_json': JSON.stringify({
    final_stage: 'complete',
    guard_field: 'review_source.ready',
  }),
};

const requiredUploadWithReusedDocumentIngestDomain = {
  'program.slug': 'document-finalization-smoke',
  'program.name': 'Document Finalization Smoke',
  'program.target_dir': '/tmp/document-finalization-smoke',
  'program.design_path': 'design',
  'intake.purpose': 'Upload a document, settle manifest-reused document ingest, then advance to the finalization hub.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'start', is_bootstrap: true },
    { slug: 'ingest' },
    { slug: 'finalization_hub' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'start', to: 'ingest', trigger: 'started', guard_field: 'start.started' },
    { from: 'ingest', to: 'finalization_hub', trigger: 'ingested', guard_field: 'work.document_ready' },
    { from: 'finalization_hub', to: 'complete', trigger: 'finalized', guard_field: 'finalization_hub.finalize_requested' },
  ]),
  'intake.delegation_json': JSON.stringify({
    children: [{
      id: 'document_ingest',
      stage: 'ingest',
      action_name: 'document_ingest',
      target_spec: 'SimoneOS Document Ingest',
      registered_name: 'document-ingest',
      target_slug: 'document-ingest',
      payload_map: {
        'request.documents': 'work.document.documents',
        'request.extraction_contract': 'work.document.extraction_contract',
      },
      result_path: 'ingest.delegation.document_ingest.result',
      max_delegated_rounds: 12,
      round_timeout_ms: 120000,
      optional: true,
    }],
  }),
  'intake.documents_json': JSON.stringify({
    version: 1,
    stage: 'ingest',
    upload_types: ['text/plain', 'text/markdown'],
    extraction: 'self_contained',
    target: { root: 'work.document' },
    required: true,
    fidelity_floor: { min_chars: 40 },
  }),
  'intake.completion_json': JSON.stringify({
    final_stage: 'complete',
    guard_field: 'finalization_hub.finalize_requested',
  }),
};

describe('generated document upload smoke test', () => {
  it('asserts upload extraction and advancement past ingest instead of terminal completion when later stages remain', () => {
    const artifact = artifactFromDomain(uploadDomainWithPostIngestStage);

    expect(artifact.smoke_test_ts).toContain('expect(result.upload?.fileRef.fileId).toEqual(expect.any(String))');
    expect(artifact.smoke_test_ts).toContain('expect(source.full_text).toBe(result.upload?.content)');
    expect(artifact.smoke_test_ts).toContain("expect(result.final.mode).toBe('review_source')");
    expect(artifact.smoke_test_ts).not.toContain("expect(result.final.mode).toBe('complete')");
  });

  it('boots synthesized self-contained upload intake through the route and proves text extraction plus skip', { timeout: 120_000 }, () => {
    const artifact = artifactFromDomain(uploadDomain);
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-upload-render-'));

    try {
      renderStandaloneScaffold({
        slug: 'document-upload-hermetic',
        name: 'Document Upload Hermetic',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: {
          ingest_source: `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'source_ready', at: runtime.now() }),
    items_json: JSON.stringify(['source-ready']),
    digest: '',
  };
}
`,
        },
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      } satisfies RenderStandaloneOptions);
      linkRootNodeModules(targetDir);

      expect(artifact.spec_yaml).toContain('document_upload:');
      expect(artifact.spec_yaml).toContain("document_upload:\n    - inputs.document_intake");
      expect(artifact.spec_yaml).toContain('request_documents:');
      expect(artifact.spec_yaml).toContain('ingest_documents:');
      expect(artifact.spec_yaml).toContain('work.source.full_text: string');
      expect(artifact.spec_yaml).toContain('work.source_ready: boolean');
      expect(artifact.handlers_ts).toContain('const request = payload.request');
      expect(artifact.handlers_ts).toContain('request?.documents');
      expect(artifact.spec_yaml).not.toContain('arg_descriptions:\n      request:');
      expect(artifact.smoke_test_ts).toContain('runs synthesized document upload hermetically through the route');
      expect(artifact.smoke_test_ts).toContain('client.files.upload');
      expect(artifact.smoke_test_ts).not.toContain('createTestHarness');

      expect(existsSync(join(targetDir, 'src/programs/document-upload-hermetic/registration.ts'))).toBe(false);
      expect(artifact.smoke_test_ts).toContain('loadSmokeProgramByConvention');

      const output = runGeneratedSmokeTest(targetDir);
      expect(output).toContain('2 passed');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('boots required upload plus manifest-reused document-ingest through the route and reaches the hub', { timeout: 120_000 }, () => {
    const artifact = artifactFromDomain(requiredUploadWithReusedDocumentIngestDomain);
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-upload-reuse-render-'));

    try {
      renderStandaloneScaffold({
        slug: 'document-finalization-smoke',
        name: 'Document Finalization Smoke',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: {
          ingest: `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'document_ingest_settled', at: runtime.now() }),
    items_json: JSON.stringify(['document-ingest-settled']),
    digest: '',
  };
}
`,
          finalization_hub: `import type { StageInput, StageOutput } from '../contracts.js';

export async function runStage(input: StageInput): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'hub_ready' }),
    items_json: JSON.stringify(['hub-ready']),
    digest: '',
  };
}
`,
        },
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      } satisfies RenderStandaloneOptions);
      linkRootNodeModules(targetDir);

      expect(artifact.smoke_test_ts).toContain("name: 'document-ingest'");
      expect(artifact.smoke_test_ts).toContain("effect('document_ingest'");
      expect(artifact.smoke_test_ts).toContain("expect(result.final.mode).toBe('finalization_hub')");

      const output = runGeneratedSmokeTest(targetDir);
      expect(output).toContain('1 passed');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function runGeneratedSmokeTest(targetDir: string): string {
  const vitestBin = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  return execFileSync(process.execPath, [vitestBin, 'run', '--pool=threads', '--maxWorkers=1', 'tests/generated-program-smoke.test.ts'], {
    cwd: targetDir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', RAYON_NUM_THREADS: '1' },
  });
}
