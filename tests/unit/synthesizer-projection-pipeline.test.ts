import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
});

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
