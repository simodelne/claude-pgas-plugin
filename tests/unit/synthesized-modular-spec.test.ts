import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadProgramByConvention } from '@simodelne/pgas-server/plugin.js';
import {
  synthesizeProgramSpecFromDomain,
  type SynthesizedSpec,
} from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

interface SynthesizedSpecFile {
  path: string;
  content: string;
}

const domain = {
  'program.slug': 'invoice-review',
  'program.name': 'Invoice Review',
  'program.target_dir': '/tmp/invoice-review',
  'program.design_path': 'design',
  'intake.purpose': 'Review invoices and mark a final approval status.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'review_invoice' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'review_invoice', trigger: 'started', guard_field: 'intake.started' },
    { from: 'review_invoice', to: 'complete', trigger: 'done', guard_field: 'review_invoice.done' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'review_invoice.done' }),
};

describe('synthesized modular spec emission', () => {
  it('emits a manifest specs.yml plus canonical non-empty block files', () => {
    const artifact = synthesizeProgramSpecFromDomain(domain);
    const files = filesByPath(artifact.spec_files);

    expect([...files.keys()]).toEqual([
      'specs.yml',
      'identity.yml',
      'domain.yml',
      'lifecycle.yml',
      'channels.yml',
      'actions.yml',
      'guidance.yml',
      'validation.yml',
      'view.yml',
      'policy.yml',
    ]);

    expect(load(files.get('specs.yml') ?? '')).toEqual({
      import: {
        identity: 'identity.yml',
        domain: 'domain.yml',
        lifecycle: 'lifecycle.yml',
        channels: 'channels.yml',
        actions: 'actions.yml',
        guidance: 'guidance.yml',
        validation: 'validation.yml',
        view: 'view.yml',
        policy: 'policy.yml',
      },
    });

    expect(load(files.get('identity.yml') ?? '')).toMatchObject({
      name: 'invoice-review',
      pure: true,
    });
    expect(load(files.get('guidance.yml') ?? '')).toMatchObject({
      preamble: expect.stringContaining('Program: Invoice Review.'),
      prompts: expect.any(Object),
      guidance: expect.any(Object),
    });
    expect(load(files.get('lifecycle.yml') ?? '')).toMatchObject({
      initial: 'intake',
      terminal: ['complete'],
      termination: 'BoundedSession',
      topology: 'CyclicTopology',
      proceeds_to: expect.any(Object),
    });
    expect(load(files.get('actions.yml') ?? '')).not.toHaveProperty('proceeds_to');
  });

  it('renders modular spec files and preserves the compiled Specification exactly', () => {
    const artifact = synthesizeProgramSpecFromDomain(domain);
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-modular-spec-render-'));
    const monolithicRoot = mkdtempSync(join(tmpdir(), 'pgas-new-monolithic-spec-'));
    try {
      const result = renderStandaloneScaffold({
        outDir,
        slug: 'invoice-review',
        name: 'Invoice Review',
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedSpecFiles: artifact.spec_files,
        synthesizedRegistrationTs: artifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });

      expect(result.written).toEqual(expect.arrayContaining([
        'src/programs/invoice-review/specs.yml',
        'src/programs/invoice-review/identity.yml',
        'src/programs/invoice-review/domain.yml',
        'src/programs/invoice-review/lifecycle.yml',
        'src/programs/invoice-review/channels.yml',
        'src/programs/invoice-review/actions.yml',
        'src/programs/invoice-review/guidance.yml',
        'src/programs/invoice-review/validation.yml',
        'src/programs/invoice-review/view.yml',
        'src/programs/invoice-review/policy.yml',
      ]));

      const renderedManifest = readFileSync(join(outDir, 'src/programs/invoice-review/specs.yml'), 'utf8');
      expect(Object.keys(load(renderedManifest) as Record<string, unknown>)).toEqual(['import']);

      writeMonolithicProgram(monolithicRoot, 'invoice-review', artifact.spec_yaml);
      const modular = loadProgramByConvention('invoice-review', {
        programsRoot: join(outDir, 'src'),
        validationOptions: { blueprint: 'off' },
      });
      const monolithic = loadProgramByConvention('invoice-review', {
        programsRoot: monolithicRoot,
        validationOptions: { blueprint: 'off' },
      });

      expect(JSON.stringify(modular.spec)).toBe(JSON.stringify(monolithic.spec));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(monolithicRoot, { recursive: true, force: true });
    }
  });

  it('captions every emitted spec file with a human-readable banner, stays loader-safe under default blueprint validation, and preserves the compiled Specification', () => {
    const artifact = synthesizeProgramSpecFromDomain(domain);

    // (1) Every emitted *.yml (including the manifest) carries at least one
    // comment line, and no file is comment-only (that would parse to null and
    // be rejected by the 5.6.0 import resolver).
    const files = artifact.spec_files as SynthesizedSpecFile[];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.path.endsWith('.yml'), `${file.path} is not a .yml`).toBe(true);
      expect(/^\s*#/m.test(file.content), `${file.path} missing a comment line`).toBe(true);
      // The banner sits ABOVE real content: the fragment still parses to a mapping.
      expect(load(file.content), `${file.path} parsed to non-mapping`).toBeInstanceOf(Object);
    }
    // Provenance is the pinned checked engine version, never invented text.
    expect(files.find((file) => file.path === 'specs.yml')?.content)
      .toContain('Generated by pgas-new · @simodelne/pgas-server 6.0.0 · edit the design, not this file.');

    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-modular-banner-'));
    const monolithicRoot = mkdtempSync(join(tmpdir(), 'pgas-new-monolithic-banner-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'invoice-review',
        name: 'Invoice Review',
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedSpecFiles: artifact.spec_files,
        synthesizedRegistrationTs: artifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });

      // (2) Loads/validates under DEFAULT blueprint validation on 5.6.0 (the
      // generated spec-load.test.ts posture: no validationOptions override).
      // import: fragments are forced strict by the loader, so a comment-only or
      // misplaced fragment would throw here.
      const modular = loadProgramByConvention('invoice-review', {
        programsRoot: join(outDir, 'src'),
      });
      expect(modular.spec.name).toBe('invoice-review');

      // (3) Comments compile to nothing: the assembled Specification is byte-for-byte
      // identical to the monolithic single-file spec.
      writeMonolithicProgram(monolithicRoot, 'invoice-review', artifact.spec_yaml);
      const monolithic = loadProgramByConvention('invoice-review', {
        programsRoot: monolithicRoot,
        validationOptions: { blueprint: 'off' },
      });
      expect(JSON.stringify(modular.spec)).toBe(JSON.stringify(monolithic.spec));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(monolithicRoot, { recursive: true, force: true });
    }
  });

  // pgas#946 will flip `validationOptions.blueprint` to STRICT by default in v6.
  // The MODULAR emission is strict-clean today purely because `modularSpecFilesFor`
  // walks BLUEPRINT_SPEC_BLOCKS in canonical order — nothing was pinning it, so a
  // new top-level key (e.g. a `render:` deliverable profile) emitted into the wrong
  // block, or a block emitted out of order, would silently regress it.
  //
  // (The MONOLITHIC `spec_yaml` now goes through the SAME partition via
  // `canonicalBlueprintRootOrder`; it is pinned in
  // tests/unit/synthesized-monolithic-spec.test.ts.)
  //
  // A strict LOAD is NOT sufficient here: the loader's `parseImportBlock` re-walks
  // the engine's own SPEC_BLOCKS list, so a misordered `import:` map still loads.
  // The explicit import-order assertions below are the only guard on this order.
  it('loads the modular emission under blueprint: strict — including the render: deliverable slot', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-modular-strict-load-'));
    const renderOutDir = mkdtempSync(join(tmpdir(), 'pgas-new-modular-strict-render-'));
    try {
      // (1) baseline program (no render: block).
      renderScaffoldFor(outDir, 'invoice-review', 'Invoice Review', synthesizeProgramSpecFromDomain(domain));
      const baseline = loadProgramByConvention('invoice-review', {
        programsRoot: join(outDir, 'src'),
        validationOptions: { blueprint: 'strict' },
      });
      expect(baseline.spec.name).toBe('invoice-review');

      // (2) a program that DOES emit a `render:` deliverable profile. Its block file
      //     must exist and sit in the canonical slot: after `view`, before `policy`.
      const renderArtifact = synthesizeProgramSpecFromDomain(pdfReportDomain());
      const renderFiles = filesByPath(renderArtifact.spec_files);
      expect(renderFiles.has('render.yml'), 'a render: profile is emitted as its own block file').toBe(true);
      expect(load(renderFiles.get('render.yml') ?? '')).toMatchObject({ render: expect.any(Object) });

      renderScaffoldFor(renderOutDir, 'pdf-report-demo', 'PDF Report Demo', renderArtifact);
      const withRender = loadProgramByConvention('pdf-report-demo', {
        programsRoot: join(renderOutDir, 'src'),
        validationOptions: { blueprint: 'strict' },
      });
      expect(withRender.spec.name).toBe('pdf-report-demo');
      expect(withRender.entry.renderProfile, 'the render: sidecar reaches the ProgramEntry').toBeTruthy();

      const importOrder = Object.keys(
        (load(renderFiles.get('specs.yml') ?? '') as { import: Record<string, string> }).import,
      );
      expect(importOrder.indexOf('render')).toBeGreaterThan(importOrder.indexOf('view'));
      expect(importOrder.indexOf('render')).toBeLessThan(importOrder.indexOf('policy'));
      // Literal pin of the WHOLE emitted import order, not just the render slot:
      // the strict load above tolerates any permutation of this map, so without
      // this assertion a reordered BLUEPRINT_SPEC_BLOCKS would go undetected here.
      expect(importOrder).toEqual([
        'identity',
        'domain',
        'lifecycle',
        'channels',
        'actions',
        'guidance',
        'validation',
        'view',
        'render',
        'policy',
      ]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(renderOutDir, { recursive: true, force: true });
    }
  });

  it('keeps import-based specs blueprint strict by rejecting misplaced fragment keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'pgas-new-modular-strict-'));
    try {
      const programDir = join(root, 'programs', 'misplaced');
      mkdirSync(programDir, { recursive: true });
      writeFileSync(join(programDir, 'specs.yml'), 'import:\n  identity: identity.yml\n');
      writeFileSync(join(programDir, 'identity.yml'), 'name: misplaced\nschema:\n  inputs.user_text: string\n');

      expect(() => loadProgramByConvention('misplaced', {
        programsRoot: root,
        validationOptions: { blueprint: 'off' },
      })).toThrow(/misfiles key\(s\)/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function filesByPath(files: SynthesizedSpec['spec_files']): Map<string, string> {
  return new Map((files as SynthesizedSpecFile[]).map((file) => [file.path, file.content]));
}

function writeMonolithicProgram(root: string, slug: string, specYaml: string): void {
  const programDir = join(root, 'programs', slug);
  mkdirSync(programDir, { recursive: true });
  writeFileSync(join(programDir, 'specs.yml'), specYaml);
}

function renderScaffoldFor(outDir: string, slug: string, name: string, artifact: SynthesizedSpec): void {
  renderStandaloneScaffold({
    outDir,
    slug,
    name,
    synthesizedSpecYaml: artifact.spec_yaml,
    synthesizedSpecFiles: artifact.spec_files,
    synthesizedRegistrationTs: artifact.registration_ts,
    synthesizedContractsTs: artifact.contracts_ts,
    synthesizedHandlersTs: artifact.handlers_ts,
    synthesizedHandlersIndexTs: artifact.handlers_index_ts,
    synthesizedToolsTs: artifact.tools_ts,
    synthesizedSmokeTestTs: artifact.smoke_test_ts,
  });
}

/** A domain whose `export_pdf` stage makes the synthesizer emit a `render:` profile. */
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
