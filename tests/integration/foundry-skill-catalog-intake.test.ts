import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { getSynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { terminalActionNames, waitForSnapshot } from './foundry-test-utils.js';

const SKILLS = [
  { name: 'clause-amendment', body: 'CLAUSE_AMENDMENT_BODY_SENTINEL: propose the narrowest enforceable clause redline.' },
  { name: 'enforceability-review', body: 'ENFORCEABILITY_BODY_SENTINEL: check capacity, authority, law, and remedy.' },
  { name: 'risk-disclosure-checklist', body: 'RISK_DISCLOSURE_BODY_SENTINEL: enumerate material risks and mitigants.' },
  { name: 'compare-to-precedent', body: 'PRECEDENT_BODY_SENTINEL: compare text against the supplied precedent.' },
] as const;

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'ingest_source' },
  {
    slug: 'hub',
    kind: 'hub',
    archetype: 'conversational_hub',
    domain_spec: {
      reads: ['inputs.initial_user_text', 'work.source'],
      produces: {},
      rules: ['Stay conversational while the user selects legal finalization skills.'],
      invariants: ['Declared skill bodies must only be injected after activate_skill.'],
    },
  },
  { slug: 'complete', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'ingest_source', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'ingest_source', to: 'hub', trigger: 'source_ready', guard_field: 'work.source_ready' },
  { from: 'hub', to: 'hub', trigger: 'continue' },
  { from: 'hub', to: 'complete', trigger: 'done', guard_field: 'hub.done' },
];

const documents = {
  stage: 'ingest_source',
  upload_types: ['text/markdown'],
  extraction: 'self_contained',
  result_path: 'work.source',
  required: true,
  fidelity_floor: { min_chars: 40 },
};

const synthesizedHubBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'hub-ready', at: runtime.now() }),
    items_json: JSON.stringify(['hub-ready']),
    digest: '',
  };
}
`;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('foundry product intake skill catalog path', () => {
  it('records a governed skill catalog before design approval and carries it into synthesis', async () => {
    const targetDir = join(trackedTempRoot('pgas-new-skill-catalog-intake-'), 'document-finalization');
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      authorResponses: [
        effect('record_program_target', {
          slug: 'document-finalization',
          name: 'Document Finalization',
          target_dir: targetDir,
        }),
        effect('choose_design_path', { choice: 'design' }),
        effect('record_q1_purpose', {
          purpose: 'Build a conversational document-finalization hub that activates legal review skills on demand.',
        }),
        effect('record_q2_entry_channel', {
          entry_channel: 'user_text',
        }),
        effect('record_q3_stages', {
          stages_json: JSON.stringify(stages),
        }),
        effect('record_q4_transitions', {
          transitions_json: JSON.stringify(transitions),
        }),
        effect('record_q5_delegation', {
          delegation_json: JSON.stringify({ enabled: false }),
        }),
        effect('record_documents_descriptor', {
          documents_json: JSON.stringify(documents),
        }),
        effect('record_q6_completion', {
          completion_json: JSON.stringify({ final_stage: 'complete', guard_field: 'hub.done' }),
        }),
        effect('record_skill_catalog', {
          skills_json: JSON.stringify(SKILLS),
        }),
        effect('record_program_intake_finalize'),
        effect('confirm_design', { approved: true }),
        effect('authorize_standalone_target'),
        effect('synthesize_program_spec'),
        effect('plan_artifacts'),
        effect('approve_artifact_plan'),
        effect('synthesize_domain_logic', {
          cache_dir: join(targetDir, '.domain-synthesis-cache'),
          __domain_synthesis_body: synthesizedHubBody,
        }),
      ],
    });

    try {
      await harness.trigger({ channel: 'user_text', payload: 'Create a document-finalization program with uploaded document intake and a legal skill catalog.' });
      await harness.trigger({ channel: 'user_text', payload: 'Use the design path.' });
      await harness.trigger({ channel: 'user_text', payload: 'It is a conversational hub for finalizing legal documents with skill activation.' });
      await harness.trigger({ channel: 'user_text', payload: 'user_text' });
      await harness.trigger({ channel: 'user_text', payload: 'intake, ingest_source, hub, complete' });
      await harness.trigger({ channel: 'user_text', payload: 'intake moves to ingest_source, then hub loops until done, then complete.' });
      await harness.trigger({ channel: 'user_text', payload: 'No delegation.' });
      await harness.trigger({ channel: 'user_text', payload: 'Upload one markdown contract descriptor for intake.' });
      await harness.trigger({ channel: 'user_text', payload: 'Complete when hub.done is true.' });
      await harness.trigger({ channel: 'user_text', payload: 'Record the skill catalog.' });

      const beforeFinalize = await harness.snapshot();
      expect(beforeFinalize.mode).toBe('intake_intelligence');
      expect(beforeFinalize.domain['intake.program_intake_finalized']).not.toBe(true);
      expect(JSON.parse(beforeFinalize.domain['intake.skills_json'] as string)).toEqual(SKILLS);
      expect(beforeFinalize.domain['intake.skills_recorded']).toBe(true);

      await harness.trigger({ channel: 'user_text', payload: 'Finalize intake for design confirmation.' });

      const beforeApproval = await harness.snapshot();
      expect(beforeApproval.mode).toBe('intake_intelligence');
      expect(beforeApproval.domain['intake.program_intake_finalized']).toBe(true);
      expect(beforeApproval.domain['program.design_confirmed']).not.toBe(true);
      expect(JSON.parse(beforeApproval.domain['intake.skills_json'] as string)).toEqual(SKILLS);
      expect(beforeApproval.domain['intake.skills_recorded']).toBe(true);

      const summary = String(beforeApproval.domain['intake.design_confirmation_summary'] ?? '');
      expect(summary).toContain('Skill catalog (4)');
      for (const skill of SKILLS) {
        expect(summary).toContain(skill.name);
      }

      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
      await waitForSnapshot(
        harness,
        (candidate) =>
          candidate.mode === 'scaffold_plan' &&
          candidate.domain['artifact_plan.status'] === 'draft' &&
          terminalActionNames(candidate.rounds).includes('plan_artifacts'),
        'skill catalog design approval to draft artifact plan',
      );

      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
      const afterDomainSynthesis = await waitForSnapshot(
        harness,
        (candidate) => candidate.domain['program.domain_synthesis_complete'] === true,
        'skill catalog domain synthesis completion',
      );

      const artifact = getSynthesizedArtifact(afterDomainSynthesis.sessionId);
      expect(artifact, 'synthesized artifact retained for session').toBeTruthy();
      const parsed = load(artifact?.spec_yaml ?? '') as ParsedSpec;
      expect(parsed.features).toEqual(expect.arrayContaining(['activation', 'skill_triage']));
      expect(parsed.activation_providers?.skill?.targets).toBeTruthy();
      for (const skill of SKILLS) {
        expect(parsed.activation_providers?.skill?.targets[skill.name]?.body).toBe(skill.body);
      }
    } finally {
      await harness.close();
    }
  }, 120_000);
});

interface ParsedSpec {
  features?: string[];
  activation_providers?: Record<string, {
    targets: Record<string, { body: unknown }>;
  }>;
}

function effect(name: string, payload: Record<string, unknown> = {}): TestHarnessAuthorResponse {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel: name === 'plan_artifacts' ? 'artifact_plan_output' : 'widget_output',
        payload,
      },
    ],
  };
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
