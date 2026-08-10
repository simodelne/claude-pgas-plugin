import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { GovernanceRefusalError } from '../../src/foundry-program/governance-gate.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { leadResearchDomain } from '../fixtures/lead-research-domain.js';
import { loadSotaCorpus } from '../sota/harness.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'done', guard_field: 'triage.done' },
];

function domain(): Record<string, unknown> {
  return {
    'program.slug': 'generated-governance',
    'program.name': 'Generated Governance',
    'program.target_dir': '/tmp/generated-governance',
    'program.design_path': 'design',
    'intake.purpose': 'Route one deterministic stage through generated handlers and tools.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify(stages),
    'intake.transitions_json': JSON.stringify(transitions),
    'intake.delegation_json': JSON.stringify({ enabled: false }),
    'intake.completion_json': JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.done' }),
  };
}

describe('generated handler/tool governance gate', () => {
  it('KILL TEST: refuses synthesis when an emitted handler contains real dedup logic', () => {
    let injected = false;
    const originalJoin = Array.prototype.join;
    vi.spyOn(Array.prototype, 'join').mockImplementation(function joinWithHandlerDedup(this: unknown[], separator?: string): string {
      const rendered = originalJoin.call(this, separator) as string;
      if (!injected && separator === '\n\n' && rendered.includes('normalizeStageOutput(output')) {
        injected = true;
        return `${rendered}\n\n  __governance_probe: [...new Set([1, 1])],`;
      }
      return rendered;
    });

    try {
      expect(() => synthesizeProgramSpecFromDomain(domain())).toThrow(GovernanceRefusalError);
      expect(injected).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('KILL TEST: refuses synthesis when emitted tools contain real dedup logic', () => {
    let injected = false;
    const originalJoin = Array.prototype.join;
    vi.spyOn(Array.prototype, 'join').mockImplementation(function joinWithToolDedup(this: unknown[], separator?: string): string {
      const rendered = originalJoin.call(this, separator) as string;
      if (!injected && separator === '\n' && rendered.includes('Generated stage action metadata')) {
        injected = true;
        return `${rendered}\n  __governance_probe: [...new Set([1, 1])],`;
      }
      return rendered;
    });

    try {
      expect(() => synthesizeProgramSpecFromDomain(domain())).toThrow(GovernanceRefusalError);
      expect(injected).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('synthesizes the current representative corpus without generated-source governance refusals', async () => {
    const feeCalculator = (await loadSotaCorpus()).find((benchmark) => benchmark.slug === 'fee-calculator');
    if (!feeCalculator) {
      throw new Error('missing fee-calculator SOTA benchmark');
    }

    const corpus: Array<[string, Record<string, unknown>]> = [
      ['lead-research-agent', leadResearchDomain()],
      ['legal-opinion', legalOpinionDomain()],
      ['document-finalization', documentFinalizationDomain()],
      ['policy-drafting', mandateDomain('docs/graduation-evidence/policy-drafting/MANDATE.md')],
      ['social-media-agent', mandateDomain('docs/graduation-evidence/social-media-agent/MANDATE.md')],
      ['fee-calculator', feeCalculator.mandate],
    ];

    for (const [name, sourceDomain] of corpus) {
      const artifact = await synthesizePossiblyEnrichedArtifact(name, sourceDomain);
      expect(artifact.handlers_ts.length, `${name} handlers_ts should be emitted`).toBeGreaterThan(0);
      expect(artifact.tools_ts.length, `${name} tools_ts should be emitted`).toBeGreaterThan(0);
    }
  });
});

async function synthesizePossiblyEnrichedArtifact(
  name: string,
  sourceDomain: Record<string, unknown>,
) {
  const specOnly = synthesizeProgramSpecFromDomain(sourceDomain);
  const hasReasoningStage = specOnly.body_stage_slugs.some((stage) =>
    specOnly.stage_classification.some((classification) =>
      classification.slug === stage && classification.archetype === 'llm-reasoning'));
  if (!hasReasoningStage) {
    return specOnly;
  }

  try {
    return await synthesizeDomainLogic({
      ...specOnly,
      created_at: '2026-08-10T00:00:00.000Z',
    }, {
      cacheDir: join(tmpdir(), `pgas-generated-governance-${name}`),
      providerUrl: '',
      model: '',
      maxAttempts: 1,
    });
  } catch (error) {
    if (error instanceof GovernanceRefusalError) {
      throw error;
    }
    return specOnly;
  }
}

function mandateDomain(path: string): Record<string, unknown> {
  const intake = parseMandate(path);
  return {
    'program.slug': intake.name,
    'program.name': titleCase(intake.name),
    'program.target_dir': join(tmpdir(), `pgas-new-regression-${intake.name}`),
    'program.design_path': 'design',
    'intake.purpose': intake.purpose,
    'intake.entry_channel': intake.entryChannel,
    'intake.stages_json': JSON.stringify(intake.stages),
    'intake.transitions_json': JSON.stringify(intake.transitions),
    'intake.delegation_json': JSON.stringify(intake.delegation),
    'intake.completion_json': JSON.stringify(intake.completion),
  };
}

interface MandateIntake {
  name: string;
  purpose: string;
  entryChannel: string;
  stages: Array<{ slug: string; is_bootstrap?: boolean; is_terminal?: boolean }>;
  transitions: Array<{ from: string; to: string; trigger: string; guard_field?: string; guard_value?: boolean | string }>;
  delegation: Record<string, unknown>;
  completion: { final_stage: string; guard_field: string };
}

function parseMandate(path: string): MandateIntake {
  const text = readFileSync(path, 'utf8');
  const name = basename(dirname(path));
  const purpose = section(text, 'Q1 Purpose').trim().replace(/\s+/gu, ' ');
  const entryChannel = section(text, 'Q2 Entry channel').trim();
  const completionSection = section(text, 'Q6 Completion criteria');
  const finalStage = requiredMatch(completionSection, /Terminal mode:\s*([a-zA-Z0-9_-]+)/u, 'completion terminal');
  const completionGuard = requiredMatch(completionSection, /Guard:\s*([a-zA-Z0-9_.-]+)\s*=/u, 'completion guard');
  const completion = {
    final_stage: slugNorm(finalStage),
    guard_field: completionGuard,
  };
  const stages = section(text, 'Q3 Stages')
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*\d+\.\s+(.+?)\s+(?:—|-)\s+.+$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match, index) => {
      const slug = slugNorm(match[1] ?? '');
      return {
        slug,
        ...(index === 0 ? { is_bootstrap: true } : {}),
        ...(slug === completion.final_stage ? { is_terminal: true } : {}),
      };
    });
  const transitions = section(text, 'Q4 Decision points')
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*-\s+(.+?)\s+(?:→|->)\s+(.+?)(?:\s+when\s+([a-zA-Z0-9_.-]+)\s*=\s*(.+?))?\s*$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const guardField = match[3]?.trim();
      const guardValue = match[4] === undefined ? undefined : parseGuardValue(match[4]);
      return {
        from: slugNorm(match[1] ?? ''),
        to: slugNorm(match[2] ?? ''),
        trigger: guardField ? `${slugNorm(guardField)}_${String(guardValue)}` : 'auto',
        ...(guardField ? { guard_field: guardField } : {}),
        ...(guardValue !== undefined ? { guard_value: guardValue } : {}),
      };
    });

  return {
    name,
    purpose,
    entryChannel,
    stages,
    transitions,
    delegation: parseDelegation(section(text, 'Q5 Delegation')),
    completion,
  };
}

function section(text: string, heading: string): string {
  const marker = `## ${heading}`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`missing mandate section: ${heading}`);
  }
  const bodyStart = text.indexOf('\n', markerIndex);
  if (bodyStart < 0) return '';
  const rest = text.slice(bodyStart + 1);
  const nextHeadingIndex = rest.search(/^## /mu);
  return nextHeadingIndex >= 0 ? rest.slice(0, nextHeadingIndex) : rest;
}

function requiredMatch(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern);
  if (!match?.[1]) {
    throw new Error(`missing ${label}`);
  }
  return match[1];
}

function parseDelegation(value: string): Record<string, unknown> {
  const normalized = value.trim().toLowerCase();
  return normalized === 'none' ? {} : { mandate: value.trim() };
}

function parseGuardValue(value: string): boolean | string {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed.replace(/^['"]|['"]$/gu, '');
}

function slugNorm(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
}

function titleCase(slug: string): string {
  return slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function documentFinalizationDomain(): Record<string, unknown> {
  return {
    'program.slug': 'document-finalization',
    'program.name': 'Document Finalization',
    'program.target_dir': '/tmp/document-finalization',
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
}

function legalOpinionDomain(): Record<string, unknown> {
  const allTerminal = 'work.opinion_sections.all_terminal';
  const confirmationLifecycle = {
    version: 1,
    name: 'opinion_sections',
    item_label: 'opinion section',
    storage: {
      items_path: 'work.opinion_sections.items',
      event_path: 'work.opinion_sections.pending_event_json',
      violation_path: 'work.opinion_sections.lifecycle_violation_json',
      representation: 'indexed_array',
    },
    item: {
      id_field: 'id',
      status_field: 'status',
      schema: {
        id: 'string',
        title: 'string',
        proposed_text: 'string',
        final_text: 'string',
        user_instruction: 'string',
      },
    },
    statuses: [
      { name: 'draft', initial: true },
      { name: 'proposed' },
      { name: 'accepted', terminal: true },
      { name: 'skipped', terminal: true },
    ],
    transitions: [],
    aggregate: {
      guard_field: allTerminal,
      terminal_statuses: ['accepted', 'skipped'],
      require_non_empty: true,
    },
  };
  const confirmationLoop = {
    collection: 'work.opinion_sections.items',
    proposed_status: 'proposed',
    seed: { source_stage: 'draft_sections', id_prefix: 'section' },
    item_id_field: 'id',
    item_title_field: 'title',
    decisions: {
      approve: { to: 'accepted' },
      revise: {
        to: 'proposed',
        requires_instruction: true,
        instruction_path: 'work.opinion_sections.items.*.user_instruction',
        re_propose: true,
      },
      skip: { to: 'skipped' },
    },
    one_proposed_at_a_time: true,
    aggregate: {
      guard_field: allTerminal,
      terminal_statuses: ['accepted', 'skipped'],
    },
    stage: 'approve',
    summary_path: 'summary.confirmation_loop',
    violation_path: 'work.opinion_sections.confirmation_violation_json',
    pending_action_path: 'decisions.pending_approve_action',
  };

  return {
    'program.slug': 'legal-opinion',
    'program.name': 'Legal Opinion',
    'program.target_dir': '/tmp/legal-opinion',
    'program.design_path': 'design',
    'intake.purpose': 'Draft legal opinion sections, approve them one by one, assemble the approved sections into a DOCX export, and complete.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'draft_sections',
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: {
            result_json: { stage: 'string', section_count: 'number' },
            items_json: [{ id: 'string', title: 'string', proposed_text: 'string' }],
          },
          rules: ['Create draft opinion sections for confirmation.'],
          invariants: ['items_json must contain the proposed sections.'],
        },
      },
      {
        slug: 'approve',
        domain_spec: {
          reads: ['draft_sections.items_json', 'work.opinion_sections.items.*.proposed_text'],
          produces: {},
          rules: ['Confirm each proposed section.'],
          invariants: ['Do not write final export bytes.'],
        },
      },
      {
        slug: 'assemble_export',
        kind: 'export_docx',
        domain_spec: {
          reads: ['work.opinion_sections.items.*.final_text'],
          produces: {
            result_json: {
              stage: 'string',
              docx_base64: 'string',
              docx_bytes: 'number',
              sha256: 'string',
              section_count: 'number',
            },
            items_json: ['docx_export:<sha256>'],
          },
          rules: ['Render approved opinion sections into a deterministic DOCX export.'],
          invariants: ['Do not call an LLM or provider while rendering export bytes.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'draft_sections', trigger: 'started', guard_field: 'intake.started' },
      { from: 'draft_sections', to: 'approve', trigger: 'drafted', guard_field: 'draft_sections.ready' },
      { from: 'approve', to: 'assemble_export', trigger: 'approved', guard_field: allTerminal },
      { from: 'assemble_export', to: 'complete', trigger: 'exported', guard_field: allTerminal },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        draft_sections: { kind: 'llm-reasoning' },
        approve: { kind: 'pure-compute' },
      },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: allTerminal,
      collection_lifecycle: confirmationLifecycle,
    }),
    'intake.interaction_json': JSON.stringify({ confirmation_loops: [confirmationLoop] }),
  };
}
