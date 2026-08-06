import { describe, it, expect } from 'vitest';
import { assertSynthesizableCapabilities, detectRequestedCapabilities } from '../../src/foundry-program/capability-registry.js';

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
});
