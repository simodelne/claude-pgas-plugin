import { describe, it, expect } from 'vitest';
import {
  assertSynthesizableCapabilities,
  assertSynthesizableCapabilitiesForPrimitiveRegistry,
  detectRequestedCapabilities,
} from '../../src/foundry-program/capability-registry.js';
import { ENGINE_PRIMITIVE_REGISTRY } from '../../src/foundry-program/engine-primitive-registry.js';

describe('governance refusal for not-yet-landed primitives', () => {
  it('refuses a domain requiring keyed dedup/persist (pending keyed/idempotent-collection)', () => {
    const input = { purpose: 'Deduplicate and upsert extracted leads across sessions by email into the store.',
      extraText: 'dedupe by email; idempotent upsert; keyed collection' };
    expect(() => assertSynthesizableCapabilities(input)).toThrow();
    const demands = detectRequestedCapabilities(input).map((d) => d.capability);
    expect(demands).toContain('governed_compute_pending_primitive');
  });
  it('does not refuse a domain with no not-yet-declarable computation', () => {
    const input = { purpose: 'Summarize an uploaded memo and export it as a DOCX.', extraText: 'summarize; docx export' };
    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
  });
  it('derives pending-primitive refusal from the active registry set via a test seam', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'domain_shape_branch'
      ? { ...entry, foundry_enforcement: 'active' as const }
      : entry);
    const input = {
      purpose: 'Declare a completion guard: every item status field equals approved before continuing.',
      extraText: 'completion_guard all_items_field_eq all items status equals approved',
    };

    expect(() => assertSynthesizableCapabilities(input)).not.toThrow();
    expect(() => assertSynthesizableCapabilitiesForPrimitiveRegistry(input, synthetic)).toThrow();
  });
});
