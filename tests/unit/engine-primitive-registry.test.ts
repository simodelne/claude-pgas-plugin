import { describe, it, expect } from 'vitest';
import {
  activeEnforcedConstructs,
  ENGINE_DECLARATION_AWARENESS,
  ENGINE_PRIMITIVE_REGISTRY,
  primitiveForConstruct,
  refusedConstructs,
} from '../../src/foundry-program/engine-primitive-registry.js';

describe('engine-primitive-registry', () => {
  it('models convergence primitives including #844 as landed, with narrow active enforcement', () => {
    expect(ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.primitive_index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

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
    expect(primitiveForConstruct('content_key_merge')).toMatchObject({
      primitive_index: 10,
      primitive_name: 'merge_collections',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#844',
      foundry_enforcement: 'pending',
      since_engine_version: '3.32.0',
    });
    expect(primitiveForConstruct('content_key_merge')?.build_order_note).toMatch(/register-only.*no foundry content-key merge emitter/i);
    expect(primitiveForConstruct('regex_validation')).toMatchObject({
      primitive_index: 11,
      primitive_name: 'FieldMatchesPattern/FieldNotMatchesPattern',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#862',
      foundry_enforcement: 'active',
      since_engine_version: '3.34.0',
    });
    expect(primitiveForConstruct('source_grounding_validation')).toMatchObject({
      primitive_index: 12,
      primitive_name: 'FieldSourceGrounded',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#862',
      foundry_enforcement: 'active',
      since_engine_version: '3.34.0',
    });
    expect(primitiveForConstruct('arg_schema')).toMatchObject({
      primitive_index: 13,
      primitive_name: 'arg_schema',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#891',
      foundry_enforcement: 'active',
      since_engine_version: '4.2.0',
    });
    expect(primitiveForConstruct('no_action_escape')).toMatchObject({
      primitive_index: 14,
      primitive_name: 'no_action_escapes',
      primitive_status: 'landed',
      pgas_ref: 'simodelne/pgas#889',
      foundry_enforcement: 'active',
      since_engine_version: '4.2.0',
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
      'regex_validation',
      'source_grounding_validation',
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
      'regex_validation',
      'source_grounding_validation',
    ]);
    expect([...refusedConstructs(synthetic)]).toEqual(['numeric_validation']);
  });

  it('every entry references an existing curator-request doc path', () => {
    for (const e of ENGINE_PRIMITIVE_REGISTRY) expect(e.request_ref).toMatch(/^docs\/curator-requests\/.+\.md$/);
  });

  it('tracks v4.2.0 through v4.12.3 declaration adoption status', () => {
    const awarenessByConstruct = new Map(ENGINE_DECLARATION_AWARENESS.map((entry) => [entry.construct, entry]));

    expect(awarenessByConstruct.get('action_map.arg_schema')).toMatchObject({
      status: 'emitted',
    });
    expect(awarenessByConstruct.get('Specification.no_action_escapes')).toMatchObject({
      status: 'emitted',
    });
    expect(awarenessByConstruct.get('Specification.view')).toMatchObject({
      status: 'emitted',
    });
    expect(awarenessByConstruct.get('Specification.render')).toMatchObject({
      status: 'emitted',
    });
    expect(awarenessByConstruct.get('Predicate.Always')).toMatchObject({
      status: 'available_unused',
    });
    expect(awarenessByConstruct.get('derived_paths.min_of')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('derived_paths.max_of')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('derived_paths.join_from')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('collections.invariant_require_on')).toMatchObject({
      status: 'available_unused',
    });
    expect(awarenessByConstruct.get('Mode.requires_delegations')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('DelegationMode.conversational')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('Feature.pure_strict')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('Feature.merge_collection')).toMatchObject({
      status: 'available_unused',
    });
    expect(awarenessByConstruct.get('Specification.policies')).toMatchObject({
      status: 'emitted',
    });
    expect(awarenessByConstruct.get('Specification.import')).toMatchObject({
      status: 'emitted',
    });
    expect(awarenessByConstruct.get('SpecWiringValidationOptions.blueprint')).toMatchObject({
      status: 'emitted',
    });
    expect(awarenessByConstruct.get('ObjectFanOut')).toMatchObject({
      status: 'available_unused',
    });
    expect(awarenessByConstruct.get('PGAS-L.collection')).toMatchObject({
      status: 'available_unused',
    });
    expect(awarenessByConstruct.get('EngineCapability.web_search')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('EngineCapability.document_extraction')).toMatchObject({
      status: 'adopt_backlog',
    });
    expect(awarenessByConstruct.get('registerProgramByConvention')).toMatchObject({
      status: 'emitted',
    });
  });

  it('requires backlog, available-unused, and held awareness notes', () => {
    for (const entry of ENGINE_DECLARATION_AWARENESS) {
      if (entry.status === 'emitted') continue;

      expect(entry.note.trim().length, `${entry.construct} missing awareness note`).toBeGreaterThan(0);
    }
  });
});
