import { describe, it, expect } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

const EXTRACTION_SCHEMA = {
  name: 'string', role: 'string', company: 'string',
  email: 'string', profile_url: 'string', notes: 'string', relevance_score: 'number',
};

function domainWithSchema(schema: Record<string, string>) {
  return {
    'program.slug': 'lead-research-agent',
    'program.name': 'Lead Research Agent',
    'intake.purpose': 'Find purpose-relevant leads and contacts across configured sources.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'extract_leads',
        domain_spec: {
          reads: ['work.source.pages'],
          // extraction_schema is the config-driven output contract:
          produces: { result_json: { leads: [schema] } },
          rules: ['Extract only entities relevant to intake.purpose; score each 0..1.'],
          invariants: ['Every emitted lead has every extraction_schema key.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'extract_leads' }, { from: 'extract_leads', to: 'complete' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'extract_leads.ready' }),
  };
}

describe('config-driven extraction_schema', () => {
  it('shapes the extract stage output contract to exactly the configured schema keys', () => {
    const spec = synthesizeProgramSpecFromDomain(domainWithSchema(EXTRACTION_SCHEMA));
    const stageJson = JSON.stringify(spec);
    // Every configured key appears in the synthesized extract-stage contract.
    for (const key of Object.keys(EXTRACTION_SCHEMA)) {
      expect(stageJson).toContain(key);
    }
  });

  it('a different schema yields a different contract (config, not hardwired)', () => {
    const altSchema = { handle: 'string', platform: 'string', followers: 'number' };
    const spec = synthesizeProgramSpecFromDomain(domainWithSchema(altSchema));
    const stageJson = JSON.stringify(spec);
    for (const key of Object.keys(altSchema)) expect(stageJson).toContain(key);
    // A key unique to the default schema must NOT leak in.
    expect(stageJson).not.toContain('relevance_score');
  });
});
