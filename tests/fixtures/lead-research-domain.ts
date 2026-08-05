const EXTRACTION_SCHEMA = {
  name: 'string',
  email: 'string',
  relevance_score: 'number',
};

const GUARD_CONFIG = {
  allowed_domains: ['example.com'],
  max_depth: 1,
  max_pages: 2,
  max_follow_links: 1,
  min_delay_ms: 10,
  max_concurrency: 1,
};

const SOURCES = [
  {
    url: 'https://example.com/team',
    allowed_domains: ['example.com'],
  },
];

export function leadResearchDomain(): Record<string, unknown> {
  return {
    'program.slug': 'lead-research-agent',
    'program.name': 'Lead Research Agent',
    'intake.purpose': 'Find purpose-relevant leads and contacts across configured public sources.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'navigate_source',
        archetype: 'external-adapter',
        integration: 'web_navigation',
        domain_spec: {
          reads: ['config.sources', 'guard_config'],
          produces: {
            result_json: {
              pages: 'array',
              audit: 'array',
            },
          },
          rules: ['Navigate only configured public sources through WebNavigationHostConnector.navigate_and_extract.'],
          invariants: ['Every navigation action is represented in result_json.audit.'],
        },
      },
      {
        slug: 'extract_leads',
        archetype: 'llm-reasoning',
        domain_spec: {
          reads: ['navigate_source.output.result_json'],
          produces: { result_json: { leads: [EXTRACTION_SCHEMA] } },
          rules: ['Extract only entities relevant to intake.purpose; score each 0..1.'],
          invariants: ['Every emitted lead has every extraction_schema key.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'navigate_source', trigger: 'started', guard_field: 'intake.started' },
      { from: 'navigate_source', to: 'extract_leads', trigger: 'navigated', guard_field: 'navigate_source.ready' },
      { from: 'extract_leads', to: 'complete', trigger: 'extracted', guard_field: 'extract_leads.done' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'extract_leads.done' }),
    config: {
      sources: SOURCES,
      extraction_schema: EXTRACTION_SCHEMA,
    },
    guard_config: GUARD_CONFIG,
  };
}
