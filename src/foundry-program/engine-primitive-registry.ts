import type { GovernedConstructKind } from './governance-gate.js';

export type PrimitiveIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type PrimitiveStatus = 'landed' | 'shipped' | 'building' | 'asked';
export type FoundryEnforcement = 'active' | 'pending';

export interface EnginePrimitiveEntry {
  readonly computation_class: GovernedConstructKind;
  readonly primitive_index: PrimitiveIndex;
  readonly primitive_name: string;
  readonly primitive_status: PrimitiveStatus;
  readonly pgas_ref: string;
  readonly request_ref: string;
  readonly foundry_enforcement: FoundryEnforcement;
  readonly since_engine_version?: string;
  readonly build_order_note?: string;
}

const CONVERGENCE_ALIGNMENT_REQUEST =
  'docs/curator-requests/2026-08-07-declarative-consumer-convergence-alignment.md';

export const ENGINE_PRIMITIVE_REGISTRY: readonly EnginePrimitiveEntry[] = [
  {
    computation_class: 'iteration_cursor',
    primitive_index: 1,
    primitive_name: 'first_item_where_field_ne',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#829',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.28.0',
    build_order_note: 'Adopted after #3 keyed_by landed; confirmation-loop indexed collections keep status and terminal marker on the scanned collection.',
  },
  {
    computation_class: 'completion_guard',
    primitive_index: 2,
    primitive_name: 'all_items_field_eq',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831',
    request_ref: 'docs/curator-requests/2026-08-06-completion-predicate.md',
    foundry_enforcement: 'active',
    since_engine_version: '3.29.0',
    build_order_note: 'Narrow completion_guard class split from broad domain_shape_branch to avoid refusing ordinary domain branching while enforcing all-items completion equality.',
  },
  {
    computation_class: 'compute_dedup',
    primitive_index: 3,
    primitive_name: 'keyed_by',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831 roadmap',
    request_ref: 'docs/curator-requests/2026-08-06-keyed-idempotent-collection.md',
    foundry_enforcement: 'active',
    since_engine_version: '3.29.0',
    build_order_note: 'Linchpin primitive; foundry keeps compute_dedup enforcement active and emits keyed_collections instead of imperative dedup.',
  },
  {
    computation_class: 'numeric_validation',
    primitive_index: 4,
    primitive_name: 'numeric_comparison_predicate',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.30.0',
    build_order_note: 'Narrowed from broad adhoc_validation_throw to numeric threshold/coherence validation only; structural validation remains detected but has no landed primitive.',
  },
  {
    computation_class: 'recovery_steer',
    primitive_index: 5,
    primitive_name: 'recovery_steer',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.30.0',
    build_order_note: 'Confirmation-loop per-round recovery guidance now emits recovery_steers declarations instead of static typed-flag guidance emitters.',
  },
  {
    computation_class: 'existential_completion_guard',
    primitive_index: 6,
    primitive_name: 'any_item_field_eq',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow existential completion flag over collection field equality; emitted from the same derived-path helper as all_items_field_eq.',
  },
  {
    computation_class: 'partition_by_verdict',
    primitive_index: 7,
    primitive_name: 'items_where_field_eq',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow partition-by-verdict buckets for approval flows; broad filter/group reshaping remains outside this class.',
  },
  {
    computation_class: 'numeric_aggregate',
    primitive_index: 8,
    primitive_name: 'sum_of',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow numeric sum aggregation over indexed collection item fields; non-sum grouping/aggregation remains refused as compute_aggregate.',
  },
  {
    computation_class: 'token_coverage_validation',
    primitive_index: 9,
    primitive_name: 'FieldContainsAll',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow authored-text required-token coverage validation; other structural validation throws remain outside this primitive.',
  },
] as const;

export function primitiveForConstruct(kind: GovernedConstructKind): EnginePrimitiveEntry | undefined {
  return ENGINE_PRIMITIVE_REGISTRY.find((entry) => entry.computation_class === kind);
}

export function activeEnforcedConstructs(
  registry: readonly EnginePrimitiveEntry[] = ENGINE_PRIMITIVE_REGISTRY,
): ReadonlySet<GovernedConstructKind> {
  return new Set(
    registry
      .filter((entry) => entry.foundry_enforcement === 'active')
      .map((entry) => entry.computation_class),
  );
}

export function refusedConstructs(
  registry: readonly EnginePrimitiveEntry[] = ENGINE_PRIMITIVE_REGISTRY,
): ReadonlySet<GovernedConstructKind> {
  return new Set(
    registry
      .filter((entry) => entry.foundry_enforcement === 'active' && entry.primitive_status !== 'landed')
      .map((entry) => entry.computation_class),
  );
}
