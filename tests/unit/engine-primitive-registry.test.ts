import { describe, it, expect } from 'vitest';
import {
  activeEnforcedConstructs,
  ENGINE_PRIMITIVE_REGISTRY,
  primitiveForConstruct,
  refusedConstructs,
} from '../../src/foundry-program/engine-primitive-registry.js';

describe('engine-primitive-registry', () => {
  it('models convergence primitives including #844 batch-1 as landed active, with validation narrowed', () => {
    expect(ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.primitive_index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const cursor = primitiveForConstruct('iteration_cursor');
    expect(cursor).toMatchObject({
      primitive_index: 1,
      primitive_name: 'first_item_where_field_ne',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#829',
      foundry_enforcement: 'active',
      since_engine_version: '3.28.0',
    });
    expect(cursor?.build_order_note).toMatch(/adopted.*keyed_by/i);

    const completion = primitiveForConstruct('completion_guard');
    expect(completion).toMatchObject({
      primitive_index: 2,
      primitive_name: 'all_items_field_eq',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#831',
      foundry_enforcement: 'active',
      since_engine_version: '3.29.0',
    });
    expect(completion?.build_order_note).toMatch(/narrow.*completion_guard/i);

    const dedup = primitiveForConstruct('compute_dedup');
    expect(dedup).toMatchObject({
      primitive_index: 3,
      primitive_name: 'keyed_by',
      primitive_status: 'landed',
      foundry_enforcement: 'active',
      since_engine_version: '3.29.0',
    });

    expect(primitiveForConstruct('numeric_validation')).toMatchObject({
      primitive_index: 4,
      primitive_name: 'numeric_comparison_predicate',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#831',
      foundry_enforcement: 'active',
      since_engine_version: '3.30.0',
    });
    expect(primitiveForConstruct('recovery_steer')).toMatchObject({
      primitive_index: 5,
      primitive_name: 'recovery_steer',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#831',
      foundry_enforcement: 'active',
      since_engine_version: '3.30.0',
    });
    expect(primitiveForConstruct('existential_completion_guard')).toMatchObject({
      primitive_index: 6,
      primitive_name: 'any_item_field_eq',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#844',
      foundry_enforcement: 'active',
      since_engine_version: '3.32.0',
    });
    expect(primitiveForConstruct('partition_by_verdict')).toMatchObject({
      primitive_index: 7,
      primitive_name: 'items_where_field_eq',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#844',
      foundry_enforcement: 'active',
      since_engine_version: '3.32.0',
    });
    expect(primitiveForConstruct('numeric_aggregate')).toMatchObject({
      primitive_index: 8,
      primitive_name: 'sum_of',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#844',
      foundry_enforcement: 'active',
      since_engine_version: '3.32.0',
    });
    expect(primitiveForConstruct('token_coverage_validation')).toMatchObject({
      primitive_index: 9,
      primitive_name: 'FieldContainsAll',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#844',
      foundry_enforcement: 'active',
      since_engine_version: '3.32.0',
    });

    expect(primitiveForConstruct('domain_shape_branch')).toBeUndefined();
    expect(primitiveForConstruct('adhoc_validation_throw')).toBeUndefined();
    expect([...activeEnforcedConstructs()]).toEqual([
      'iteration_cursor',
      'completion_guard',
      'compute_dedup',
      'numeric_validation',
      'recovery_steer',
      'existential_completion_guard',
      'partition_by_verdict',
      'numeric_aggregate',
      'token_coverage_validation',
    ]);
    expect([...refusedConstructs()]).toEqual([]);
  });

  it('derives active and refused construct sets from registry enforcement flags', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'numeric_validation'
      ? { ...entry, primitive_status: 'asked' as const }
      : entry);

    expect([...activeEnforcedConstructs(synthetic)]).toEqual([
      'iteration_cursor',
      'completion_guard',
      'compute_dedup',
      'numeric_validation',
      'recovery_steer',
      'existential_completion_guard',
      'partition_by_verdict',
      'numeric_aggregate',
      'token_coverage_validation',
    ]);
    expect([...refusedConstructs(synthetic)]).toEqual(['numeric_validation']);
  });

  it('every entry references an existing curator-request doc path', () => {
    for (const e of ENGINE_PRIMITIVE_REGISTRY) expect(e.request_ref).toMatch(/^docs\/curator-requests\/.+\.md$/);
  });
});
