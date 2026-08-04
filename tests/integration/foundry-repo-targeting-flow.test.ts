import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { getSynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { terminalActionNames, waitForSnapshot } from './foundry-test-utils.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('foundry repo_targeting continuation flow', () => {
  it('allows upload descriptor and same-stage document-ingest delegation through the product path', async () => {
    const targetDir = trackedTempRoot('pgas-new-upload-delegate-ingest-');
    mkdirSync(join(targetDir, '.pgas'), { recursive: true });
    writeFileSync(join(targetDir, '.pgas/wiring.yml'), nativeSourceDelegablesManifestYaml());
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: documentFinalizationProductPathResponses(
        targetDir,
        documentIngestDelegationPayload({
          'request.extraction_contract': 'inputs.initial_user_text',
          'domain_context.original_request': 'inputs.initial_user_text',
        }),
        documentFinalizationDocumentsDescriptor(),
        documentFinalizationStages(),
        documentFinalizationTransitions(),
        { final_stage: 'complete', guard_field: 'finalize_export.ready' },
      ),
    });

    try {
      await driveDocumentFinalizationProductPath(harness, { includeDocuments: true });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) =>
          candidate.mode === 'scaffold_plan' &&
          candidate.domain['artifact_plan.status'] === 'draft' &&
          terminalActionNames(candidate.rounds).includes('synthesize_program_spec'),
        'same-stage upload descriptor and document-ingest delegation synthesis',
      );
      const artifact = getSynthesizedArtifact(snapshot.sessionId);
      if (!artifact?.synthesis_context) {
        throw new Error('missing synthesized artifact for upload-to-document-ingest falsifier');
      }
      const parsed = load(artifact.spec_yaml) as {
        channels: Record<string, Record<string, unknown>>;
        action_map: Record<string, { channel?: string }>;
        modes: Record<string, {
          vocabulary?: string[];
          preconditions?: Record<string, unknown[]>;
        }>;
        projection: Record<string, { include?: string[]; exclude?: string[] }>;
        reactions: Record<string, { write_scope?: string[] }>;
        schema: Record<string, string>;
      };
      const child = artifact.synthesis_context.delegation.children?.[0] as Record<string, unknown> | undefined;
      const payloadMap = child?.payload_map as Record<string, string> | undefined;
      const enrichment = inputEnrichmentRules(artifact.registration_ts ?? '');

      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
      expect(artifact.synthesis_context.documents).toMatchObject({
        stage: 'ingest',
        extraction: 'host_connector',
        result_path: 'work.document',
      });
      expect(child).toMatchObject({
        id: 'document_ingest',
        stage: 'ingest',
        target_spec: 'SimoneOS Document Ingest',
        registered_name: 'document-ingest',
        target_slug: 'document-ingest',
        result_path: 'ingest.delegation.document_ingest.result',
      });
      expect(payloadMap).toEqual(expect.objectContaining({
        'request.documents': 'work.document.documents',
        'request.extraction_contract': 'work.document.extraction_contract',
        'domain_context.original_request': 'inputs.initial_user_text',
      }));
      expect(Object.values(payloadMap ?? {})).not.toContain('intake.summary');
      expect(enrichment).toEqual(expect.arrayContaining([
        { source: 'work.document.documents', target: 'request.documents' },
        { source: 'work.document.extraction_contract', target: 'request.extraction_contract' },
      ]));
      expect(parsed.modes.ingest.vocabulary).toEqual(expect.arrayContaining([
        'request_documents',
        'ingest_documents',
        'document_ingest',
      ]));
      expect(parsed.modes.ingest.preconditions?.document_ingest).toEqual(expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'work.document_ready' },
      ]));
      expect(parsed.channels.document_ingest_call).toMatchObject({
        target_spec: 'SimoneOS Document Ingest',
        result_path: 'ingest.delegation.document_ingest.result',
        optional: true,
      });
      expect(parsed.action_map.document_ingest.channel).toBe('document_ingest_call');
      expect(parsed.schema).toMatchObject({
        'work.document.extraction_contract': 'object',
        'work.document.extraction_contract.output_profile': 'string',
        'work.document.extraction_contract.target_schema': 'object',
        'work.document.extraction_contract.required_outputs': 'array',
        'work.document.summary': 'string',
        'work.document.sections': 'object',
        'work.document.sections.*': 'object',
        'work.document.sections.*.id': 'string',
        'work.document.sections.*.heading': 'string',
        'work.document.sections.*.status': 'string',
        'work.document.sections.*.text': 'string',
        'work.document.ingest_result_harvested': 'boolean',
      });
      expect(parsed.reactions.settle_document_ingest_delegation.write_scope).toEqual(expect.arrayContaining([
        'ingest.delegation.document_ingest.settled',
        'work.document.summary',
        'work.document.sections',
        'work.document.sections.*',
        'work.document.ingest_result_harvested',
      ]));
      expect(parsed.projection.finalization_hub.include).toEqual(expect.arrayContaining([
        'work.document.summary',
        'work.document.sections.*.id',
        'work.document.sections.*.heading',
        'work.document.sections.*.status',
      ]));
      expect(parsed.projection.finalization_hub.exclude).toContain('work.document.sections.*.text');
      expect(artifact.handlers_ts).toContain('settleDocumentIngestDelegationResult');
      expect(artifact.handlers_ts).toContain('documentArtifactsFromIngestResult');
      expect(artifact.handlers_ts).toContain("path: documentPath + '.summary'");
      expect(artifact.handlers_ts).toContain("path: documentPath + '.sections'");
      expect(artifact.handlers_ts).toContain("path: documentPath + '.ingest_result_harvested'");
    } finally {
      await harness.close();
    }
  });

  it('adapts manifest reusable delegation payload targets to parent-declared Q5 sources before synthesis', async () => {
    const targetDir = trackedTempRoot('pgas-new-reusable-payload-adapter-');
    mkdirSync(join(targetDir, '.pgas'), { recursive: true });
    writeFileSync(join(targetDir, '.pgas/wiring.yml'), nativeSourceDelegablesManifestYaml());
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: documentFinalizationProductPathResponses(
        targetDir,
        documentIngestDelegationPayload({
          'request.extraction_contract': 'inputs.initial_user_text',
          'domain_context.original_request': 'inputs.initial_user_text',
        }),
      ),
    });

    try {
      await driveDocumentFinalizationProductPath(harness);

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) =>
          candidate.mode === 'scaffold_plan' &&
          candidate.domain['artifact_plan.status'] === 'draft' &&
          terminalActionNames(candidate.rounds).includes('synthesize_program_spec'),
        'adapted existing-repo reusable delegation payload-map synthesis',
      );
      const artifact = getSynthesizedArtifact(snapshot.sessionId);
      if (!artifact?.synthesis_context) {
        throw new Error('missing synthesized artifact for reusable payload-map adapter falsifier');
      }
      const parsed = load(artifact.spec_yaml) as {
        channels: Record<string, Record<string, unknown>>;
        action_map: Record<string, Record<string, unknown>>;
      };
      const child = artifact.synthesis_context.delegation.children?.[0] as Record<string, unknown> | undefined;
      const payloadMap = child?.payload_map as Record<string, string> | undefined;

      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
      expect(child).toMatchObject({
        id: 'document_ingest',
        target_spec: 'SimoneOS Document Ingest',
        registered_name: 'document-ingest',
        target_slug: 'document-ingest',
      });
      expect(payloadMap).toEqual({
        'request.extraction_contract': 'inputs.initial_user_text',
        'domain_context.original_request': 'inputs.initial_user_text',
      });
      expect(Object.values(payloadMap ?? {})).not.toContain('intake.summary');
      expect(parsed.channels.document_ingest_call).toMatchObject({
        target_spec: 'SimoneOS Document Ingest',
        result_path: 'ingest.delegation.document_ingest.result',
        optional: true,
      });
      expect(parsed.action_map.document_ingest.channel).toBe('document_ingest_call');
      expect(artifact.registration_ts ?? '').toContain("source: 'inputs.initial_user_text'");
      expect(artifact.registration_ts ?? '').not.toContain("source: 'intake.summary'");
    } finally {
      await harness.close();
    }
  });

  it('rejects manifest reusable delegation payload maps during intake when no parent source override is supplied', async () => {
    const targetDir = trackedTempRoot('pgas-new-reusable-payload-invalid-');
    mkdirSync(join(targetDir, '.pgas'), { recursive: true });
    writeFileSync(join(targetDir, '.pgas/wiring.yml'), nativeSourceDelegablesManifestYaml());
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: documentFinalizationProductPathResponses(
        targetDir,
        documentIngestDelegationPayload({
          'request.extraction_contract': 'intake.summary',
        }),
      ),
    });

    try {
      await harness.trigger('Attach document finalization to this existing repo.');
      await harness.trigger('Use the design path.');
      await harness.trigger('Q1 answer.');
      await harness.trigger('Q2 answer.');
      await harness.trigger('Q3 answer.');
      await harness.trigger('Q4 answer.');
      await harness.trigger('Q5 answer.');

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) =>
          candidate.mode === 'intake_intelligence' &&
          candidate.domain['intake.q5_recorded'] === false &&
          typeof candidate.domain['intake.delegation_validation_error'] === 'string',
        'intake-time reusable delegation payload-map validation failure',
      );
      const error = String(snapshot.domain['intake.delegation_validation_error']);
      const names = terminalActionNames(snapshot.rounds);

      expect(error).toContain('manifest source intake.summary is not declared in this program\'s schema');
      expect(error).toContain('provide a source mapping');
      expect(snapshot.domain['program.design_confirmed']).not.toBe(true);
      expect(names).toContain('record_q5_delegation');
      expect(names).not.toContain('confirm_design');
      expect(names).not.toContain('synthesize_program_spec');
    } finally {
      await harness.close();
    }
  });

  it('normalizes a hyphenated manifest delegation slug through product intake while preserving the external binding', async () => {
    const targetDir = trackedTempRoot('pgas-new-hyphenated-delegable-');
    mkdirSync(join(targetDir, '.pgas'), { recursive: true });
    writeFileSync(join(targetDir, '.pgas/wiring.yml'), hyphenatedDelegablesManifestYaml());
    const delegationPayload = {
      stages: {
        ingest: { kind: 'external-adapter', target: 'document-ingest' },
      },
      children: [{
        id: 'document-ingest',
        stage: 'ingest',
        action_name: 'document_ingest',
        synthesize_child: {
          kind: 'worker',
          purpose: 'Extract document sections and summary for finalization.',
          result_fields: { summary: 'string', sections_json: 'string' },
        },
        payload_map: {
          'request.extraction_contract': 'inputs.initial_user_text',
          'domain_context.original_request': 'inputs.initial_user_text',
        },
        result_path: 'ingest.delegation.document_ingest.result',
        max_delegated_rounds: 12,
        round_timeout_ms: 120000,
        optional: true,
      }],
    };
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'document-finalization',
          name: 'Document Finalization',
          target_dir: targetDir,
        }),
        effect('choose_design_path', { choice: 'design' }),
        effect('record_q1_purpose', {
          purpose: 'Finalize uploaded documents by delegating ingest and preserving a section summary.',
        }),
        effect('record_q2_entry_channel', {
          entry_channel: 'user_text',
        }),
        effect('record_q3_stages', {
          stages_json: JSON.stringify([
            {
              slug: 'start',
              is_bootstrap: true,
              domain_spec: {
                reads: ['inputs.initial_user_text'],
                produces: { result_json: { summary: 'string' } },
                rules: ['Capture the finalization request for delegation.'],
                invariants: ['The original request is preserved for delegated ingest.'],
              },
            },
            { slug: 'ingest' },
            { slug: 'complete', is_terminal: true },
          ]),
        }),
        effect('record_q4_transitions', {
          transitions_json: JSON.stringify([
            { from: 'start', to: 'ingest', trigger: 'started', guard_field: 'start.started' },
            { from: 'ingest', to: 'complete', trigger: 'ingested', guard_field: 'ingest.ready' },
          ]),
        }),
        effect('record_q5_delegation', {
          delegation_json: JSON.stringify(delegationPayload),
        }),
        effect('record_q6_completion', {
          completion_json: JSON.stringify({ final_stage: 'complete', guard_field: 'ingest.ready' }),
        }),
        effect('record_program_intake_finalize', {}),
        effect('confirm_design', { approved: true }),
        effect('select_repo_target', { target_kind: 'existing_repo' }),
        effect('load_wiring_manifest', { repo_root: targetDir }),
        effect('authorize_existing_repo_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Attach document finalization to this existing repo.');
      await harness.trigger('Use the design path.');
      await harness.trigger('Q1 answer.');
      await harness.trigger('Q2 answer.');
      await harness.trigger('Q3 answer.');
      await harness.trigger('Q4 answer.');
      await harness.trigger('Q5 answer.');
      await harness.trigger('Q6 answer.');
      await harness.trigger('Finalize intake.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) =>
          candidate.mode === 'scaffold_plan' &&
          candidate.domain['artifact_plan.status'] === 'draft' &&
          terminalActionNames(candidate.rounds).includes('synthesize_program_spec'),
        'hyphenated manifest delegation slug synthesis',
      );
      const artifact = getSynthesizedArtifact(snapshot.sessionId);
      if (!artifact?.synthesis_context) {
        throw new Error('missing synthesized artifact for hyphenated manifest delegation falsifier');
      }
      const parsed = load(artifact.spec_yaml) as {
        channels: Record<string, Record<string, unknown>>;
        action_map: Record<string, Record<string, unknown>>;
      };
      const child = artifact.synthesis_context.delegation.children?.[0] as Record<string, unknown> | undefined;

      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
      expect(child).toMatchObject({
        id: 'document_ingest',
        target_spec: 'SimoneOS Document Ingest',
        registered_name: 'document-ingest',
        target_slug: 'document-ingest',
        payload_map: {
          'request.extraction_contract': 'inputs.initial_user_text',
          'domain_context.original_request': 'inputs.initial_user_text',
        },
      });
      expect(child).not.toHaveProperty('synthesize_child');
      expect(parsed.channels.document_ingest_call).toMatchObject({
        target_spec: 'SimoneOS Document Ingest',
        result_path: 'ingest.delegation.document_ingest.result',
        optional: true,
      });
      expect(parsed.channels['document-ingest_call']).toBeUndefined();
      expect(parsed.action_map.document_ingest.channel).toBe('document_ingest_call');
      expect(artifact.registration_ts ?? '').toContain('SimoneOS Document Ingest');
      expect(artifact.registration_ts ?? '').toContain('document-ingest');
    } finally {
      await harness.close();
    }
  });

  it('routes confirm_design through repo_targeting, authorizes standalone writes, then enters architecture_design', async () => {
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: '/tmp/incident-triage',
        }),
        effect('choose_design_path', { choice: 'design' }),
        effect('record_q1_purpose', {
          purpose: 'Route incoming incidents into a triage workflow.',
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
          delegation_json: JSON.stringify({}),
        }),
        effect('record_q6_completion', {
          completion_json: JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
        }),
        effect('record_program_intake_finalize', {}),
        effect('confirm_design', { approved: true }),
        effect('authorize_standalone_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Create an incident triage PGAS program.');
      await harness.trigger('I want to design it.');
      await harness.trigger('Route incoming incidents into a triage workflow.');
      await harness.trigger('user_text');
      await harness.trigger('intake, triage, resolved');
      await harness.trigger('intake to triage, then triage to resolved.');
      await harness.trigger('No delegation.');
      await harness.trigger('Resolved when triage.summary_ready is true.');
      await harness.trigger('Finalize intake.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) => candidate.mode === 'scaffold_plan' && candidate.domain['artifact_plan.status'] === 'draft',
        'repo targeting continuation to scaffold artifact plan',
      );
      const rounds = terminalRounds(snapshot.rounds);

      expect(rounds.find((round) => round.name === 'confirm_design')?.proposedMode).toBe('repo_targeting');
      expect(rounds.find((round) => round.name === 'authorize_standalone_target')?.proposedMode).toBe(
        'architecture_design',
      );
      expect(rounds.map((round) => round.name)).toEqual(
        expect.arrayContaining(['confirm_design', 'authorize_standalone_target', 'synthesize_program_spec']),
      );
      expect(snapshot.mode).toBe('scaffold_plan');
      expect(snapshot.domain['repo.target_kind']).toBe('standalone_repo');
      expect(snapshot.domain['repo.write_authorized']).toBe(true);
      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('auto-continues existing-repo target selection into wiring manifest loading', async () => {
    const targetDir = trackedTempRoot('pgas-new-existing-repo-');
    mkdirSync(join(targetDir, '.pgas'), { recursive: true });
    writeFileSync(join(targetDir, '.pgas/wiring.yml'), manifestYaml());
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: targetDir,
        }),
        effect('choose_design_path', { choice: 'default' }),
        effect('apply_default_skeleton', {}),
        effect('confirm_design', { approved: true }),
        effect('select_repo_target', { target_kind: 'existing_repo' }),
        effect('load_wiring_manifest', { repo_root: targetDir }),
        effect('authorize_existing_repo_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Attach incident triage to this existing repo.');
      await harness.trigger('Use the default skeleton.');
      await harness.trigger('Apply the default.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) => candidate.mode === 'scaffold_plan' && candidate.domain['artifact_plan.status'] === 'draft',
        'existing-repo target selection continuation to artifact planning',
      );
      const rounds = terminalRounds(snapshot.rounds);

      expect(rounds.map((round) => round.name)).toEqual(
        expect.arrayContaining([
          'select_repo_target',
          'load_wiring_manifest',
          'authorize_existing_repo_target',
          'synthesize_program_spec',
          'plan_artifacts',
        ]),
      );
      expect(rounds.find((round) => round.name === 'select_repo_target')?.trigger).toBe('system_mode_entry');
      expect(rounds.find((round) => round.name === 'load_wiring_manifest')?.trigger).toBe('system_mode_entry');
      expect(snapshot.domain['repo.target_kind']).toBe('existing_repo');
      expect(snapshot.domain['repo.write_authorized']).toBe(true);
      expect(snapshot.domain['repo.wiring_manifest.status']).toBe('valid');
      expect(snapshot.domain['repo.wiring_manifest.path']).toBe('.pgas/wiring.yml');
    } finally {
      await harness.close();
    }
  });

  it('blocks curator request after a valid manifest and repairs to existing-repo authorization', async () => {
    const targetDir = trackedTempRoot('pgas-new-valid-manifest-repair-');
    mkdirSync(join(targetDir, '.pgas'), { recursive: true });
    writeFileSync(join(targetDir, '.pgas/wiring.yml'), manifestYaml());
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: targetDir,
        }),
        effect('choose_design_path', { choice: 'default' }),
        effect('apply_default_skeleton', {}),
        effect('confirm_design', { approved: true }),
        effect('select_repo_target', { target_kind: 'existing_repo' }),
        effect('load_wiring_manifest', { repo_root: targetDir }),
        effect('create_curator_request', {
          message: `Creating curator request for incident-triage in existing repo ${targetDir}.`,
        }),
        effect('authorize_existing_repo_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Attach incident triage to this existing repo.');
      await harness.trigger('Use the default skeleton.');
      await harness.trigger('Apply the default.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) => candidate.mode === 'scaffold_plan' && candidate.domain['artifact_plan.status'] === 'draft',
        'valid manifest curator-request repair to artifact planning',
      );
      const rounds = terminalRounds(snapshot.rounds);
      const names = rounds.map((round) => round.name);

      expect(names).toEqual(
        expect.arrayContaining([
          'load_wiring_manifest',
          'authorize_existing_repo_target',
          'synthesize_program_spec',
          'plan_artifacts',
        ]),
      );
      expect(names).not.toContain('create_curator_request');
      expect(snapshot.mode).toBe('scaffold_plan');
      expect(snapshot.domain['repo.write_authorized']).toBe(true);
      expect(snapshot.domain['repo.wiring_manifest.status']).toBe('valid');
      expect(snapshot.domain['repo.curator_request_lodged']).not.toBe(true);
      expect(repairAttempts(snapshot.rounds)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            failedGate: 'GKPrecondition',
            failedPredicate: expect.objectContaining({ path: 'repo.write_authorized' }),
          }),
        ]),
      );
    } finally {
      await harness.close();
    }
  });

  it('auto-continues standalone target selection into standalone authorization', async () => {
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: '/tmp/incident-triage',
        }),
        effect('choose_design_path', { choice: 'default' }),
        effect('apply_default_skeleton', {}),
        effect('confirm_design', { approved: true }),
        effect('select_repo_target', { target_kind: 'standalone_repo' }),
        effect('authorize_standalone_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Create an incident triage PGAS program.');
      await harness.trigger('Use the default skeleton.');
      await harness.trigger('Apply the default.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) => candidate.mode === 'scaffold_plan' && candidate.domain['artifact_plan.status'] === 'draft',
        'standalone target selection continuation to artifact planning',
      );
      const rounds = terminalRounds(snapshot.rounds);

      expect(rounds.map((round) => round.name)).toEqual(
        expect.arrayContaining([
          'select_repo_target',
          'authorize_standalone_target',
          'synthesize_program_spec',
          'plan_artifacts',
        ]),
      );
      expect(rounds.find((round) => round.name === 'select_repo_target')?.trigger).toBe('system_mode_entry');
      expect(rounds.find((round) => round.name === 'authorize_standalone_target')?.trigger).toBe(
        'system_mode_entry',
      );
      expect(rounds.find((round) => round.name === 'authorize_standalone_target')?.proposedMode).toBe(
        'architecture_design',
      );
      expect(snapshot.domain['repo.target_kind']).toBe('standalone_repo');
      expect(snapshot.domain['repo.write_authorized']).toBe(true);
      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

function effect(name: string, payload: Record<string, unknown>): TestHarnessAuthorResponse {
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

function terminalRounds(rounds: unknown[]): Array<{ name: string; proposedMode?: string; trigger?: string }> {
  return rounds.flatMap((round) => {
    if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
    const trigger = (round as { trigger?: unknown }).trigger;
    const result = (round as { result?: unknown }).result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const terminal = (result as { terminal?: unknown }).terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
    const name = (terminal as { name?: unknown }).name;
    const proposedMode = (result as { proposedMode?: unknown }).proposedMode;
    if (typeof name !== 'string') return [];
    return [{
      name,
      proposedMode: typeof proposedMode === 'string' ? proposedMode : undefined,
      trigger: typeof trigger === 'string' ? trigger : undefined,
    }];
  });
}

function repairAttempts(rounds: unknown[]): Array<{ failedGate?: string; failedPredicate?: { path?: string } }> {
  return rounds.flatMap((round) => {
    if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
    const protocol = (round as { protocol?: unknown }).protocol;
    if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) return [];
    const attempts = (protocol as { repairAttempts?: unknown }).repairAttempts;
    return Array.isArray(attempts) ? attempts as Array<{ failedGate?: string; failedPredicate?: { path?: string } }> : [];
  });
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function documentIngestDelegationPayload(payloadMap: Record<string, string>): Record<string, unknown> {
  return {
    stages: {
      ingest: { kind: 'external-adapter', target: 'document-ingest' },
    },
    children: [{
      id: 'document-ingest',
      stage: 'ingest',
      action_name: 'document_ingest',
      synthesize_child: {
        kind: 'worker',
        purpose: 'Extract document sections and summary for finalization.',
        result_fields: { summary: 'string', sections_json: 'string' },
      },
      payload_map: payloadMap,
      result_path: 'ingest.delegation.document_ingest.result',
      max_delegated_rounds: 12,
      round_timeout_ms: 120000,
      optional: true,
    }],
  };
}

function documentFinalizationProductPathResponses(
  targetDir: string,
  delegationPayload: Record<string, unknown>,
  documentsPayload?: Record<string, unknown>,
  stagesPayload: Array<Record<string, unknown>> = defaultDocumentFinalizationStages(),
  transitionsPayload: Array<Record<string, unknown>> = defaultDocumentFinalizationTransitions(),
  completionPayload: Record<string, unknown> = { final_stage: 'complete', guard_field: 'ingest.ready' },
): TestHarnessAuthorResponse[] {
  return [
    effect('record_program_target', {
      slug: 'document-finalization',
      name: 'Document Finalization',
      target_dir: targetDir,
    }),
    effect('choose_design_path', { choice: 'design' }),
    effect('record_q1_purpose', {
      purpose: 'Finalize uploaded documents by delegating ingest and preserving a section summary.',
    }),
    effect('record_q2_entry_channel', {
      entry_channel: 'user_text',
    }),
    effect('record_q3_stages', {
      stages_json: JSON.stringify(stagesPayload),
    }),
    effect('record_q4_transitions', {
      transitions_json: JSON.stringify(transitionsPayload),
    }),
    effect('record_q5_delegation', {
      delegation_json: JSON.stringify(delegationPayload),
    }),
    ...(documentsPayload ? [
      effect('record_documents_descriptor', {
        documents_json: JSON.stringify(documentsPayload),
      }),
    ] : []),
    effect('record_q6_completion', {
      completion_json: JSON.stringify(completionPayload),
    }),
    effect('record_program_intake_finalize', {}),
    effect('confirm_design', { approved: true }),
    effect('select_repo_target', { target_kind: 'existing_repo' }),
    effect('load_wiring_manifest', { repo_root: targetDir }),
    effect('authorize_existing_repo_target', {}),
    effect('synthesize_program_spec', {}),
    effect('plan_artifacts', {}),
  ];
}

async function driveDocumentFinalizationProductPath(
  harness: Awaited<ReturnType<typeof createTestHarness>>,
  options: { includeDocuments?: boolean } = {},
): Promise<void> {
  await harness.trigger('Attach document finalization to this existing repo.');
  await harness.trigger('Use the design path.');
  await harness.trigger('Q1 answer.');
  await harness.trigger('Q2 answer.');
  await harness.trigger('Q3 answer.');
  await harness.trigger('Q4 answer.');
  await harness.trigger('Q5 answer.');
  if (options.includeDocuments === true) {
    await harness.trigger('Documents descriptor answer.');
  }
  await harness.trigger('Q6 answer.');
  await harness.trigger('Finalize intake.');
  await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
}

function defaultDocumentFinalizationStages(): Array<Record<string, unknown>> {
  return [
    {
      slug: 'start',
      is_bootstrap: true,
      domain_spec: {
        reads: ['inputs.initial_user_text'],
        produces: { result_json: { summary: 'string' } },
        rules: ['Capture the finalization request for delegation.'],
        invariants: ['The original request is preserved for delegated ingest.'],
      },
    },
    { slug: 'ingest' },
    { slug: 'complete', is_terminal: true },
  ];
}

function defaultDocumentFinalizationTransitions(): Array<Record<string, unknown>> {
  return [
    { from: 'start', to: 'ingest', trigger: 'started', guard_field: 'start.started' },
    { from: 'ingest', to: 'complete', trigger: 'ingested', guard_field: 'ingest.ready' },
  ];
}

function documentFinalizationStages(): Array<Record<string, unknown>> {
  return [
    { slug: 'start', is_bootstrap: true },
    {
      slug: 'ingest',
      domain_spec: {
        reads: ['inputs.initial_user_text', 'inputs.documents'],
        produces: {
          result_json: {
            summary: 'string',
            section_count: 'number',
          },
          items_json: ['section_count:<section_count>'],
        },
        rules: ['Delegate extraction to simoneos document-ingest and store summary plus section artifacts.'],
        invariants: ['Full section text must be stored in world artifacts, not projected into the hub prompt.'],
      },
    },
    {
      slug: 'finalization_hub',
      kind: 'hub',
      archetype: 'conversational_hub',
      engine_tools: ['query', 'notebook'],
      domain_spec: {
        reads: [
          'inputs.initial_user_text',
          'work.document.summary',
          'work.document.sections.*.id',
          'work.document.sections.*.heading',
          'work.document.sections.*.status',
          'work.document.sections.*.text',
          'notebook_pins',
        ],
        produces: {},
        rules: [
          'Stay in the hub after ad-hoc tools unless the user explicitly requests amendment approval or finalization.',
          'Use query for full section text; use projected summary and section index for orientation.',
        ],
        invariants: [
          'Only summary and section index are projected.',
          'Full section text remains query-only.',
        ],
      },
    },
    {
      slug: 'finalize_export',
      kind: 'export_docx',
      export_kind: 'export_docx',
      domain_spec: {
        reads: ['work.document.sections.*.text', 'work.document.summary'],
        produces: {
          result_json: { docx_ready: 'boolean', amended_docx_path: 'string' },
          items_json: ['docx:<amended_docx_path>'],
        },
        rules: ['Render amended sections in document order to an amended DOCX.'],
        invariants: ['No LLM round is required in finalize_export.'],
      },
    },
    { slug: 'complete', is_terminal: true },
  ];
}

function documentFinalizationTransitions(): Array<Record<string, unknown>> {
  return [
    { from: 'start', to: 'ingest', trigger: 'started', guard_field: 'start.started' },
    { from: 'ingest', to: 'finalization_hub', trigger: 'ingested', guard_field: 'ingest.ready' },
    { from: 'finalization_hub', to: 'finalization_hub', trigger: 'stay' },
    { from: 'finalization_hub', to: 'finalize_export', trigger: 'finalize', guard_field: 'finalization_hub.finalize_requested' },
    { from: 'finalize_export', to: 'complete', trigger: 'exported', guard_field: 'finalize_export.ready' },
  ];
}

function documentFinalizationDocumentsDescriptor(): Record<string, unknown> {
  return {
    stage: 'ingest',
    upload_types: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown', 'text/plain'],
    extraction: 'host_connector',
    result_path: 'work.document',
    required: true,
    artifact_shape: {
      summary: 'string',
      sections: {
        '*': { id: 'string', heading: 'string', status: 'string', text: 'string' },
      },
    },
  };
}

interface InputEnrichmentRule {
  source: string;
  target: string;
}

function inputEnrichmentRules(registrationSource: string): InputEnrichmentRule[] {
  return Array.from(
    registrationSource.matchAll(/\{\s*source:\s*'([^']+)',\s*target:\s*'([^']+)'\s*\}/gu),
    (match) => ({ source: match[1] as string, target: match[2] as string }),
  );
}

function manifestYaml(): string {
  return `schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
    - "@simodelne/pgas-server/create-server.js"
    - "@simodelne/pgas-server/client.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
paths:
  programs_dir: programs
  audit_dir: audit
  pgas_new_dir: .pgas/pgas-new
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
`;
}

function hyphenatedDelegablesManifestYaml(): string {
  return `${manifestYaml()}available_programs:
  - slug: document-ingest
    target_spec: SimoneOS Document Ingest
    provides: delegation_document_ingest
    payload_map:
      request.extraction_contract: inputs.initial_user_text
      domain_context.original_request: inputs.initial_user_text
    result_path: ingest.delegation.document_ingest.result
  - slug: review-service
    target_spec: review-service
    provides: delegation_review
`;
}

function nativeSourceDelegablesManifestYaml(): string {
  return `${manifestYaml()}available_programs:
  - slug: document-ingest
    target_spec: SimoneOS Document Ingest
    provides: delegation_document_ingest
    payload_map:
      request.extraction_contract: intake.summary
      domain_context.original_request: intake.summary
    result_path: ingest.delegation.document_ingest.result
`;
}
