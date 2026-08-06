import ts from 'typescript';

export type GovernedConstructKind =
  | 'domain_shape_branch'
  | 'multi_path_fallback'
  | 'compute_dedup'
  | 'compute_aggregate'
  | 'compute_score'
  | 'compute_sort'
  | 'adhoc_validation_throw'
  | 'silent_catch'
  | 'json_reshape';

export interface GovernanceFinding {
  kind: GovernedConstructKind;
  line: number;
  column: number;
  snippet: string;
}

export type GovernedArtifactKind =
  | 'stage_body' | 'reaction_handler' | 'resolver' | 'projection'
  | 'byte_generator' | 'connector' | 'server' | 'repl' | 'test';

export const UNAVOIDABLE_ARTIFACT_KINDS: ReadonlySet<GovernedArtifactKind> = new Set([
  'byte_generator',
  'connector',
  'server',
  'repl',
  'test',
]);

type CallbackExpression = ts.ArrowFunction | ts.FunctionExpression;

export function detectGovernedConstructs(sourceText: string): GovernanceFinding[] {
  const sourceFile = ts.createSourceFile('governance-gate-input.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const setVariables = collectSetVariableNames(sourceFile);
  const findings: GovernanceFinding[] = [];
  const emitted = new Set<string>();
  let domainConditionDepth = 0;

  const addFinding = (kind: GovernedConstructKind, node: ts.Node): void => {
    const start = node.getStart(sourceFile);
    const key = `${kind}:${start}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
    findings.push({
      kind,
      line: line + 1,
      column: character + 1,
      snippet: snippetForNode(sourceText, sourceFile, node),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const governed = expressionContainsDomainRead(node.expression);
      if (governed) {
        addFinding('domain_shape_branch', node);
      }
      visit(node.expression);
      if (governed) domainConditionDepth += 1;
      visit(node.thenStatement);
      if (node.elseStatement) visit(node.elseStatement);
      if (governed) domainConditionDepth -= 1;
      return;
    }

    if (ts.isSwitchStatement(node)) {
      const governed = expressionContainsDomainRead(node.expression);
      if (governed) {
        addFinding('domain_shape_branch', node);
      }
      visit(node.expression);
      if (governed) domainConditionDepth += 1;
      visit(node.caseBlock);
      if (governed) domainConditionDepth -= 1;
      return;
    }

    if (ts.isConditionalExpression(node)) {
      if (expressionContainsDomainRead(node.condition)) {
        addFinding('domain_shape_branch', node);
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isThrowStatement(node) && domainConditionDepth > 0) {
      addFinding('adhoc_validation_throw', node);
    }

    if (ts.isCatchClause(node) && isSilentCatch(node)) {
      addFinding('silent_catch', node);
    }

    if (ts.isBinaryExpression(node) && isFallbackOperator(node.operatorToken.kind) && !isNestedFallbackExpression(node)) {
      const operands = fallbackOperands(node);
      const domainOperandCount = operands.filter((operand) => isDomainMemberAccess(operand)).length;
      if (domainOperandCount >= 2) {
        addFinding('multi_path_fallback', node);
      }
    }

    if (ts.isCallExpression(node)) {
      if (isJsonParseCall(node) && node.arguments[0] && expressionContainsDomainRead(node.arguments[0])) {
        addFinding('json_reshape', node);
      }

      const methodName = callMethodName(node);
      const callback = callbackArgument(node.arguments[0]);
      if ((methodName === 'filter' || methodName === 'reduce') && callback) {
        const dedup = callbackReferencesSetMembership(callback, setVariables)
          || (methodName === 'reduce' && looksLikeUniquenessMapReduce(callback));
        if (dedup) {
          addFinding('compute_dedup', node);
        }
        if (methodName === 'reduce' && !dedup && looksLikeAggregateReduce(node, callback)) {
          addFinding('compute_aggregate', node);
        }
      }

      if (methodName === 'map' && callback && looksLikeScoreMap(callback)) {
        addFinding('compute_score', node);
      }

      if (methodName === 'sort' && callback && looksLikeSortComparator(callback)) {
        addFinding('compute_sort', node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

export interface GovernanceViolation extends GovernanceFinding {
  message: string;
}

export function fatalGovernanceViolations(
  findings: readonly GovernanceFinding[],
  artifactKind: GovernedArtifactKind,
  enforcedConstructs: ReadonlySet<GovernedConstructKind>,
): GovernanceViolation[] {
  if (UNAVOIDABLE_ARTIFACT_KINDS.has(artifactKind)) {
    return [];
  }
  return findings
    .filter((finding) => enforcedConstructs.has(finding.kind))
    .map((finding) => ({
      ...finding,
      message: messageForGovernedConstruct(finding.kind),
    }));
}

export class GovernanceRefusalError extends Error {
  readonly kind = 'governance_refusal';
  readonly violations: readonly GovernanceViolation[];

  constructor(artifact: string, violations: readonly GovernanceViolation[]) {
    const details = violations.map((violation) => `${violation.kind} at ${violation.line}:${violation.column}`).join(', ');
    super(`Governance refusal for ${artifact}: ${details}`);
    this.name = 'GovernanceRefusalError';
    this.violations = violations;
  }
}

function collectSetVariableNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && isNewSetExpression(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function isNewSetExpression(node: ts.Expression): boolean {
  const expression = unwrapExpression(node);
  return ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'Set';
}

function snippetForNode(sourceText: string, sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const snippet = sourceText.slice(start, end).trim().replace(/\s+/gu, ' ');
  if (snippet.length <= 120) {
    return snippet;
  }
  return `${snippet.slice(0, 117)}...`;
}

function isSilentCatch(node: ts.CatchClause): boolean {
  const statements = node.block.statements;
  return statements.length === 0 || statements.every((statement) => ts.isReturnStatement(statement));
}

function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken;
}

function isNestedFallbackExpression(node: ts.Expression): boolean {
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }
  return Boolean(parent && ts.isBinaryExpression(parent) && isFallbackOperator(parent.operatorToken.kind));
}

function fallbackOperands(node: ts.Expression): ts.Expression[] {
  const expression = unwrapExpression(node);
  if (ts.isBinaryExpression(expression) && isFallbackOperator(expression.operatorToken.kind)) {
    return [...fallbackOperands(expression.left), ...fallbackOperands(expression.right)];
  }
  return [expression];
}

function callbackArgument(expression: ts.Expression | undefined): CallbackExpression | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return unwrapped;
  }
  return undefined;
}

function callMethodName(node: ts.CallExpression): string | undefined {
  const expression = unwrapExpression(node.expression);
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    return staticExpressionText(expression.argumentExpression);
  }
  return undefined;
}

function isJsonParseCall(node: ts.CallExpression): boolean {
  const expression = unwrapExpression(node.expression);
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'parse'
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'JSON';
}

function callbackReferencesSetMembership(callback: CallbackExpression, setVariables: ReadonlySet<string>): boolean {
  return callbackContains(callback, (node) => {
    if (!ts.isCallExpression(node)) return false;
    const expression = unwrapExpression(node.expression);
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
      return false;
    }
    const methodName = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : staticExpressionText(expression.argumentExpression);
    if (methodName !== 'has' && methodName !== 'add') {
      return false;
    }
    const receiver = unwrapExpression(expression.expression);
    return ts.isIdentifier(receiver) && setVariables.has(receiver.text);
  });
}

function looksLikeUniquenessMapReduce(callback: CallbackExpression): boolean {
  const accumulatorName = parameterName(callback, 0);
  const itemName = parameterName(callback, 1);
  if (!accumulatorName || !itemName) {
    return false;
  }
  return callbackContains(callback, (node) => {
    if (!ts.isElementAccessExpression(node) || !node.argumentExpression) {
      return false;
    }
    return expressionRootIdentifierName(node.expression) === accumulatorName
      && expressionContainsMemberReadRootedAt(node.argumentExpression, new Set([itemName]));
  });
}

function looksLikeAggregateReduce(call: ts.CallExpression, callback: CallbackExpression): boolean {
  const initialValue = call.arguments[1];
  if (!initialValue) {
    return false;
  }
  if (ts.isNumericLiteral(unwrapExpression(initialValue))) {
    return callbackContains(callback, (node) => {
      if (ts.isBinaryExpression(node) && isArithmeticOperator(node.operatorToken.kind)) {
        return true;
      }
      return ts.isBinaryExpression(node) && isNumericAssignmentOperator(node.operatorToken.kind);
    });
  }
  const initial = unwrapExpression(initialValue);
  if (ts.isObjectLiteralExpression(initial) || ts.isArrayLiteralExpression(initial)) {
    return callbackMutatesAccumulator(callback);
  }
  return false;
}

function callbackMutatesAccumulator(callback: CallbackExpression): boolean {
  const accumulatorName = parameterName(callback, 0);
  if (!accumulatorName) {
    return false;
  }
  return callbackContains(callback, (node) => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      return expressionRootIdentifierName(node.left) === accumulatorName;
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        const methodName = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : staticExpressionText(expression.argumentExpression);
        return ['push', 'set', 'add'].includes(methodName ?? '')
          && expressionRootIdentifierName(expression.expression) === accumulatorName;
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return expressionRootIdentifierName(node.operand) === accumulatorName;
    }
    return false;
  });
}

function looksLikeScoreMap(callback: CallbackExpression): boolean {
  const computedScoreVariables = computedScoreVariableNames(callback);
  return callbackContains(callback, (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (!name || !isScoreLikeName(name)) {
        return false;
      }
      const initializer = unwrapExpression(node.initializer);
      return expressionContainsComputation(initializer)
        || (ts.isIdentifier(initializer) && computedScoreVariables.has(initializer.text));
    }
    if (ts.isShorthandPropertyAssignment(node) && isScoreLikeName(node.name.text)) {
      return computedScoreVariables.has(node.name.text);
    }
    return false;
  });
}

function computedScoreVariableNames(callback: CallbackExpression): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && isScoreLikeName(node.name.text)
      && node.initializer
      && expressionContainsComputation(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return names;
}

function isScoreLikeName(name: string): boolean {
  return /score|rank|rating|priority|weight/iu.test(name);
}

function looksLikeSortComparator(callback: CallbackExpression): boolean {
  if (callback.parameters.length < 2) {
    return false;
  }
  const leftName = parameterName(callback, 0);
  const rightName = parameterName(callback, 1);
  if (!leftName || !rightName) {
    return false;
  }
  return callbackContains(callback, (node) => {
    if (!ts.isExpression(node)) {
      return false;
    }
    return expressionContainsMemberReadRootedAt(node, new Set([leftName, rightName]));
  });
}

function callbackContains(callback: CallbackExpression, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return found;
}

function expressionContainsDomainRead(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isExpression(candidate) && isDomainMemberAccess(candidate)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function isDomainMemberAccess(node: ts.Expression): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return expression.text === 'domain' && isIdentifierReference(expression);
  }
  if (isInputDomainRoot(expression)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return isDomainMemberAccess(expression.expression);
  }
  return false;
}

function isInputDomainRoot(node: ts.Expression): boolean {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression)
      && expression.expression.text === 'input'
      && expression.name.text === 'domain';
  }
  if (ts.isElementAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression)
      && expression.expression.text === 'input'
      && staticExpressionText(expression.argumentExpression) === 'domain';
  }
  return false;
}

function expressionContainsMemberReadRootedAt(node: ts.Node, rootNames: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (
      ts.isExpression(candidate)
      && (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate))
      && rootNames.has(expressionRootIdentifierName(candidate) ?? '')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function expressionRootIdentifierName(node: ts.Node): string | undefined {
  if (!ts.isExpression(node)) {
    return undefined;
  }
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expressionRootIdentifierName(expression.expression);
  }
  return undefined;
}

function expressionContainsComputation(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(candidate) && isArithmeticOperator(candidate.operatorToken.kind)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(candidate) || ts.isConditionalExpression(candidate)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function parameterName(callback: CallbackExpression, index: number): string | undefined {
  const parameter = callback.parameters[index];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  return true;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return staticExpressionText(name.expression);
  }
  return undefined;
}

function staticExpressionText(expression: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped) || ts.isNumericLiteral(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  return undefined;
}

function unwrapExpression<T extends ts.Expression>(expression: T): ts.Expression {
  let current: ts.Expression = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.PlusToken,
    ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.AsteriskAsteriskToken,
  ].includes(kind);
}

function isNumericAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ].includes(kind);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(kind);
}

function messageForGovernedConstruct(kind: GovernedConstructKind): string {
  switch (kind) {
    case 'domain_shape_branch':
      return 'Governed construct domain_shape_branch must be engine-declared as modes + transition guards + enum_router, not imperative branching.';
    case 'multi_path_fallback':
      return 'Governed construct multi_path_fallback must be engine-declared as a single read path or projection field, not fallback domain navigation.';
    case 'compute_dedup':
      return 'Governed construct compute_dedup requires a keyed/idempotent collection engine primitive or refusal; do not emit imperative dedup logic.';
    case 'compute_aggregate':
      return 'Governed construct compute_aggregate requires an engine primitive or refusal; do not emit imperative aggregate/group logic.';
    case 'compute_score':
      return 'Governed construct compute_score requires an engine primitive or refusal; do not emit imperative score/rank logic.';
    case 'compute_sort':
      return 'Governed construct compute_sort requires an engine primitive or refusal; do not emit imperative sort/rank logic.';
    case 'adhoc_validation_throw':
      return 'Governed construct adhoc_validation_throw must be engine-declared as GK gates or transition preconditions, not runtime domain-shape throws.';
    case 'silent_catch':
      return 'Governed construct silent_catch must rely on engine gates/preconditions for reachability, not swallowed catch blocks.';
    case 'json_reshape':
      return 'Governed construct json_reshape must be engine-declared as action_map mutations (+ from_arg) and reactions, not JSON re-parse reshaping.';
  }
}
