import { describe, it, expect } from 'vitest';
import {
  activeEnforcedConstructs,
  ENGINE_PRIMITIVE_REGISTRY,
  primitiveForConstruct,
  refusedConstructs,
} from '../../src/foundry-program/engine-primitive-registry.js';

describe('engine-primitive-registry', () => {
  it('models the full pgas 5-primitive family with only compute_dedup active', () => {
    expect(ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.primitive_index)).toEqual([1, 2, 3, 4, 5]);

    const cursor = primitiveForConstruct('iteration_cursor');
    expect(cursor).toMatchObject({
      primitive_index: 1,
      primitive_name: 'first_item_where_field_ne',
      primitive_status: 'shipped',
      pgas_ref: 'simodelne/pgas#829',
      foundry_enforcement: 'pending',
    });
    expect(cursor?.build_order_note).toMatch(/gated on #3/i);

    const completion = primitiveForConstruct('domain_shape_branch');
    expect(completion).toMatchObject({
      primitive_index: 2,
      primitive_name: 'all_items_field_eq',
      primitive_status: 'building',
      foundry_enforcement: 'pending',
    });
    expect(completion?.build_order_note).toMatch(/completion_guard|domain_shape_branch/i);

    const dedup = primitiveForConstruct('compute_dedup');
    expect(dedup).toMatchObject({
      primitive_index: 3,
      primitive_name: 'keyed_by',
      primitive_status: 'building',
      foundry_enforcement: 'active',
    });

    expect(primitiveForConstruct('adhoc_validation_throw')).toMatchObject({
      primitive_index: 4,
      primitive_name: 'content_invariant_predicate',
      primitive_status: 'asked',
      pgas_ref: 'simodelne/pgas#831',
      foundry_enforcement: 'pending',
    });
    expect(primitiveForConstruct('recovery_steer')).toMatchObject({
      primitive_index: 5,
      primitive_name: 'recovery_steer',
      primitive_status: 'asked',
      pgas_ref: 'simodelne/pgas#831',
      foundry_enforcement: 'pending',
    });

    expect([...activeEnforcedConstructs()]).toEqual(['compute_dedup']);
    expect([...refusedConstructs()]).toEqual(['compute_dedup']);
  });

  it('derives active and refused construct sets from registry enforcement flags', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'domain_shape_branch'
      ? { ...entry, foundry_enforcement: 'active' as const }
      : entry);

    expect([...activeEnforcedConstructs(synthetic)]).toEqual(['domain_shape_branch', 'compute_dedup']);
    expect([...refusedConstructs(synthetic)]).toEqual(['domain_shape_branch', 'compute_dedup']);
  });

  it('every entry references an existing curator-request doc path', () => {
    for (const e of ENGINE_PRIMITIVE_REGISTRY) expect(e.request_ref).toMatch(/^docs\/curator-requests\/.+\.md$/);
  });
});
