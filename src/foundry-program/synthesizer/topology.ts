import {
  guardFieldForTransition,
  normalizeGuardField,
  safeIdentifier,
  unique,
} from './shared.js';
import type {
  Completion,
  IntakeTransition,
  MutableRecord,
  PlannedTransitionAction,
  StageDomainSpec,
  TransitionAction,
} from './types.js';
import type { ClassifiedStage } from '../stage-classifier.js';
import { reasoningFieldSummary, type ReasoningStageContract } from '../reasoning-contract.js';

export function guardFieldsBySourceMode(transitionActions: TransitionAction[]): Map<string, string[]> {
  const fieldsByMode = new Map<string, string[]>();
  for (const transition of transitionActions) {
    const guardField = transition.guardField;
    if (!guardField) continue;
    fieldsByMode.set(transition.source, unique([...(fieldsByMode.get(transition.source) ?? []), guardField]));
  }
  return fieldsByMode;
}

export function planTransitionActions(
  transitions: IntakeTransition[],
  completion: Completion,
  firstMode: string,
): PlannedTransitionAction[] {
  const grouped = new Map<string, IntakeTransition[]>();
  for (const transition of transitions) {
    grouped.set(transition.from, [...(grouped.get(transition.from) ?? []), transition]);
  }

  const usedActionNames = new Set<string>();
  const planned = new Map<IntakeTransition, PlannedTransitionAction>();

  for (const [source, siblingTransitions] of grouped) {
    const isBranch = siblingTransitions.length > 1;
    const usedGuardFields = new Set<string>();
    const completionGuard = siblingTransitions.some((sibling) => sibling.to === completion.final_stage)
      ? normalizeGuardField(completion.guard_field)
      : undefined;

    for (const transition of siblingTransitions) {
      const baseGuard = guardFieldForTransition(transition, completion);
      const preservesCompletionGuard = transition.to === completion.final_stage && baseGuard === completionGuard;
      const guardField = isBranch && (
        !baseGuard ||
        usedGuardFields.has(baseGuard) ||
        (!preservesCompletionGuard && baseGuard === completionGuard)
      )
        ? uniqueGuardField(`${source}.${safeIdentifier(transition.to)}_selected`, usedGuardFields)
        : baseGuard;
      if (guardField) {
        usedGuardFields.add(guardField);
      }

      planned.set(transition, {
        name: uniqueActionName(actionNameForTransition(transition, firstMode, isBranch), usedActionNames),
        source,
        target: transition.to,
        ...(guardField ? { guardField } : {}),
      });
    }
  }

  return transitions.map((transition) => {
    const action = planned.get(transition);
    if (!action) {
      throw new Error(`missing planned action for transition ${transition.from}->${transition.to}`);
    }
    return action;
  });
}

export function decorateTransitionActions(
  actions: PlannedTransitionAction[],
  stageClassificationBySlug: Map<string, ClassifiedStage>,
): TransitionAction[] {
  return actions.map((action) => {
    const classification = stageClassificationBySlug.get(action.source);
    return {
      ...action,
      archetype: classification?.archetype ?? 'pure-compute',
      ...(classification?.adapter_kind ? { adapter_kind: classification.adapter_kind } : {}),
      ...(classification?.export_kind ? { export_kind: classification.export_kind } : {}),
      ...(classification?.integration_name ? { integration_name: classification.integration_name } : {}),
      ...(classification?.integration_import ? { integration_import: classification.integration_import } : {}),
      ...(classification?.integration_method ? { integration_method: classification.integration_method } : {}),
      ...(classification?.integration_gap ? { integration_gap: true } : {}),
      ...(classification?.audit_note ? { audit_note: classification.audit_note } : {}),
    };
  });
}

export function actionsBySourceMode(actions: TransitionAction[]): Map<string, TransitionAction[]> {
  const actionsBySource = new Map<string, TransitionAction[]>();
  for (const action of actions) {
    actionsBySource.set(action.source, [...(actionsBySource.get(action.source) ?? []), action]);
  }
  return actionsBySource;
}

export function exportTransitionActions(actions: TransitionAction[]): TransitionAction[] {
  return actions.filter(isExportTransitionAction);
}

export function isExportTransitionAction(action: TransitionAction): boolean {
  return action.export_kind === 'export_docx' || action.export_kind === 'export_html';
}

export function isConversationalHubTransitionAction(action: TransitionAction): boolean {
  return action.archetype === 'conversational-hub';
}

function transitionActionHasResultPath(
  action: TransitionAction,
  firstMode: string,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
): boolean {
  if (action.source === firstMode || isConversationalHubTransitionAction(action)) {
    return false;
  }
  return action.archetype !== 'llm-reasoning' || reasoningContractsBySlug.has(action.source);
}

export function transitionActionChannel(
  action: TransitionAction,
  firstMode: string,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
): 'stage_output' | 'widget_output' {
  return transitionActionHasResultPath(action, firstMode, reasoningContractsBySlug)
    ? 'stage_output'
    : 'widget_output';
}

export function exportRenderHookActionName(stage: string): string {
  return `render_${safeIdentifier(stage)}_export`;
}

export function exportRenderPendingReactionName(stage: string): string {
  return `mark_${safeIdentifier(stage)}_export_render_pending`;
}

export function exportRenderPendingPath(stage: string): string {
  return `${stage}.render_pending`;
}

export function outputProjectionFields(
  modeName: string,
  stageClassificationBySlug: Map<string, ClassifiedStage>,
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
  flatMirrorStages: ReadonlySet<string>,
): string[] {
  const classification = stageClassificationBySlug.get(modeName);
  if (classification?.archetype === 'conversational-hub') {
    return [];
  }
  if (classification?.archetype !== 'llm-reasoning') {
    return flatMirrorStages.has(modeName)
      ? [`${modeName}.output`, `${modeName}.result_json`, `${modeName}.items_json`]
      : [`${modeName}.output`];
  }
  return reasoningContractsBySlug.has(modeName)
    ? [`${modeName}.result_json`, `${modeName}.items_json`, `${modeName}.result`]
    : [`${modeName}.result_json`, `${modeName}.items_json`];
}

export function actionMapEntryFor(
  action: TransitionAction,
  firstMode: string,
  domainSpec?: StageDomainSpec,
  reasoningContract?: ReasoningStageContract,
): MutableRecord {
  const isBootstrap = action.source === firstMode;
  const contract = !isBootstrap && action.archetype === 'llm-reasoning' ? reasoningContract : undefined;
  const isContractedReasoningStage = contract !== undefined;
  const isHubAction = isConversationalHubTransitionAction(action);
  const isResultPathStage = transitionActionHasResultPath(
    action,
    firstMode,
    reasoningContract ? new Map([[action.source, reasoningContract]]) : new Map(),
  );
  const isDeterministicResultPathStage = !isBootstrap && action.archetype !== 'llm-reasoning' && !isHubAction;
  const domainSpecForDescription = domainSpec && isDeterministicResultPathStage
    ? deterministicActionDomainSpecDescription(domainSpec)
    : domainSpec;
  const domainSpecDescription = domainSpecForDescription
    ? ` Author-provided domain spec for ${action.source}: ${JSON.stringify(domainSpecForDescription)}`
    : '';
  const deterministicResultPathInstruction = isDeterministicResultPathStage
    ? ' This is a deterministic wrapper: emit this action with an EMPTY payload. Do NOT author result_json, items_json, bytes, or any output fields; the wrapper computes and stores the result deterministically.'
    : '';
  const reasoningEnvelopeDescription = isContractedReasoningStage
    ? ' The generated handler accepts result_json as either a native JSON object or a JSON string, and items_json as either a native JSON array or a JSON string; it canonicalizes both into JSON strings at the stage output path.'
    : '';
  const compositeReasoningMutations = !isBootstrap && action.archetype === 'llm-reasoning' && !isContractedReasoningStage
    ? [
        { op: 'MSet', path: `${action.source}.result_json`, from_arg: 'result_json' },
        { op: 'MSet', path: `${action.source}.items_json`, from_arg: 'items_json' },
      ]
    : [];
  const tolerantReasoningCaptureMutations = isContractedReasoningStage
    ? [
        { op: 'MSet', path: `${action.source}.raw_result_json`, value: {}, from_arg: 'result_json' },
        { op: 'MSet', path: `${action.source}.raw_items_json`, value: [], from_arg: 'items_json' },
      ]
    : [];
  const mutations = [
    ...(action.guardField ? [{ op: 'MSet', path: action.guardField, value: true }] : []),
    ...compositeReasoningMutations,
    ...tolerantReasoningCaptureMutations,
    ...(isBootstrap || action.archetype !== 'llm-reasoning' ? [] : [
      ...(contract ? contract.result_schema.fields.map((field) => ({
        op: 'MSet',
        path: `${action.source}.raw_result_fields.${field.name}`,
        from_arg: field.name,
      })) : []),
    ]),
  ];

  return {
    description: isBootstrap
      ? `Start ${action.source} and advance exactly one hop to ${action.target}.`
      : isHubAction
        ? action.source === action.target
          ? `Stay in conversational hub ${action.source}; use only for an explicit no-op/stay decision.`
          : `Choose the ${action.target} branch from conversational hub ${action.source}. Non-terminal hub tools should omit this action so the session remains in ${action.source}.${domainSpecDescription}`
      : action.archetype === 'llm-reasoning'
        ? `Record runtime LLM reasoning output for ${action.source} and advance exactly one hop to ${action.target}.${domainSpecDescription}${reasoningEnvelopeDescription}`
        : `Run deterministic ${action.archetype} wrapper for ${action.source} and advance exactly one hop to ${action.target}.${domainSpecDescription}${deterministicResultPathInstruction}`,
    ...(isBootstrap || action.archetype !== 'llm-reasoning' ? {} : {
      arg_descriptions: contract
        ? {
            result_json: `Optional tolerant result for the ${action.source} LLM reasoning stage. May be a native JSON object or a JSON string encoding an object containing at least: ${contract.result_schema.fields.map(reasoningFieldSummary).join(', ')}. Additional keys are allowed.${domainSpecDescription}`,
            items_json: `Optional tolerant item list produced by the ${action.source} LLM reasoning stage. May be a native JSON array or a JSON string array matching the templates: ${contract.items_schema.templates.join(', ')}.${domainSpecDescription}`,
            ...Object.fromEntries(contract.result_schema.fields.map((field) => [
              field.name,
              `${field.description}${field.type === 'enum' ? ` One of: ${(field.enum_values ?? []).join(' | ')}.` : ''}${field.type === 'string_array' ? ' Provide the value as a JSON array string.' : ''}`,
            ])),
          }
        : {
            result_json: `JSON string result for the ${action.source} LLM reasoning stage.${domainSpecDescription}`,
            items_json: `JSON string array of item ids or summaries produced by the ${action.source} LLM reasoning stage.${domainSpecDescription}`,
          },
    }),
    ...(isResultPathStage ? { result_path: `${action.source}.output` } : {}),
    mutations,
    channel: transitionActionChannel(
      action,
      firstMode,
      reasoningContract ? new Map([[action.source, reasoningContract]]) : new Map(),
    ),
  };
}

function deterministicActionDomainSpecDescription(
  domainSpec: StageDomainSpec,
): Pick<StageDomainSpec, 'reads' | 'rules' | 'invariants'> {
  return {
    reads: domainSpec.reads,
    rules: domainSpec.rules,
    invariants: domainSpec.invariants,
  };
}

function actionNameForTransition(transition: IntakeTransition, firstMode: string, isBranch: boolean): string {
  if (transition.from === firstMode && !isBranch) {
    return 'begin_work';
  }
  if (isBranch) {
    return `advance_${safeIdentifier(transition.from)}_to_${safeIdentifier(transition.to)}`;
  }
  return `complete_${safeIdentifier(transition.from)}`;
}

function uniqueActionName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  const name = `${base}_${suffix}`;
  used.add(name);
  return name;
}

function uniqueGuardField(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  const field = `${base}_${suffix}`;
  used.add(field);
  return field;
}
