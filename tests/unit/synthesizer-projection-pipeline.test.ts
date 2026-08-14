import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { deriveFromViewProfile } from '@simodelne/pgas-server/plugin.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

describe('synthesizer projection finalization pipeline', () => {
  it('runs confirmation-loop projection finalization once in the projection mutator order', () => {
    const source = readFileSync('src/foundry-program/synthesizer.ts', 'utf8');

    expect(projectionFinalizationCalls(source)).toEqual([
      'applyCollectionLifecycleProjection',
      'applyConfirmationLoopProjection',
      'applyDocumentsProjection',
      'applyDelegationProjection',
      'applyScaleSafeProjectionPolicy',
      'removeExportDecisionOnlyStageEntries',
    ]);
  });

  it('attaches view sections for existing-repo typed stage result fields without serializing a YAML view block', () => {
    const artifact = synthesizeProgramSpecFromDomain(feeViewDomain(), { targetKind: 'existing_repo' });
    const parsed = load(artifact.spec_yaml) as {
      view?: Array<{ key: string; from: string; label?: string; format?: string }>;
    };

    expect(parsed.view).toBeUndefined();
    expect(artifact.registration_ts).toContain('const VIEW_PROFILE');
    expect(artifact.registration_ts).toContain('loadSpecWithPatterns(specPath)');
    expect(artifact.registration_ts).toContain("{ key: 'fee_modelling_hourly_total', from: 'fee_modelling.result.hourly_total', label: 'Fee Modelling Hourly Total' }");
    expect(artifact.registration_ts).toContain("{ key: 'fee_modelling_fixed_quote', from: 'fee_modelling.result.fixed_quote', label: 'Fee Modelling Fixed Quote' }");
    expect(artifact.registration_ts).toContain("{ key: 'fee_modelling_currency', from: 'fee_modelling.result.currency', label: 'Fee Modelling Currency' }");
    expect(artifact.registration_ts).not.toContain('pricing_cards');
    expect(artifact.registration_ts).not.toContain('workspace_checkpoints');
    expect(artifact.registration_ts).not.toContain('status_banner');

    const derived = deriveFromViewProfile(new Map<string, unknown>([
      ['fee_modelling.result.hourly_total', 1250],
      ['fee_modelling.result.fixed_quote', 4800],
      ['fee_modelling.result.currency', 'USD'],
    ]), {
      sections: [
        { key: 'fee_modelling_hourly_total', from: 'fee_modelling.result.hourly_total', label: 'Fee Modelling Hourly Total' },
        { key: 'fee_modelling_fixed_quote', from: 'fee_modelling.result.fixed_quote', label: 'Fee Modelling Fixed Quote' },
        { key: 'fee_modelling_currency', from: 'fee_modelling.result.currency', label: 'Fee Modelling Currency' },
      ],
    });
    expect(derived.fee_modelling_hourly_total).toBe(1250);
    expect(derived.fee_modelling_fixed_quote).toBe(4800);
    expect(derived.fee_modelling_currency).toBe('USD');
  });
});

function feeViewDomain(): Record<string, unknown> {
  return {
    'program.slug': 'fee-proposal-drafter',
    'program.name': 'Fee Proposal Drafter',
    'program.target_dir': '/tmp/fee-proposal-drafter',
    'program.design_path': 'design',
    'intake.purpose': 'Prepare professional services fee proposals with parameterized fee modelling.',
    'intake.entry_channel': 'frontend_intake',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'fee_modelling',
        domain_spec: {
          reads: ['inputs.initial_frontend_intake.rate_card'],
          produces: {
            result_json: {
              stage: 'string',
              hourly_total: 'number',
              fixed_quote: 'number',
              currency: 'string',
            },
            items_json: ['fixed_quote:<fixed_quote>'],
          },
          rules: ['Compute hourly and fixed quote values from the intake rate card.'],
          invariants: ['result_json.stage must equal fee_modelling.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'fee_modelling', trigger: 'started', guard_field: 'intake.started' },
      { from: 'fee_modelling', to: 'complete', trigger: 'modelled', guard_field: 'fee_modelling.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({ fee_modelling: { kind: 'pure-compute' } }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'fee_modelling.ready' }),
  };
}

function projectionFinalizationCalls(source: string): string[] {
  const file = ts.createSourceFile('synthesizer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const targetCalls = new Set([
    'applyCollectionLifecycleProjection',
    'applyConfirmationLoopProjection',
    'applyDocumentsProjection',
    'applyDelegationProjection',
    'applyScaleSafeProjectionPolicy',
    'removeExportDecisionOnlyStageEntries',
  ]);
  const synthesize = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'synthesizeProgramSpecFromDomain');

  expect(synthesize?.body).toBeDefined();

  const calls: string[] = [];
  let inProjectionFinalization = false;
  for (const statement of synthesize!.body!.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === 'projection')) {
      inProjectionFinalization = true;
      continue;
    }
    if (!inProjectionFinalization) {
      continue;
    }
    if (isSpecProjectionAssignment(statement)) {
      break;
    }
    collectTargetCalls(statement, targetCalls, calls);
  }

  return calls;
}

function isSpecProjectionAssignment(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
    return false;
  }
  const { left, operatorToken } = statement.expression;
  return operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === 'spec' &&
    left.name.text === 'projection';
}

function collectTargetCalls(node: ts.Node, targetCalls: Set<string>, calls: string[]): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && targetCalls.has(node.expression.text)) {
    calls.push(node.expression.text);
  }
  ts.forEachChild(node, (child) => collectTargetCalls(child, targetCalls, calls));
}
