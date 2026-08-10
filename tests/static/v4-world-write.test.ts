import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

interface SynthesizedSpec {
  channels: Record<string, { direction: string; sync: string }>;
  ingestion: Record<string, string[]>;
}

const rawWritePatterns = [
  { name: 'patchDomain', pattern: /\bpatchDomain\b/u },
  {
    name: 'top-level create-body domain_context',
    pattern: /\b(?:sessions\.)?create\s*\(\s*\{[\s\S]{0,1200}(?:['"]domain_context['"]|domain_context)\s*:/u,
  },
  {
    name: 'PATCH to /domain',
    pattern: /(?:method\s*:\s*['"]PATCH['"][\s\S]{0,400}\/domain|\/domain[\s\S]{0,400}method\s*:\s*['"]PATCH['"])/u,
  },
] as const;

describe('v4 world-write static guard', () => {
  it('does not reintroduce raw domain-write surfaces under src or templates', () => {
    const violations = sourceFiles(['src', 'templates'])
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        return rawWritePatterns
          .filter(({ pattern }) => pattern.test(source))
          .map(({ name }) => `${relative(process.cwd(), file)}: ${name}`);
      });

    expect(violations).toEqual([]);
  });

  it('emits seed ingestion and rendered initial_trigger seeding', () => {
    const artifact = synthesizeProgramSpecFromDomain({
      'program.slug': 'v4-seed-static',
      'program.name': 'V4 Seed Static',
      'program.target_dir': '/tmp/v4-seed-static',
      'program.design_path': 'design',
      'intake.purpose': 'Verify v4 startup seeding without raw domain writes.',
      'intake.entry_channel': 'user_text',
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'triage' },
        { slug: 'done', is_terminal: true },
      ]),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
        { from: 'triage', to: 'done', trigger: 'done', guard_field: 'triage.ready' },
      ]),
      'intake.delegation_json': JSON.stringify({ enabled: false }),
      'intake.completion_json': JSON.stringify({ final_stage: 'done', guard_field: 'triage.ready' }),
    });
    const parsed = load(artifact.spec_yaml) as SynthesizedSpec;

    expect(parsed.channels.seed).toEqual({ direction: 'In', sync: 'Async' });
    expect(parsed.ingestion.seed).toEqual(['inputs.domain_context', 'inputs.domain_context.query']);

    const outDir = mkdtempSync(join(tmpdir(), 'pgas-v4-seed-static-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'v4-seed-static',
        name: 'V4 Seed Static',
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });

      const apiBlackbox = readFileSync(join(outDir, 'tests/api-blackbox.test.ts'), 'utf8');
      const repl = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');
      for (const rendered of [apiBlackbox, repl]) {
        expect(rendered).toContain('initial_trigger');
        expect(rendered).toContain("channel: 'seed'");
        expect(rendered).toContain("'inputs.domain_context.query'");
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

function sourceFiles(roots: readonly string[]): string[] {
  return roots.flatMap((root) => collectSourceFiles(join(process.cwd(), root)));
}

function collectSourceFiles(path: string): string[] {
  const stats = statSync(path);
  if (stats.isFile()) {
    return shouldScan(path) ? [path] : [];
  }
  return readdirSync(path)
    .flatMap((entry) => collectSourceFiles(join(path, entry)));
}

function shouldScan(path: string): boolean {
  if (!/\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|tmpl|sh)$/u.test(path)) {
    return false;
  }
  const normalized = path.split('\\').join('/');
  return !normalized.includes('/tests/') && !normalized.includes('/sota/fixtures/');
}
