import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { leadResearchDomain } from '../fixtures/lead-research-domain.js';

interface ParsedSpec {
  action_map: Record<string, { mutations?: Array<{ op: string; path: string; value: unknown }> }>;
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
    expect(spec.handlers_ts).toContain('...(sourceSliceMutations(config.currentSourcePath, nextSource, nextIndex) ?? [])');
    expect(spec.handlers_ts).not.toContain('...sourceSliceMutations(config.currentSourcePath, nextSource, nextIndex),');
    expect(spec.handlers_ts).toContain("['mirror_lead_research_host_outputs', (snapshot) => mirrorLeadResearchHostOutputs(snapshot)]");
    expect(spec.handlers_ts).toContain('function mirrorLeadResearchHostOutputs');
    expect(parsed.schema).toMatchObject({
      'work.config.sources': 'array',
      'work.current_source': 'object',
      'work.aggregate.per_source': 'array',
      'work.persist.new_vs_existing': 'array',
      'work.audit': 'array',
      'navigate_source.fan_out.index': 'number',
    });
    expect(parsed.action_map.begin_work?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'MSet', path: 'work.config.sources.0' }),
      expect.objectContaining({ op: 'MSet', path: 'work.current_source' }),
      expect.objectContaining({ op: 'MSet', path: 'work.current_source.url' }),
      expect.objectContaining({ op: 'MSet', path: 'navigate_source.fan_out.index', value: 0 }),
      expect.objectContaining({ op: 'MSet', path: 'navigate_source.fan_out.complete', value: false }),
    ]));
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
      expect.objectContaining({
        event: 'AfterRound',
        write_scope: expect.arrayContaining([
          'work.persist.new_vs_existing.*',
          'work.audit.*',
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
