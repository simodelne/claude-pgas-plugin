import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadProgramByConvention } from '@simodelne/pgas-server/plugin.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import {
  BLUEPRINT_SPEC_BLOCKS,
  blueprintBlockForRootKey,
} from '../../src/foundry-program/synthesizer/modular-spec.js';

/**
 * pgas#946 flips `validationOptions.blueprint` from WARN to STRICT by default in
 * engine v6. Under strict, root keys must be GROUPED in canonical block order:
 *
 *   identity -> domain -> lifecycle -> channels -> actions -> guidance
 *   -> delegation -> validation -> view -> render -> policy
 *
 * The MODULAR emission has always been strict-clean by construction (see
 * tests/unit/synthesized-modular-spec.test.ts). The MONOLITHIC single-file
 * `spec_yaml` was dumped in `spec` insertion order and was strict-REJECTED with
 * [BLOCK_ORDER]. This suite pins the fix.
 *
 * Two DISTINCT guards are needed, and neither subsumes the other:
 *
 *  (1) the strict LOAD — the engine's own, independent block map is the judge.
 *      It catches a misfiled key and a reordered block list in the MONOLITHIC
 *      emission, but it TOLERATES import order in the modular emission
 *      (`parseImportBlock` re-walks the engine's own block list), so it cannot
 *      be the only guard on the shared BLUEPRINT_SPEC_BLOCKS constant.
 *
 *  (2) the explicit ORDER assertions — literal, production-independent
 *      expectations. These are what catch a wrongly-slotted key or a reordered
 *      block list at the source, for both emissions.
 */

type BlueprintMode = 'off' | 'warn' | 'strict';

function loadMonolithic(slug: string, specYaml: string, blueprint: BlueprintMode) {
  const root = mkdtempSync(join(tmpdir(), 'pgas-new-monolithic-blueprint-'));
  try {
    const programDir = join(root, 'programs', slug);
    mkdirSync(programDir, { recursive: true });
    writeFileSync(join(programDir, 'specs.yml'), specYaml);
    return loadProgramByConvention(slug, {
      programsRoot: root,
      validationOptions: { blueprint },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function loadModular(
  slug: string,
  files: ReadonlyArray<{ path: string; content: string }>,
  blueprint: BlueprintMode,
) {
  const root = mkdtempSync(join(tmpdir(), 'pgas-new-modular-blueprint-'));
  try {
    const programDir = join(root, 'programs', slug);
    mkdirSync(programDir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(programDir, file.path), file.content);
    }
    return loadProgramByConvention(slug, {
      programsRoot: root,
      validationOptions: { blueprint },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rootKeysOf(specYaml: string): string[] {
  return Object.keys(load(specYaml) as Record<string, unknown>);
}

/** Re-dump a spec with its root keys REVERSED — same mapping, non-canonical order. */
function withReversedRootKeys(specYaml: string): string {
  const parsed = load(specYaml) as Record<string, unknown>;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(parsed).reverse()) {
    reversed[key] = parsed[key];
  }
  return dump(reversed, { lineWidth: -1, noRefs: true, sortKeys: false });
}

const invoiceReviewDomain: Record<string, unknown> = {
  'program.slug': 'invoice-review',
  'program.name': 'Invoice Review',
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

/** An `export_pdf` stage makes the synthesizer emit `render:` and `integrations:`. */
const pdfReportDomain: Record<string, unknown> = {
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

/** A delegation parent, so the synthesized CHILD spec is covered too. */
const delegationParentDomain: Record<string, unknown> = {
  'program.slug': 'parent-program',
  'program.name': 'Parent Program',
  'intake.purpose': 'Dispatch research from intake and finish.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    {
      slug: 'intake',
      is_bootstrap: true,
      domain_spec: {
        reads: ['inputs.initial_user_text'],
        produces: { result_json: { summary: 'string' }, items_json: ['summary:<summary>'] },
        rules: ['Summarize the request.'],
        invariants: ['summary is grounded in the request.'],
      },
    },
    { slug: 'dispatch_research' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'dispatch_research', trigger: 'started', guard_field: 'intake.started' },
    { from: 'dispatch_research', to: 'complete', trigger: 'done', guard_field: 'dispatch_research.ready' },
  ]),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'dispatch_research.ready' }),
  'intake.delegation_json': JSON.stringify({
    stages: { dispatch_research: { kind: 'llm-reasoning', reasoning_per_turn: true } },
    children: [{
      id: 'research',
      stage: 'dispatch_research',
      synthesize_child: {
        kind: 'research_agent',
        purpose: 'Research the intake topic and return concise findings.',
        result_fields: { summary: 'string', seeded_topic: 'string' },
      },
      payload_map: {
        'request.topic': 'intake.summary',
        'domain_context.original_request': 'inputs.initial_user_text',
      },
      result_path: 'dispatch_research.delegation.research.result',
      max_delegated_rounds: 12,
      round_timeout_ms: 120000,
      optional: true,
    }],
  }),
};

interface EmittedSpec {
  label: string;
  slug: string;
  specYaml: string;
  specFiles: ReadonlyArray<{ path: string; content: string }>;
}

/** Every monolithic spec the synthesizer emits for the corpus, parents AND children. */
function emittedCorpus(): EmittedSpec[] {
  const corpus: Array<[string, Record<string, unknown>]> = [
    ['invoice-review', invoiceReviewDomain],
    ['pdf-report-demo', pdfReportDomain],
    ['delegation-parent', delegationParentDomain],
  ];
  const emitted: EmittedSpec[] = [];
  for (const [label, domain] of corpus) {
    const artifact = synthesizeProgramSpecFromDomain(domain);
    emitted.push({
      label,
      slug: String((load(artifact.spec_yaml) as { name: string }).name),
      specYaml: artifact.spec_yaml,
      specFiles: artifact.spec_files as ReadonlyArray<{ path: string; content: string }>,
    });
    for (const child of artifact.child_artifacts ?? []) {
      emitted.push({
        label: `${label}/child`,
        slug: String((load(child.spec_yaml) as { name: string }).name),
        specYaml: child.spec_yaml,
        specFiles: child.spec_files as ReadonlyArray<{ path: string; content: string }>,
      });
    }
  }
  // The delegated child spec is rewritten AFTER emission by
  // patchDelegationChildSpecForDelegation, which re-dumps the whole spec. It
  // must be covered, not assumed.
  expect(emitted.map((item) => item.label)).toContain('delegation-parent/child');
  return emitted;
}

describe('synthesized monolithic spec_yaml emission', () => {
  // GUARD (1): the engine's own block map is the judge.
  it('loads the monolithic spec_yaml under blueprint: strict — parents and delegated children', () => {
    for (const emitted of emittedCorpus()) {
      const loaded = loadMonolithic(emitted.slug, emitted.specYaml, 'strict');
      expect(loaded.spec.name, emitted.label).toBe(emitted.slug);
    }
  });

  it('proves the strict gate is real: a permuted root-key order of the SAME spec is rejected', () => {
    const artifact = synthesizeProgramSpecFromDomain(invoiceReviewDomain);
    const permuted = withReversedRootKeys(artifact.spec_yaml);

    expect(() => loadMonolithic('invoice-review', permuted, 'strict')).toThrow(/\[BLOCK_ORDER\]/u);
    // ...and the same permutation still loads with the gate off, so the rejection
    // is about ORDER only, never about the spec's content.
    expect(loadMonolithic('invoice-review', permuted, 'off').spec.name).toBe('invoice-review');
  });

  // GUARD (2a): literal pin of the canonical block list itself. The strict loader
  // TOLERATES a reordered modular `import:` map, so nothing else pins this constant.
  it('pins BLUEPRINT_SPEC_BLOCKS to the engine canonical block order', () => {
    expect([...BLUEPRINT_SPEC_BLOCKS]).toEqual([
      'identity',
      'domain',
      'lifecycle',
      'channels',
      'actions',
      'guidance',
      'delegation',
      'validation',
      'view',
      'render',
      'policy',
    ]);
  });

  // GUARD (2b): literal pin of the emitted root-key sequence, block by block.
  // Independent of the production key->block map, so misfiling a key fails here
  // even where the engine happens to tolerate the resulting position.
  it('emits root keys grouped in canonical blueprint block order', () => {
    const artifact = synthesizeProgramSpecFromDomain(invoiceReviewDomain);

    expect(rootKeysOf(artifact.spec_yaml)).toEqual([
      // identity
      'name', 'features', 'pure',
      // domain
      'schema', 'reactions',
      // lifecycle
      'modes', 'initial', 'terminal', 'topology', 'termination', 'proceeds_to',
      // channels
      'channels', 'fallback', 'ingestion', 'control_plane',
      // actions
      'action_map',
      // guidance
      'preamble', 'prompts', 'guidance',
      // validation
      'repair_bound',
      // view
      'projection',
      // policy
      'policies',
    ]);
  });

  it('slots the render: deliverable profile after view and before policy', () => {
    const artifact = synthesizeProgramSpecFromDomain(pdfReportDomain);
    const rootKeys = rootKeysOf(artifact.spec_yaml);

    expect(rootKeys).toContain('render');
    expect(rootKeys.indexOf('render')).toBeGreaterThan(rootKeys.indexOf('projection'));
    expect(rootKeys.indexOf('render')).toBeLessThan(rootKeys.indexOf('policies'));
    // `integrations` is a channels-block key, so it must precede `action_map`.
    expect(rootKeys.indexOf('integrations')).toBeGreaterThan(rootKeys.indexOf('control_plane'));
    expect(rootKeys.indexOf('integrations')).toBeLessThan(rootKeys.indexOf('action_map'));
  });

  // GUARD (2c): the general form — holds for ANY program the foundry can emit,
  // including root keys no fixture happens to produce today.
  it('never emits a root key whose block index goes backwards', () => {
    for (const emitted of emittedCorpus()) {
      const blockIndexes = rootKeysOf(emitted.specYaml).map((key) => {
        const block = blueprintBlockForRootKey(key);
        expect(block, `${emitted.label}: root key "${key}" is not mapped to a blueprint block`).toBeDefined();
        return BLUEPRINT_SPEC_BLOCKS.indexOf(block!);
      });
      expect([...blockIndexes].sort((left, right) => left - right), emitted.label).toEqual(blockIndexes);
    }
  });

  // SEMANTIC IDENTITY: comments and key order compile to nothing.
  it('compiles to a Specification identical to the modular emission and to any root-key permutation', () => {
    for (const emitted of emittedCorpus()) {
      const canonical = loadMonolithic(emitted.slug, emitted.specYaml, 'strict');
      const modular = loadModular(emitted.slug, emitted.specFiles, 'strict');
      const permuted = loadMonolithic(emitted.slug, withReversedRootKeys(emitted.specYaml), 'off');

      expect(JSON.stringify(modular.spec), `${emitted.label}: modular`).toBe(JSON.stringify(canonical.spec));
      expect(JSON.stringify(permuted.spec), `${emitted.label}: permutation`).toBe(JSON.stringify(canonical.spec));
    }
  });
});
