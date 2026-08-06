import type { GovernedConstructKind } from './governance-gate.js';

export type PrimitiveStatus = 'active_ask' | 'landed' | 'unavailable';

export interface EnginePrimitiveEntry {
  computation_class: GovernedConstructKind;
  primitive_name: string;
  status: PrimitiveStatus;
  request_ref: string;
  since_engine_version?: string;
}

export const ENGINE_PRIMITIVE_REGISTRY: readonly EnginePrimitiveEntry[] = [
  {
    computation_class: 'compute_dedup',
    primitive_name: 'keyed_idempotent_collection',
    status: 'active_ask',
    request_ref: 'docs/curator-requests/2026-08-06-keyed-idempotent-collection.md',
  },
  {
    computation_class: 'domain_shape_branch',
    primitive_name: 'completion_predicate',
    status: 'active_ask',
    request_ref: 'docs/curator-requests/2026-08-06-completion-predicate.md',
  },
] as const;

export function primitiveForConstruct(kind: GovernedConstructKind): EnginePrimitiveEntry | undefined {
  return ENGINE_PRIMITIVE_REGISTRY.find((entry) => entry.computation_class === kind);
}
