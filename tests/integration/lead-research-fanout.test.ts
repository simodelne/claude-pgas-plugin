import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { leadResearchDomain } from '../fixtures/lead-research-domain.js';

interface ParsedSpec {
  schema: Record<string, string>;
  projection: Record<string, { include: string[] }>;
  reactions: Record<string, { event: string; write_scope: string[] }>;
}

describe('per-source fan-out', () => {
  it('synthesizes a fan-out that iterates the configured sources and aggregates per-source results', () => {
    const spec = synthesizeProgramSpecFromDomain(leadResearchDomain());
    const parsed = load(spec.spec_yaml) as ParsedSpec;
    const wire = JSON.stringify(spec);

    expect(wire).toContain('work.config.sources');
    expect(wire).toContain('current_source');
    expect(wire).toContain('per_source');
    expect(parsed.schema).toMatchObject({
      'work.config.sources': 'array',
      'work.current_source': 'object',
      'work.aggregate.per_source': 'array',
      'navigate_source.fan_out.index': 'number',
    });
    expect(Object.values(parsed.reactions)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'AfterRound',
        write_scope: expect.arrayContaining([
          'work.config.sources',
          'work.current_source',
          'navigate_source.fan_out.index',
          'work.aggregate.per_source.*',
        ]),
      }),
    ]));
    expect(parsed.projection.navigate_source.include).toEqual(expect.arrayContaining([
      'work.current_source.url',
      'navigate_source.fan_out.index',
    ]));
    expect(parsed.projection.extract_leads.include).toContain('work.aggregate.per_source.*.pages_visited');
  });
});
