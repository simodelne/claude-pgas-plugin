import { describe, expect, it } from 'vitest';

import { MockWebNavigationConnector } from '../fixtures/web-navigation-mock.js';

const GUARD = {
  allowed_domains: ['example.com'],
  max_depth: 1,
  max_pages: 3,
  max_follow_links: 2,
  min_delay_ms: 0,
  max_concurrency: 1,
};
const SCHEMA = { name: 'string', email: 'string', relevance_score: 'number' };

describe('WebNavigationHostConnector mock', () => {
  it('returns items shaped by extraction_schema and an audit for every action', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/team', 'find engineers', SCHEMA, GUARD);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items).toHaveLength(Object.keys(SCHEMA).length);
    for (const item of r.items) for (const k of Object.keys(SCHEMA)) expect(item).toHaveProperty(k);
    expect(r.audit.filter((entry) => entry.action === 'fetch')).toHaveLength(r.pages_visited);
    expect(r.audit.filter((entry) => entry.action === 'extract')).toHaveLength(r.items.length);
    expect(r.pages_visited).toBeLessThanOrEqual(GUARD.max_pages);
  });
});
