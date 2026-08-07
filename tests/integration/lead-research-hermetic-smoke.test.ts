import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';

import { assertSynthesizableCapabilities } from '../../src/foundry-program/capability-registry.js';
import { startRouteHarness } from './foundry-test-utils.js';

const DOMAIN_PATH = new URL('../../.dd-report-exp/lead-research/lead-research-agent-domain.json', import.meta.url);
const TEMP_RENDER_PARENT = new URL('../../.dd-report-exp/lead-research/', import.meta.url);
const RESYNTHESIS_MODULE = new URL(
  '../../.dd-report-exp/lead-research/resynthesize-lead-research.js',
  import.meta.url,
);
const VITEST_BIN = new URL('../../node_modules/vitest/vitest.mjs', import.meta.url);

interface ParsedSpec {
  action_map: Record<string, { mutations?: Array<{ op: string; path: string; value?: unknown; from_arg?: string }> }>;
  features?: string[];
  keyed_collections?: Array<{ collection: string; key: string }>;
  projection: Record<string, { include?: string[] }>;
  prompts: Record<string, string>;
  schema: Record<string, string>;
}

describe('lead-research-agent hermetic smoke', () => {
  it('assesses as three host-backed scaffolds with zero refuses', () => {
    const domain = loadLeadResearchDomain();
    const assessment = assertSynthesizableCapabilities({
      purpose: stringField(domain, 'intake.purpose'),
      stages: stagesFromDomain(domain),
      delegation: parseOptionalObject(domain, 'intake.delegation_json'),
      completion: parseOptionalObject(domain, 'intake.completion_json'),
      extraText: JSON.stringify(domain),
    });

    expect(assessment.refuses).toHaveLength(0);
    expect(assessment.unknown).toHaveLength(0);
    expect(assessment.synthesizes.map((demand) => demand.capability)).toContain('config_driven_extraction_schema');
    expect(assessment.scaffolds_with_gap.map((demand) => demand.capability)).toEqual(expect.arrayContaining([
      'web_navigation_guarded',
      'cross_session_persistence',
      'export_pdf_report',
    ]));
  });

  it('renders the scaffold through the resynthesis path to a typecheckable temp dir', { timeout: 120_000 }, async () => {
    const tempDir = mkdtempSync(join(fileURLToPath(TEMP_RENDER_PARENT), 'tmp-render-'));
    try {
      const { renderLeadResearchScaffold } = await import(RESYNTHESIS_MODULE.href) as {
        renderLeadResearchScaffold(options: { targetRoot: string; runTypecheck: boolean }): Promise<{
          target_root: string;
          rendered_files: string[];
          typecheck_output: string;
        }>;
      };

      const summary = await renderLeadResearchScaffold({ targetRoot: tempDir, runTypecheck: true });
      expect(summary.target_root).toBe(tempDir);
      expect(summary.rendered_files).toContain('src/programs/lead-research-agent/specs.yml');
      expect(existsSync(join(tempDir, 'src/programs/lead-research-agent/connectors/web-navigation.ts'))).toBe(true);
      expect(existsSync(join(tempDir, 'src/programs/lead-research-agent/connectors/persistence.ts'))).toBe(true);
      expect(existsSync(join(tempDir, 'src/programs/lead-research-agent/connectors/pdf-report.ts'))).toBe(true);
      expect(existsSync(join(tempDir, 'src/programs/lead-research-agent/report-data.ts'))).toBe(true);
      const parentSpec = load(readFileSync(join(tempDir, 'src/programs/lead-research-agent/specs.yml'), 'utf8')) as ParsedSpec;
      expect(parentSpec.features).toContain('keyed_collection');
      expect(parentSpec.keyed_collections).toEqual([
        { collection: 'extract_leads.result.leads', key: 'email' },
      ]);
      const persistStage = readFileSync(join(tempDir, 'src/programs/lead-research-agent/stages/persist.ts'), 'utf8');
      expect(persistStage).toContain('upsert_lead');
      expect(persistStage).not.toMatch(/\bnew Set\b|connector\.dedupe|\.filter\s*\(|existingIds|newVsExisting\.map|safeRecordId|recordId/u);
      expect(summary.typecheck_output).not.toContain('error TS');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('re-renders record_array lead extraction as a typed array tool argument', { timeout: 120_000 }, async () => {
    const tempDir = mkdtempSync(join(fileURLToPath(TEMP_RENDER_PARENT), 'tmp-f1-record-array-'));
    try {
      const { renderLeadResearchScaffold } = await import(RESYNTHESIS_MODULE.href) as {
        renderLeadResearchScaffold(options: { targetRoot: string; runTypecheck: boolean }): Promise<{
          target_root: string;
          rendered_files: string[];
        }>;
      };
      await renderLeadResearchScaffold({ targetRoot: tempDir, runTypecheck: false });

      const contracts = readFileSync(join(
        tempDir,
        'src/programs/lead-research-agent/contracts.ts',
      ), 'utf8');
      const parentSpec = load(readFileSync(join(
        tempDir,
        'src/programs/lead-research-agent/specs.yml',
      ), 'utf8')) as ParsedSpec;

      expect(contracts).toContain('"name": "leads"');
      expect(contracts).toContain('"type": "record_array"');
      expect(contracts).toContain('"record_fields"');
      expect(contracts).toContain('"relevance_score": "number"');
      expect(parentSpec.prompts.extract_leads).toContain('Populate every declared result field directly');
      expect(parentSpec.prompts.extract_leads).not.toContain('result_json must be a JSON object containing at least');
      expect(parentSpec.schema).toMatchObject({
        'extract_leads.result.leads': 'array',
        'extract_leads.result.leads.*': 'object',
        'extract_leads.result.leads.*.name': 'string',
        'extract_leads.result.leads.*.email': 'string',
        'extract_leads.result.leads.*.relevance_score': 'number',
      });
      const extractMutations = parentSpec.action_map.complete_extract_leads?.mutations ?? [];
      expect(extractMutations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          op: 'MAppend',
          path: 'extract_leads.result.leads',
          value: {},
          from_arg: 'leads',
        }),
      ]));
      expect(extractMutations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ from_arg: 'result_json' }),
      ]));
      expect(extractMutations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ from_arg: 'items_json' }),
      ]));
      expect(parentSpec.projection.aggregate?.include).toEqual(expect.arrayContaining([
        'extract_leads.result.leads',
        'extract_leads.result.leads.*.email',
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not re-render seeded_topic invariants for source-navigation delegation without topic enrichment', { timeout: 120_000 }, async () => {
    const tempDir = mkdtempSync(join(fileURLToPath(TEMP_RENDER_PARENT), 'tmp-f2-render-'));
    try {
      const { renderLeadResearchScaffold } = await import(RESYNTHESIS_MODULE.href) as {
        renderLeadResearchScaffold(options: { targetRoot: string; runTypecheck: boolean }): Promise<{
          target_root: string;
          rendered_files: string[];
        }>;
      };
      await renderLeadResearchScaffold({ targetRoot: tempDir, runTypecheck: false });

      const childSpec = readFileSync(join(
        tempDir,
        'src/programs/lead-research-source-navigation/specs.yml',
      ), 'utf8');
      const smokeTest = readFileSync(join(tempDir, 'tests/generated-program-smoke.test.ts'), 'utf8');

      expect(childSpec).not.toContain('seeded_topic');
      expect(childSpec).not.toContain('Echo inputs.request.topic');
      expect(smokeTest).not.toContain("expect(result.seeded_topic).toBe('seeded delegation topic')");
      expect(smokeTest).not.toContain("seeded_topic: 'seeded delegation topic'");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('re-renders a generated deterministic test that drives delegation and decision_only to complete', { timeout: 180_000 }, async () => {
    const tempDir = mkdtempSync(join(fileURLToPath(TEMP_RENDER_PARENT), 'tmp-f3-det-'));
    try {
      const { renderLeadResearchScaffold } = await import(RESYNTHESIS_MODULE.href) as {
        renderLeadResearchScaffold(options: { targetRoot: string; runTypecheck: boolean }): Promise<{
          target_root: string;
          rendered_files: string[];
        }>;
      };
      await renderLeadResearchScaffold({ targetRoot: tempDir, runTypecheck: false });

      const output = execFileSync(process.execPath, [
        fileURLToPath(VITEST_BIN),
        'run',
        '--pool=threads',
        '--maxWorkers=1',
        'tests/program-deterministic.test.ts',
      ], {
        cwd: tempDir,
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      });

      expect(output).toContain('1 passed');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('drives the rendered scaffold to complete against generated mock connectors', { timeout: 180_000 }, async () => {
    const tempDir = mkdtempSync(join(fileURLToPath(TEMP_RENDER_PARENT), 'tmp-drive-'));
    const domain = loadLeadResearchDomain();
    const config = leadResearchConfig(domain);
    try {
      const { renderLeadResearchScaffold } = await import(RESYNTHESIS_MODULE.href) as {
        renderLeadResearchScaffold(options: { targetRoot: string; runTypecheck: boolean }): Promise<{
          target_root: string;
          rendered_files: string[];
          typecheck_output: string;
        }>;
      };
      await renderLeadResearchScaffold({ targetRoot: tempDir, runTypecheck: false });

      const parentModule = await import(pathToFileURL(join(
        tempDir,
        'src/programs/lead-research-agent/registration.ts',
      )).href) as {
        createLeadResearchAgentProgramEntry(): ProgramEntry;
      };
      const childModule = await import(pathToFileURL(join(
        tempDir,
        'src/programs/lead-research-source-navigation/registration.ts',
      )).href) as {
        createLeadResearchSourceNavigationProgramEntry(): ProgramEntry;
      };
      const webNavigationModule = await import(pathToFileURL(join(
        tempDir,
        'src/programs/lead-research-agent/connectors/web-navigation.ts',
      )).href) as {
        MockWebNavigationConnector: new () => WebNavigationLike;
      };

      const { client, close } = await startRouteHarness({
        programs: [
          { name: 'lead-research-agent', entry: parentModule.createLeadResearchAgentProgramEntry() },
          { name: 'lead-research-source-navigation', entry: childModule.createLeadResearchSourceNavigationProgramEntry() },
        ],
        authorHandle: createLeadResearchDriveAuthor({
          config,
          WebNavigationConnector: webNavigationModule.MockWebNavigationConnector,
        }),
        observerModelId: 'lead-research-hermetic-observer',
      });
      try {
        const created = await client.sessions.create({ program: 'lead-research-agent' });
        let finalSession: unknown = created;
        for (let attempt = 0; attempt < 24; attempt += 1) {
          try {
            await client.sessions.trigger(created.sessionId, {
              channel: 'user_text',
              payload: `drive lead research hermetic smoke ${String(attempt + 1)}`,
            });
          } catch (error) {
            if (!errorMessage(error).includes('terminal')) {
              throw error;
            }
          }
          finalSession = await client.sessions.get(created.sessionId);
          if (modeOf(finalSession) === 'complete' || statusOf(finalSession) === 'complete') {
            break;
          }
        }

        const world = await client.sessions.world(created.sessionId);
        const domainState = isRecord(world) && isRecord(world.domain) ? world.domain : {};
        const artifacts = await client.sessions.systemArtifacts({
          program: 'lead-research-agent',
          artifactType: 'pdf_report',
        });
        const perSource = arrayAt(domainState, 'work.aggregate.per_source');
        const newVsExisting = arrayAt(domainState, 'work.persist.new_vs_existing');
        const persistedEmails = newVsExisting
          .map((entry) => isRecord(entry) ? entry.email : undefined)
          .filter((entry): entry is string => typeof entry === 'string');
        const audit = arrayAt(domainState, 'work.audit');
        const pdfOutput = resultAt(domainState, 'render_report.output');
        const pdfBytes = Buffer.from(String(pdfOutput.pdf_base64 ?? ''), 'base64');
        const pdfText = pdfBytes.toString('utf8');
        const artifactRecord = extractArtifactRecords(artifacts).find((record) => record.artifactType === 'pdf_report');

        expect(statusOf(finalSession)).toBe('complete');
        expect(perSource).toHaveLength(config.sources.length);
        expect(newVsExisting.length).toBeGreaterThan(0);
        expect(persistedEmails).toEqual([...new Set(persistedEmails)]);
        expect(persistedEmails.length).toBeLessThan(leadFixtures(config).length);
        expect(artifactRecord, 'pdf_report SessionArtifactRecord present').toBeTruthy();
        expect(pdfText).toContain(config.title);
        expect(audit.length).toBeGreaterThan(0);
        expect(audit.some((entry) =>
          isRecord(entry) && ['fetch', 'follow', 'extract', 'skip', 'refuse'].includes(String(entry.action)))).toBe(true);
      } finally {
        await close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

interface LeadResearchConfig {
  title: string;
  purpose: string;
  sources: Array<{ url: string; allowed_domains?: string[] }>;
  extraction_schema: Record<string, string>;
  guard: {
    allowed_domains: string[];
    max_depth: number;
    max_pages: number;
    max_follow_links: number;
    min_delay_ms: number;
    max_concurrency: number;
  };
}

interface WebNavigationLike {
  navigate_and_extract(
    source: string,
    purpose: string,
    extractionSchema: Record<string, string>,
    guard: LeadResearchConfig['guard'],
  ): Promise<{ items: readonly Record<string, unknown>[]; pages_visited: number; audit: readonly Record<string, unknown>[] }>;
}

function createLeadResearchDriveAuthor(options: {
  config: LeadResearchConfig;
  WebNavigationConnector: new () => WebNavigationLike;
}): { modelId: string; complete(prompt: string): Promise<string> } {
  let parentStarted = false;
  let sourceRequests = 0;
  let childStarts = 0;
  let childCompletions = 0;
  let extractCompleted = false;
  let aggregateCompleted = false;
  let persistCompleted = false;
  const connector = new options.WebNavigationConnector();

  return {
    modelId: 'lead-research-hermetic-author',
    async complete(prompt: string): Promise<string> {
      if (prompt.includes('Lead Research Agent SourceNavigation Worker')) {
        if (prompt.includes('begin_work') && childStarts < sourceRequests) {
          childStarts += 1;
          return JSON.stringify(effect('begin_work', {}));
        }
        if (prompt.includes('complete_work')) {
          const source = options.config.sources[childCompletions];
          if (!source) {
            throw new Error(`no lead-research source fixture for child completion ${String(childCompletions)}`);
          }
          const result = await connector.navigate_and_extract(
            source.url,
            options.config.purpose,
            options.config.extraction_schema,
            options.config.guard,
          );
          childCompletions += 1;
          const resultJson = {
            source: source.url,
            status: 'complete',
            pages_visited: result.pages_visited,
            item_count: result.items.length,
            items: result.items,
            audit: result.audit,
          };
          return JSON.stringify(effect('complete_work', {
            result_json: JSON.stringify(resultJson),
            items_json: JSON.stringify(result.items.map((item) => `source_navigation:summary:${String(item.email ?? source.url)}`)),
            source: source.url,
            status: 'complete',
            pages_visited: result.pages_visited,
            item_count: result.items.length,
            items: JSON.stringify(result.items),
            audit: JSON.stringify(result.audit),
          }, 'stage_output'));
        }
      }

      if (prompt.includes('begin_work') && !parentStarted) {
        parentStarted = true;
        return JSON.stringify(effect('begin_work', {}));
      }
      if (prompt.includes('request_source_navigation') && sourceRequests < options.config.sources.length) {
        const source = options.config.sources[sourceRequests];
        sourceRequests += 1;
        return JSON.stringify(effect('request_source_navigation', {
          request: {
            source: source?.url ?? '',
            allowed_domains: source?.allowed_domains ?? options.config.guard.allowed_domains,
          },
        }, 'source_navigation_call'));
      }
      if (prompt.includes('complete_extract_leads') && !extractCompleted) {
        extractCompleted = true;
        const leads = leadFixtures(options.config);
        return JSON.stringify(effectWithMutations(
          'complete_extract_leads',
          [
            { kind: 'MutationAction', name: 'complete_extract_leads', op: 'MSet', path: 'extract_leads.done', value: true },
            ...leads.map((lead) => ({
              kind: 'MutationAction',
              name: 'complete_extract_leads',
              op: 'MAppend',
              path: 'extract_leads.result.leads',
              value: lead,
            })),
            {
              kind: 'MutationAction',
              name: 'complete_extract_leads',
              op: 'MSet',
              path: 'extract_leads.raw_result_fields.lead_count',
              value: leads.length,
            },
            {
              kind: 'MutationAction',
              name: 'complete_extract_leads',
              op: 'MSet',
              path: 'extract_leads.raw_result_fields.extraction_notes',
              value: 'Hermetic extraction from mock navigation items.',
            },
          ],
          {
          result_json: JSON.stringify({
            leads,
            lead_count: leads.length,
            extraction_notes: 'Hermetic extraction from mock navigation items.',
          }),
          items_json: JSON.stringify(leads.map((lead) => `lead:${String(lead.email)}`)),
          leads,
          lead_count: leads.length,
          extraction_notes: 'Hermetic extraction from mock navigation items.',
        }, 'stage_output'));
      }
      if (prompt.includes('complete_aggregate') && !aggregateCompleted) {
        aggregateCompleted = true;
        return JSON.stringify(effect('complete_aggregate', {}, 'stage_output'));
      }
      if (prompt.includes('complete_persist') && !persistCompleted) {
        persistCompleted = true;
        return JSON.stringify(effect('complete_persist', {}, 'stage_output'));
      }
      if (prompt.includes('complete_navigate_source') && sourceRequests >= options.config.sources.length) {
        return JSON.stringify(effect('complete_navigate_source', {}, 'stage_output'));
      }

      throw new Error(`lead-research hermetic author has no scripted response for prompt:\n${prompt.slice(0, 1200)}`);
    },
  };
}

function loadLeadResearchDomain(): Record<string, unknown> {
  return JSON.parse(readFileSync(DOMAIN_PATH, 'utf8')) as Record<string, unknown>;
}

function leadResearchConfig(domain: Record<string, unknown>): LeadResearchConfig {
  const config = requiredRecord(domain.config, 'config');
  return {
    title: requiredString(config.title, 'config.title'),
    purpose: requiredString(config.purpose, 'config.purpose'),
    sources: requiredSources(config.sources),
    extraction_schema: requiredRecordOfStrings(config.extraction_schema, 'config.extraction_schema'),
    guard: {
      allowed_domains: requiredStringArray(requiredRecord(domain.guard_config, 'guard_config').allowed_domains, 'guard_config.allowed_domains'),
      max_depth: requiredNumber(requiredRecord(domain.guard_config, 'guard_config').max_depth, 'guard_config.max_depth'),
      max_pages: requiredNumber(requiredRecord(domain.guard_config, 'guard_config').max_pages, 'guard_config.max_pages'),
      max_follow_links: requiredNumber(requiredRecord(domain.guard_config, 'guard_config').max_follow_links, 'guard_config.max_follow_links'),
      min_delay_ms: requiredNumber(requiredRecord(domain.guard_config, 'guard_config').min_delay_ms, 'guard_config.min_delay_ms'),
      max_concurrency: requiredNumber(requiredRecord(domain.guard_config, 'guard_config').max_concurrency, 'guard_config.max_concurrency'),
    },
  };
}

function stagesFromDomain(domain: Record<string, unknown>): object[] {
  const parsed = JSON.parse(stringField(domain, 'intake.stages_json')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('intake.stages_json must parse to an array');
  }
  return parsed.filter((stage): stage is object => Boolean(stage) && typeof stage === 'object' && !Array.isArray(stage));
}

function parseOptionalObject(domain: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const raw = domain[key];
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must parse to an object`);
  }
  return parsed as Record<string, unknown>;
}

function stringField(domain: Record<string, unknown>, key: string): string {
  const value = domain[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function requiredStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  return [...value];
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requiredRecordOfStrings(value: unknown, path: string): Record<string, string> {
  const record = requiredRecord(value, path);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`${path}.${key} must be a non-empty string`);
    }
    out[key] = item;
  }
  return out;
}

function requiredSources(value: unknown): LeadResearchConfig['sources'] {
  if (!Array.isArray(value)) {
    throw new Error('config.sources must be an array');
  }
  return value.map((item, index) => {
    const record = requiredRecord(item, `config.sources.${String(index)}`);
    return {
      url: requiredString(record.url, `config.sources.${String(index)}.url`),
      ...(Array.isArray(record.allowed_domains)
        ? { allowed_domains: requiredStringArray(record.allowed_domains, `config.sources.${String(index)}.allowed_domains`) }
        : {}),
    };
  });
}

function leadFixtures(config: LeadResearchConfig): Array<Record<string, unknown>> {
  return config.sources.map((source, index) => ({
    name: `Lead ${String(index + 1)}`,
    role: 'Engineering leader',
    company: 'Example Co',
    email: index === 1 ? 'lead1@example.com' : `lead${String(index + 1)}@example.com`,
    profile_url: source.url,
    notes: `Derived from ${source.url}`,
    relevance_score: 0.8,
  }));
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output'): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function effectWithMutations(
  name: string,
  mutations: Array<Record<string, unknown>>,
  payload: Record<string, unknown>,
  channel = 'widget_output',
): Record<string, unknown> {
  return { actions: [...mutations, { kind: 'EffectAction', name, channel, payload }] };
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

function statusOf(envelope: unknown): string | undefined {
  if (!isRecord(envelope) || typeof envelope.status !== 'string') {
    return undefined;
  }
  const status = envelope.status.toLowerCase();
  return status === 'completed' ? 'complete' : status;
}

function arrayAt(domain: Record<string, unknown>, path: string): unknown[] {
  const direct = valueAtPath(domain, path);
  if (Array.isArray(direct)) {
    return direct;
  }
  if (isRecord(direct)) {
    const numericKeys = Object.keys(direct).filter((key) => /^\d+$/u.test(key)).sort((left, right) => Number(left) - Number(right));
    if (numericKeys.length > 0) {
      return numericKeys.map((key) => direct[key]);
    }
  }
  const prefix = `${path}.`;
  const grouped = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(domain)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const [indexText, ...fieldParts] = key.slice(prefix.length).split('.');
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0) {
      continue;
    }
    if (fieldParts.length === 0) {
      grouped.set(index, isRecord(value) ? { ...value } : { value });
      continue;
    }
    const record = grouped.get(index) ?? {};
    record[fieldParts.join('.')] = value;
    grouped.set(index, record);
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
}

function resultAt(domain: Record<string, unknown>, path: string): Record<string, unknown> {
  const direct = valueAtPath(domain, path);
  const result = isRecord(direct) ? { ...direct } : {};
  const prefix = `${path}.`;
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function valueAtPath(domain: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(domain, path)) {
    return domain[path];
  }
  let cursor: unknown = domain;
  for (const part of path.split('.')) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function extractArtifactRecords(raw: unknown): Array<Record<string, unknown>> {
  const container = isRecord(raw) && Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw) ? raw : [];
  return container.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
