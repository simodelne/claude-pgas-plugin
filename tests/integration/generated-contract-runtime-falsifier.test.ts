import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import {
  REASONING_CONTRACT_VERSION,
  type ReasoningStageContract,
} from '../../src/foundry-program/reasoning-contract.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { loadRenderedGeneratedProgramEntry } from '../fixtures/generated-convention-entry.js';

interface ParsedSpec {
  action_map: Record<string, { channel?: string }>;
}

describe('generated contracted reasoning runtime shape tolerance', () => {
  it('accepts an object result_json payload without a pre-dispatch GKType repair', { timeout: 120_000 }, async () => {
    const artifact = synthesizeProgramSpecFromDomain(contractRuntimeDomain(), {
      reasoningContracts: { review: reviewContract() },
    });
    const parsed = load(artifact.spec_yaml) as ParsedSpec;
    const reviewChannel = parsed.action_map.complete_review.channel ?? 'widget_output';
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-contract-runtime-'));

    try {
      renderStandaloneScaffold({
        slug: 'contract-runtime',
        name: 'Contract Runtime',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);
      const harness = await createTestHarness(await importProgramEntry(targetDir), {
        programName: 'contract-runtime',
        defaultChannel: 'user_text',
        authorResponses: [
          effect('begin_work', {}, 'widget_output'),
          effect('complete_review', {
            result_json: {
              decision: 'approve',
              rationale: 'The memo satisfies the review checklist.',
              quality_score: 91,
              blocking: false,
              gaps: ['none'],
            },
            items_json: ['review:decision:approve', 'review:quality:91'],
          }, reviewChannel),
        ],
      });

      try {
        await harness.trigger('start review');
        await harness.trigger('finish review');
        const snapshot = await harness.snapshot();
        const expectedResult = JSON.stringify({
          decision: 'approve',
          rationale: 'The memo satisfies the review checklist.',
          quality_score: 91,
          blocking: false,
          gaps: ['none'],
        });
        expect(snapshot.mode).toBe('complete');
        expect(snapshot.domain['review.result_json']).toBe(expectedResult);
        expect(snapshot.domain['review.output.result_json']).toBe(expectedResult);
        expect(snapshot.domain['review.items_json']).toBe(JSON.stringify(['review:decision:approve', 'review:quality:91']));
        expect(snapshot.domain['review.result.rationale']).toBe('The memo satisfies the review checklist.');
      } finally {
        await harness.close();
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('accepts a single-key object for a nested result field without a pre-dispatch GKType repair', { timeout: 120_000 }, async () => {
    const artifact = synthesizeProgramSpecFromDomain(contractRuntimeDomain(), {
      reasoningContracts: { review: reviewContract() },
    });
    const parsed = load(artifact.spec_yaml) as ParsedSpec;
    const reviewChannel = parsed.action_map.complete_review.channel ?? 'widget_output';
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-contract-runtime-'));

    try {
      renderStandaloneScaffold({
        slug: 'contract-runtime',
        name: 'Contract Runtime',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);
      const harness = await createTestHarness(await importProgramEntry(targetDir), {
        programName: 'contract-runtime',
        defaultChannel: 'user_text',
        authorResponses: [
          effect('begin_work', {}, 'widget_output'),
          effect('complete_review', {
            result_json: {
              decision: 'approve',
              rationale: 'The memo satisfies the review checklist.',
              quality_score: 91,
              blocking: false,
              gaps: ['none'],
            },
            items_json: ['review:decision:approve', 'review:quality:91'],
            decision: 'approve',
            rationale: { rationale: 'The memo satisfies the review checklist.' },
            quality_score: 91,
            blocking: false,
            gaps: '["none"]',
          }, reviewChannel),
        ],
      });

      try {
        await harness.trigger('start review');
        await harness.trigger('finish review');
        const snapshot = await harness.snapshot();
        expect(snapshot.mode).toBe('complete');
        expect(snapshot.domain['review.result.rationale']).toBe('The memo satisfies the review checklist.');
      } finally {
        await harness.close();
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

function contractRuntimeDomain(): Record<string, unknown> {
  return {
    'program.slug': 'contract-runtime',
    'program.name': 'Contract Runtime',
    'program.target_dir': '/tmp/contract-runtime',
    'program.design_path': 'design',
    'intake.purpose': 'Review one memo with typed reasoning and complete.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'review' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'review', trigger: 'started', guard_field: 'intake.started' },
      { from: 'review', to: 'complete', trigger: 'reviewed', guard_field: 'review.done' },
    ]),
    'intake.delegation_json': JSON.stringify({ review: { kind: 'llm-reasoning' } }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'review.done' }),
  };
}

function reviewContract(): ReasoningStageContract {
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'review',
    reasoning_prompt: [
      'Review the submitted memo against the original request and decide whether it can be approved. Use only facts',
      'visible in the current projected state, explain the evidence for the decision, score the memo quality, state',
      'whether any issue blocks approval, and list the concrete gaps that remain after the review.',
    ].join(' '),
    result_schema: {
      fields: [
        { name: 'decision', type: 'enum', description: 'The review decision.', enum_values: ['approve', 'request_revision'] },
        { name: 'rationale', type: 'string', description: 'Evidence-backed rationale for the review decision.' },
        { name: 'quality_score', type: 'number', description: 'Overall memo quality from 0 to 100.' },
        { name: 'blocking', type: 'boolean', description: 'Whether any issue blocks approval.' },
        { name: 'gaps', type: 'string_array', description: 'Concrete gaps found during review.' },
      ],
      allow_extra_fields: true,
    },
    items_schema: {
      templates: ['review:decision:<decision>', 'review:quality:<quality_score>'],
      description: 'Key:value item strings for the review judgment.',
    },
    canned_example: {
      result: {
        decision: 'approve',
        rationale: 'The memo satisfies the requested review checklist.',
        quality_score: 91,
        blocking: false,
        gaps: ['none'],
      },
      items: ['review:decision:approve', 'review:quality:91'],
    },
    contract_source: 'meta_llm',
  };
}

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  return loadRenderedGeneratedProgramEntry(targetDir, 'contract-runtime');
}

function effect(name: string, payload: Record<string, unknown>, channel: string): TestHarnessAuthorResponse {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}
