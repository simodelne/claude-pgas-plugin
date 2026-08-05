import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertSynthesizableCapabilities } from '../../src/foundry-program/capability-registry.js';

const DOMAIN_PATH = new URL('../../.dd-report-exp/lead-research/lead-research-agent-domain.json', import.meta.url);
const TEMP_RENDER_PARENT = new URL('../../.dd-report-exp/lead-research/', import.meta.url);
const RESYNTHESIS_MODULE = new URL(
  '../../.dd-report-exp/lead-research/resynthesize-lead-research.js',
  import.meta.url,
);

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
      expect(summary.typecheck_output).not.toContain('error TS');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function loadLeadResearchDomain(): Record<string, unknown> {
  return JSON.parse(readFileSync(DOMAIN_PATH, 'utf8')) as Record<string, unknown>;
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
