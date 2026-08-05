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
  {
    url: 'https://example.com/many',
    allowed_domains: ['example.com'],
  },
  {
    url: 'https://example.com/hub',
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
          reads: [
            'work.config.sources',
            'work.current_source',
            'work.current_source.url',
            'work.current_source.allowed_domains',
            'guard_config',
          ],
          produces: {
            result_json: {
              items: 'ExtractedItem[]',
              pages_visited: 'number',
              audit: 'array',
            },
          },
          rules: ['Navigate only the current fanned public source through WebNavigationHostConnector.navigate_and_extract.'],
          invariants: [
            'Every navigation action is represented in result_json.audit.',
            'Per-source follow-on caps in GuardContext bound every fan-out branch independently.',
          ],
        },
      },
      {
        slug: 'extract_leads',
        archetype: 'llm-reasoning',
        domain_spec: {
          reads: ['work.aggregate.per_source'],
          produces: { result_json: { leads: [EXTRACTION_SCHEMA] } },
          rules: ['Extract only entities relevant to intake.purpose; score each 0..1.'],
          invariants: ['Every emitted lead has every extraction_schema key.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'navigate_source', trigger: 'started', guard_field: 'intake.started' },
      { from: 'navigate_source', to: 'extract_leads', trigger: 'navigated', guard_field: 'navigate_source.fan_out.complete' },
      { from: 'extract_leads', to: 'complete', trigger: 'extracted', guard_field: 'extract_leads.done' },
    ]),
    'intake.delegation_json': JSON.stringify({
      stages: {
        navigate_source: { kind: 'external-adapter', integration: 'web_navigation' },
      },
      children: [
        {
          id: 'source_navigation',
          action_name: 'request_source_navigation',
          stage: 'navigate_source',
          synthesize_child: {
            kind: 'worker',
            slug: 'lead-research-source-navigation',
            purpose: 'Run the bounded navigation branch for the current configured source.',
            result_fields: {
              source: 'string',
              status: 'string',
              pages_visited: 'number',
              item_count: 'number',
            },
          },
          fan_out: {
            source: 'work.config.sources',
            current_document: 'work.current_source',
            result_path: 'work.aggregate.per_source',
            completion_guard: 'navigate_source.fan_out.complete',
            index_path: 'navigate_source.fan_out.index',
          },
          payload_map: {
            'request.source': 'work.current_source.url',
            'request.allowed_domains': 'work.current_source.allowed_domains',
            'domain_context.original_request': 'inputs.initial_user_text',
          },
          result_path: 'navigate_source.delegation.source_navigation.result',
          max_delegated_rounds: 8,
          optional: true,
        },
      ],
    }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'extract_leads.done' }),
    config: {
      sources: SOURCES,
      extraction_schema: EXTRACTION_SCHEMA,
    },
    guard_config: GUARD_CONFIG,
  };
}
