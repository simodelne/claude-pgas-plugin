import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

const LEAD_RESEARCH_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(LEAD_RESEARCH_ROOT, '../..');
const DOMAIN_PATH = join(LEAD_RESEARCH_ROOT, 'lead-research-agent-domain.json');
const DEFAULT_TARGET_ROOT = join(LEAD_RESEARCH_ROOT, 'generated');
const PROGRAM_SLUG = 'lead-research-agent';
const PROGRAM_NAME = 'Lead Research Agent';

export interface RenderLeadResearchOptions {
  targetRoot?: string;
  runTypecheck?: boolean;
  writeSummary?: boolean;
}

export interface LeadResearchResynthesisSummary {
  target_root: string;
  domain_path: string;
  rendered_files: string[];
  mode_names: string[];
  body_stage_slugs: string[];
  stage_classification: unknown[];
  capability_gaps: unknown[];
  export_surfaces: unknown;
  domain_synthesis_audit: Array<Record<string, unknown>>;
  typecheck_output: string;
}

export async function renderLeadResearchScaffold(
  options: RenderLeadResearchOptions = {},
): Promise<LeadResearchResynthesisSummary> {
  const targetRoot = resolve(options.targetRoot ?? DEFAULT_TARGET_ROOT);
  const domain = readDomain();
  const specOnly = synthesizeProgramSpecFromDomain(domain);
  const cacheDir = join(LEAD_RESEARCH_ROOT, '.domain-cache');
  rmSync(cacheDir, { recursive: true, force: true });
  const artifact = await synthesizeDomainLogic({
    ...specOnly,
    created_at: '2026-08-05T00:00:00.000Z',
  } as SynthesizedArtifact, {
    cacheDir,
    providerUrl: '',
    model: '',
    maxAttempts: 1,
  });
  rmSync(cacheDir, { recursive: true, force: true });

  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  const renderResult = renderStandaloneScaffold({
    slug: PROGRAM_SLUG,
    name: PROGRAM_NAME,
    outDir: targetRoot,
    mandate: stringField(domain, 'intake.purpose'),
    synthesizedCapabilityGaps: artifact.capability_gaps ?? [],
    synthesizedSpecYaml: artifact.spec_yaml,
    synthesizedRegistrationTs: artifact.registration_ts,
    synthesizedContractsTs: artifact.contracts_ts,
    synthesizedHandlersTs: artifact.handlers_ts,
    synthesizedHandlersIndexTs: artifact.handlers_index_ts,
    synthesizedStageSources: artifact.stage_sources,
    synthesizedToolsTs: artifact.tools_ts,
    synthesizedSmokeTestTs: artifact.smoke_test_ts,
    synthesizedChildArtifacts: artifact.child_artifacts,
    synthesizedExportSurfaces: artifact.export_surfaces,
    synthesizedDocumentExtractionSurfaces: artifact.document_extraction_surfaces,
  });

  const typecheckOutput = options.runTypecheck === true ? runGeneratedTypecheck(targetRoot) : '';
  const summary: LeadResearchResynthesisSummary = {
    target_root: targetRoot,
    domain_path: DOMAIN_PATH,
    rendered_files: renderResult.written,
    mode_names: artifact.mode_names,
    body_stage_slugs: artifact.body_stage_slugs,
    stage_classification: artifact.stage_classification,
    capability_gaps: artifact.capability_gaps ?? [],
    export_surfaces: artifact.export_surfaces ?? {},
    domain_synthesis_audit: artifact.domain_synthesis_audit ?? [],
    typecheck_output: typecheckOutput,
  };

  if (options.writeSummary === true || targetRoot === resolve(DEFAULT_TARGET_ROOT)) {
    writeJson(join(LEAD_RESEARCH_ROOT, 'resynthesis-summary.json'), summary);
  }
  return summary;
}

async function main(): Promise<void> {
  const summary = await renderLeadResearchScaffold({
    targetRoot: DEFAULT_TARGET_ROOT,
    runTypecheck: true,
    writeSummary: true,
  });
  process.stdout.write([
    `[lead-research] wrote domain ${DOMAIN_PATH}`,
    `[lead-research] rendered ${String(summary.rendered_files.length)} files to ${summary.target_root}`,
    '[lead-research] generated typecheck passed',
  ].join('\n') + '\n');
}

function readDomain(): Record<string, unknown> {
  return JSON.parse(readFileSync(DOMAIN_PATH, 'utf8')) as Record<string, unknown>;
}

function runGeneratedTypecheck(targetRoot: string): string {
  const tscBin = join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
  if (!existsSync(tscBin)) {
    throw new Error(`missing TypeScript compiler at ${tscBin}`);
  }
  try {
    return execFileSync(process.execPath, [tscBin, '--noEmit'], {
      cwd: targetRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`generated lead-research scaffold typecheck failed:\n${commandOutput(error)}`);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stringField(domain: Record<string, unknown>, key: string): string {
  const value = domain[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function commandOutput(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stdout = bufferOrString(record.stdout);
  const stderr = bufferOrString(record.stderr);
  const combined = [stdout, stderr].filter((value) => value.length > 0).join('\n');
  return combined.length > 0 ? combined : String(record.message ?? error);
}

function bufferOrString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').trim();
  }
  return '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
