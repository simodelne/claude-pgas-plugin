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
  it('derives pending-primitive refusal from the active registry set via a test seam', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'adhoc_validation_throw'
      ? { ...entry, foundry_enforcement: 'active' as const }
      : entry);
    const input = {
      purpose: 'Declare a content invariant before finalization.',
      extraText: 'content_invariant_predicate authored-field invariant finalization predicate',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(() => assertSynthesizableCapabilitiesForPrimitiveRegistry(input, synthetic)).toThrow();
  });
});
