import { describe, it, expect } from 'vitest';
import {
  assertSynthesizableCapabilities,
  assertSynthesizableCapabilitiesForPrimitiveRegistry,
  detectRequestedCapabilities,
} from '../../src/foundry-program/capability-registry.js';
import { ENGINE_PRIMITIVE_REGISTRY } from '../../src/foundry-program/engine-primitive-registry.js';

describe('governance refusal for not-yet-landed primitives', () => {
  it('synthesizes a domain requiring keyed dedup/persist now that keyed_by landed', () => {
    const input = { purpose: 'Deduplicate and upsert extracted leads across sessions by email into the store.',
      extraText: 'dedupe by email; idempotent upsert; keyed collection' };
    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    const demands = detectRequestedCapabilities(input).map((d) => d.capability);
    expect(demands).not.toContain('governed_compute_pending_primitive');
    expect(demands).toContain('cross_session_persistence');
  });
  it('does not refuse a domain with no not-yet-declarable computation', () => {
    const input = { purpose: 'Summarize an uploaded memo and export it as a DOCX.', extraText: 'summarize; docx export' };
    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
  });
  it('does not refuse landed cursor or completion primitive requests', () => {
    const input = {
      purpose: 'Use an iteration_cursor and completion_guard over work items.',
      extraText: 'first_item_where_field_ne over items and all_items_field_eq when every item status equals approved',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(detectRequestedCapabilities(input).map((d) => d.capability)).not.toContain('governed_compute_pending_primitive');
  });
  it('does not refuse landed numeric-validation or recovery-steer primitive requests', () => {
    const input = {
      purpose: 'Declare numeric validation and mode-scoped recovery steering for the generated workflow.',
      extraText: 'numeric comparison predicate FieldGreaterOrEqual for char_count >= min_chars plus recovery_steer guidance when a typed flag is true',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(detectRequestedCapabilities(input).map((d) => d.capability)).not.toContain('governed_compute_pending_primitive');
  });
  it('does not refuse landed #844 primitive requests', () => {
    const input = {
      purpose: 'Declare existential completion, partition buckets, numeric aggregation, and token coverage validation.',
      extraText: 'any_item_field_eq for a proposed item, items_where_field_eq accepted/rejected buckets, sum_of hours feeding FieldGreaterOrEqual, FieldContainsAll required tokens',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(detectRequestedCapabilities(input).map((d) => d.capability)).not.toContain('governed_compute_pending_primitive');
  });
  it('derives pending-primitive refusal from the active registry set via a test seam', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'numeric_validation'
      ? { ...entry, primitive_status: 'asked' as const }
      : entry);
    const input = {
      purpose: 'Declare a numeric validation before finalization.',
      extraText: 'numeric comparison predicate finalization predicate FieldGreaterOrEqual char_count min_chars',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(() => assertSynthesizableCapabilitiesForPrimitiveRegistry(input, synthetic)).toThrow();
  });
  it('derives #844 pending-primitive refusal from the active registry set via a test seam', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => [
      'existential_completion_guard',
      'partition_by_verdict',
      'numeric_aggregate',
      'token_coverage_validation',
    ].includes(entry.computation_class)
      ? { ...entry, primitive_status: 'asked' as const }
      : entry);
    const input = {
      purpose: 'Declare the #844 batch-1 primitives.',
      extraText: 'any_item_field_eq items_where_field_eq sum_of FieldContainsAll required token coverage buckets',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(() => assertSynthesizableCapabilitiesForPrimitiveRegistry(input, synthetic)).toThrow();
  });
  it('does not refuse landed #862 regex and source-grounding primitive requests', () => {
    const input = {
      purpose: 'Declare regex validation and anti-fabrication source grounding for extracted document fields.',
      extraText: 'FieldMatchesPattern FieldNotMatchesPattern email format pattern source grounded FieldSourceGrounded anti-fabrication extracted names must appear in source text',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(detectRequestedCapabilities(input).map((d) => d.capability)).not.toContain('governed_compute_pending_primitive');
  });
  it('derives #862 pending-primitive refusal from the active registry set via a test seam', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => [
      'regex_validation',
      'source_grounding_validation',
    ].includes(entry.computation_class)
      ? { ...entry, primitive_status: 'asked' as const }
      : entry);
    const input = {
      purpose: 'Declare the #862 validation predicates.',
      extraText: 'FieldMatchesPattern FieldNotMatchesPattern regex pattern validation FieldSourceGrounded source grounded anti-fabrication',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(() => assertSynthesizableCapabilitiesForPrimitiveRegistry(input, synthetic)).toThrow();
  });
  it('derives recovery-steer pending-primitive refusal from the active registry set via a test seam', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'recovery_steer'
      ? { ...entry, primitive_status: 'asked' as const }
      : entry);
    const input = {
      purpose: 'Declare mode-scoped recovery steering.',
      extraText: 'recovery_steer guidance string emitted when a typed flag requires recovery',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(() => assertSynthesizableCapabilitiesForPrimitiveRegistry(input, synthetic)).toThrow();
  });
});
