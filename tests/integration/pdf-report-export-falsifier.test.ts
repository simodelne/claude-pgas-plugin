import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';
import { load } from 'js-yaml';
import {
  createProgramAdapters,
  loadSpecWithPatterns,
  type ProgramEntry,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { startRouteHarness } from './foundry-test-utils.js';
import { MockPdfReportConnector } from '../fixtures/pdf-report-mock.js';

const DEFAULT_TITLE = 'LEAD REPORT DEFAULT';
const PDF_PROGRAM = 'pdf-report-export-falsifier';
const OUTPUT_PATH = 'render_report.output';

const state = {
  config: { purpose: 'find AI engineers', title: 'Lead Report' },
  aggregate: { per_source: [{ source: 'https://example.com', found: 2, pages_visited: 2 }] },
  persist: { new_vs_existing: [{ email: 'a@x.com', status: 'new' }] },
  audit: [{ action: 'refuse', url: 'https://evil.test', reason: 'off-allowlist' }],
};

describe('PDF report export', () => {
  it('R-1 renderProfile replaces report-data and reads declared typed paths', async () => {
    const nonce = `PDF-SENTINEL-${randomUUID()}`;
    const directBytes = await new MockPdfReportConnector().render_report({
      title: nonce,
      purpose: 'find AI engineers',
      executive_summary: '',
      per_source: [{ source: 'https://example.com', found: 2, pages_visited: 2 }],
      leads: [{ email: 'a@x.com', status: 'new' }],
      guard_audit_summary: [{ action: 'refuse', url: 'https://evil.test', reason: 'off-allowlist' }],
    });
    const directText = Buffer.from(directBytes).toString('utf8');

    expect(directText).toContain(nonce);
    expect(directText).toContain('PER SOURCE');
    expect(directText).toContain('LEADS');
    expect(directText).toContain('GUARD AUDIT SUMMARY');
    expect(directText).not.toContain(DEFAULT_TITLE);

    const artifact = synthesizeProgramSpecFromDomain(pdfReportDomain());
    expect(artifact.registration_ts).toContain("artifactType: 'pdf_report'");
    expect(artifact.registration_ts).toContain("payloadRef: 'render_report.output'");
    expect(artifact.registration_ts).toContain("whenAllPaths: ['render_report.output.pdf_base64']");
    expect(artifact.registration_ts).toContain('const RENDER_PROFILE');
    expect(artifact.registration_ts).toContain('renderProfile: RENDER_PROFILE');
    expect(artifact.registration_ts).toContain("from: 'aggregate.result.per_source'");
    expect(artifact.registration_ts).toContain("from: 'persist.result.new_vs_existing'");
    expect(artifact.registration_ts).toContain("from: 'report.total_found'");
    expect(artifact.spec_yaml).toContain('\nrender:');
    expect(artifact.spec_yaml).toContain('artifactType: pdf_report');
    const parsed = load(artifact.spec_yaml) as {
      derived_paths?: Array<{ target: string; set: { kind: string; params?: Record<string, unknown> } }>;
      schema?: Record<string, string>;
    };
    expect(parsed.schema).toMatchObject({
      'aggregate.result.per_source': 'array',
      'persist.result.new_vs_existing': 'array',
      'report.total_found': 'number',
    });
    expect(parsed.derived_paths).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'report.total_found',
        set: {
          kind: 'sum_of',
          params: {
            collection_path: 'aggregate.result.per_source',
            field: 'found',
          },
        },
      }),
    ]));

    const generatorCalls: string[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-pdf-report-falsifier-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-08-05T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async (request) => {
          generatorCalls.push(request.stage);
          throw new Error(`PDF export stage must be deterministic; generator called for ${request.stage}`);
        },
      });

      expect(generatorCalls).not.toContain('render_report');
      const body = withBodies.stage_sources?.render_report ?? '';
      expect(body).toContain("from '../connectors/pdf-report.js'");
      expect(body).not.toContain(`from '${['..', 'report-data.js'].join('/')}'`);
      expect(body).not.toContain(['assemble', 'Structured', 'Report'].join(''));
      expect(body).not.toContain('.reduce(');

      const runStage = loadGeneratedPdfReportStage(body);
      const output = await runStage({
        stage: 'render_report',
        payload: {},
        domain: {
          ...state,
          config: { ...state.config, title: nonce },
          aggregate: {
            result: {
              per_source: [{ source: 'https://example.com', found: 2, pages_visited: 2 }],
              audit: [{ action: 'refuse', url: 'https://evil.test', reason: 'off-allowlist' }],
            },
          },
          persist: { result: { new_vs_existing: [{ email: 'a@x.com', status: 'new' }] } },
        },
        domain_spec: { reads: [], produces: {}, rules: [], invariants: [] },
      }, {
        now: () => '2026-08-05T00:00:00.000Z',
        random: () => 0.25,
        llm: async () => {
          throw new Error('StageRuntime.llm must not be used while rendering a PDF report');
        },
        crypto: webcrypto,
        pdf_report: new MockPdfReportConnector(),
        connectors: { pdf_report: new MockPdfReportConnector() },
      });

      expect(typeof output.result_json).toBe('string');
      expect(typeof output.items_json).toBe('string');
      const result = JSON.parse(output.result_json as string) as Record<string, unknown>;
      expect(result.pdf_base64).toEqual(expect.any(String));
      const bytes = Buffer.from(String(result.pdf_base64), 'base64');
      const text = bytes.toString('utf8');
      expect(text).toContain(nonce);
      expect(text).not.toContain(DEFAULT_TITLE);
      expect(result.pdf_bytes).toBe(bytes.length);
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(result.section_count).toBe(4);
      expect(JSON.parse(output.items_json as string)).toEqual([`pdf_report:${String(result.sha256)}`]);

      const drive = await runPdfReportDrive(nonce);
      expect(drive.finalMode === 'complete' || drive.finalStatus === 'complete').toBe(true);
      expect(drive.renderHandlerSawArgTitle).toBe(false);
      const harvestedBase64 = drive.output.pdf_base64;
      expect(typeof harvestedBase64).toBe('string');
      const harvestedText = Buffer.from(String(harvestedBase64), 'base64').toString('utf8');
      expect(harvestedText).toContain(nonce);
      expect(harvestedText).not.toContain(DEFAULT_TITLE);
      const record = extractArtifactRecords(drive.artifacts).find((candidate) => candidate.artifactType === 'pdf_report');
      expect(record, 'pdf_report SessionArtifactRecord present').toBeTruthy();
      expect(record?.payloadRef).toBe(OUTPUT_PATH);
    } finally {
      rmSync(cacheDir, { force: true, recursive: true });
    }
  });
});

function pdfReportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'pdf-report-demo',
    'program.name': 'PDF Report Demo',
    'intake.purpose': 'Find AI engineers and render a PDF report.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'render_report',
        kind: 'export_pdf',
        domain_spec: {
          reads: ['aggregate.per_source', 'persist.new_vs_existing', 'audit', 'config'],
          produces: {
            result_json: {
              stage: 'string',
              pdf_base64: 'string',
              pdf_bytes: 'number',
              sha256: 'string',
              section_count: 'number',
            },
            items_json: ['pdf_report:<sha256>'],
          },
          rules: ['Assemble structured report data and render through PdfReportHostConnector.'],
          invariants: ['No LLM or network is required while rendering PDF report bytes.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'render_report', trigger: 'started', guard_field: 'intake.started' },
      { from: 'render_report', to: 'complete', trigger: 'rendered', guard_field: 'render_report.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'render_report.ready' }),
  };
}

function loadGeneratedPdfReportStage(body: string): (input: Record<string, unknown>, runtime: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const transpiled = transpileModule(body, {
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
    TextEncoder,
    Uint8Array,
    require: (id: string) => {
      if (id === '../connectors/pdf-report.js') {
        return { MockPdfReportConnector };
      }
      throw new Error(`unexpected generated PDF report import ${id}`);
    },
  });
  new Script(transpiled.outputText, { filename: 'pdf-report-stage.behavior.cjs' }).runInContext(context, {
    timeout: 1_000,
  });
  const runStage = moduleObject.exports.runStage ?? exportsObject.runStage;
  if (typeof runStage !== 'function') {
    throw new Error('runStage export was not callable');
  }
  return runStage as (input: Record<string, unknown>, runtime: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface PdfReportDriveEvidence {
  finalMode: string | null;
  finalStatus: string | undefined;
  output: Record<string, unknown>;
  artifacts: unknown;
  renderHandlerSawArgTitle: boolean;
}

async function runPdfReportDrive(nonce: string): Promise<PdfReportDriveEvidence> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-pdf-report-harvest-'));
  const state = { sawArgTitle: false };
  const specPath = join(tempDir, `${PDF_PROGRAM}-${randomUUID()}.yml`);
  writeFileSync(specPath, pdfReportSpecYaml(), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  const entry: ProgramEntry = {
    spec,
    artifactPolicy: {
      rules: [
        {
          artifactType: 'pdf_report',
          title: 'PDF Report',
          summary: 'Structured lead report rendered by host PdfReportHostConnector.',
          payloadRef: OUTPUT_PATH,
          whenAllPaths: [`${OUTPUT_PATH}.pdf_base64`],
        },
      ],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, createPdfReportHandlers(state)),
  };
  const { client, close } = await startRouteHarness({
    programs: [{ name: PDF_PROGRAM, entry }],
    authorHandle: scriptedAuthor([
      scripted('seed', effect('seed_config', { title: nonce, purpose: 'find AI engineers' })),
      scripted('render', effect('render_report', {})),
    ]),
    observerModelId: 'pdf-report-falsifier-observer',
    storage: { uploadsDir: join(tempDir, 'uploads') },
  });
  try {
    const created = await client.sessions.create({ program: PDF_PROGRAM });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'seed report state' });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'render report' });
    const finalSession = await client.sessions.get(created.sessionId);
    const world = await client.sessions.world(created.sessionId);
    const domain = isRecord(world) && isRecord(world.domain) ? world.domain : {};
    let artifacts: unknown;
    try {
      artifacts = await client.sessions.systemArtifacts({ program: PDF_PROGRAM, artifactType: 'pdf_report' });
    } catch (error) {
      artifacts = { error: errorMessage(error) };
    }
    return {
      finalMode: modeOf(finalSession),
      finalStatus: isRecord(finalSession) && typeof finalSession.status === 'string' ? finalSession.status : undefined,
      output: resultAt(domain, OUTPUT_PATH),
      artifacts,
      renderHandlerSawArgTitle: state.sawArgTitle,
    };
  } finally {
    await close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createPdfReportHandlers(state: { sawArgTitle: boolean }): Record<string, ToolHandler> {
  return {
    async seed_config(payload) {
      const args = asRecord(payload);
      return {
        title: typeof args.title === 'string' ? args.title : '',
        purpose: typeof args.purpose === 'string' ? args.purpose : '',
      };
    },
    async render_report(payload) {
      const args = asRecord(payload);
      if (typeof args.title === 'string' && args.title.length > 0) {
        state.sawArgTitle = true;
      }
      const domain = isRecord(args.domain) ? args.domain : {};
      const report = {
        title: stringPath(domain, 'config.title'),
        purpose: stringPath(domain, 'config.purpose'),
        executive_summary: '',
        per_source: [{ source: 'https://example.com', found: 2, pages_visited: 2 }],
        leads: [{ email: 'a@x.com', status: 'new' }],
        guard_audit_summary: [{ action: 'refuse', url: 'https://evil.test', reason: 'off-allowlist' }],
      };
      const bytes = await new MockPdfReportConnector().render_report(report);
      const base64 = Buffer.from(bytes).toString('base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return {
        status: 'rendered',
        result_json: JSON.stringify({ pdf_base64: base64, pdf_bytes: bytes.length, sha256, section_count: 4 }),
        pdf_base64: base64,
        pdf_bytes: bytes.length,
        sha256,
        section_count: 4,
      };
    },
  };
}

function pdfReportSpecYaml(): string {
  return `name: "${PDF_PROGRAM}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level PDF report artifact harvest falsifier.

initial: bootstrap
terminal: [complete]

features:
  - base

channels:
  user_text: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  bootstrap:
    vocabulary: [seed_config]
    channels: [user_text, widget_output]
    transitions:
      - target: render_report
        guard: { kind: FieldTruthy, path: config.title }
  render_report:
    vocabulary: [render_report]
    channels: [user_text, widget_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: ${OUTPUT_PATH}.status }
  complete:
    vocabulary: []
    channels: [widget_output]

proceed_to:
  seed_config: render_report
  render_report: complete

projection:
  bootstrap:
    include: [inputs.user_text]
    exclude: []
  render_report:
    include:
      - config
      - config.title
      - config.purpose
    exclude: []
  complete:
    include:
      - config
      - ${OUTPUT_PATH}
      - ${OUTPUT_PATH}.status
      - ${OUTPUT_PATH}.pdf_base64
      - ${OUTPUT_PATH}.pdf_bytes
      - ${OUTPUT_PATH}.sha256
      - ${OUTPUT_PATH}.section_count
    exclude: []

prompts:
  bootstrap: "Call seed_config with the report configuration."
  render_report: "Call render_report with no arguments."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text

action_map:
  seed_config:
    description: "Seed report configuration into domain state."
    mutations: []
    channel: widget_output
    result_path: config
  render_report:
    description: "Render the accumulated report state into PDF report bytes."
    mutations: []
    channel: widget_output
    result_path: ${OUTPUT_PATH}

schema:
  inputs.user_text: string
  config: object
  config.title: string
  config.purpose: string
  ${OUTPUT_PATH}: object
  ${OUTPUT_PATH}.status: string
  ${OUTPUT_PATH}.result_json: string
  ${OUTPUT_PATH}.pdf_base64: string
  ${OUTPUT_PATH}.pdf_bytes: number
  ${OUTPUT_PATH}.sha256: string
  ${OUTPUT_PATH}.section_count: number

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

interface ScriptedResponse {
  response: Record<string, unknown>;
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output'): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(_label: string, response: Record<string, unknown>): ScriptedResponse {
  return { response };
}

function scriptedAuthor(responses: ScriptedResponse[]): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'pdf-report-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no PDF report falsifier author response scripted for call ${String(index - 1)}`);
      }
      return JSON.stringify(response.response);
    },
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  const result: Record<string, unknown> = isRecord(direct) ? { ...direct } : {};
  const prefix = `${pathKey}.`;
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function stringPath(domain: Record<string, unknown>, pathKey: string): string {
  const direct = domain[pathKey];
  if (typeof direct === 'string') {
    return direct;
  }
  let cursor: unknown = domain;
  for (const part of pathKey.split('.')) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, part)) {
      return '';
    }
    cursor = cursor[part];
  }
  return typeof cursor === 'string' ? cursor : '';
}

function extractArtifactRecords(raw: unknown): Array<Record<string, unknown>> {
  const container = isRecord(raw) && Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw) ? raw : [];
  return container.filter(isRecord);
}

function modeOf(envelope: unknown): string | null {
  if (!isRecord(envelope)) {
    return null;
  }
  if (typeof envelope.mode === 'string') {
    return envelope.mode;
  }
  if (isRecord(envelope.state) && typeof envelope.state.mode === 'string') {
    return envelope.state.mode;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
