import { describe, it, expect } from 'vitest';
import {
  activeEnforcedConstructs,
  ENGINE_PRIMITIVE_REGISTRY,
  primitiveForConstruct,
  refusedConstructs,
} from '../../src/foundry-program/engine-primitive-registry.js';

describe('engine-primitive-registry', () => {
  it('models cursor and completion as landed active primitives without broad domain-branch enforcement', () => {
    expect(ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.primitive_index)).toEqual([1, 2, 3, 4, 5]);

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

    expect(primitiveForConstruct('domain_shape_branch')).toBeUndefined();
    expect([...activeEnforcedConstructs()]).toEqual(['iteration_cursor', 'completion_guard', 'compute_dedup']);
    expect([...refusedConstructs()]).toEqual([]);
  });

  it('derives active and refused construct sets from registry enforcement flags', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'adhoc_validation_throw'
      ? { ...entry, foundry_enforcement: 'active' as const }
      : entry);

    expect([...activeEnforcedConstructs(synthetic)]).toEqual([
      'iteration_cursor',
      'completion_guard',
      'compute_dedup',
      'adhoc_validation_throw',
    ]);
    expect([...refusedConstructs(synthetic)]).toEqual(['adhoc_validation_throw']);
  });

  it('every entry references an existing curator-request doc path', () => {
    for (const e of ENGINE_PRIMITIVE_REGISTRY) expect(e.request_ref).toMatch(/^docs\/curator-requests\/.+\.md$/);
  });
});
