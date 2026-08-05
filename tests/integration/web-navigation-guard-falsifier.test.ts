import { describe, it, expect } from 'vitest';
import { MockWebNavigationConnector } from '../fixtures/web-navigation-mock.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { leadResearchDomain } from '../fixtures/lead-research-domain.js'; // small fixture domain

const SCHEMA = { name: 'string', email: 'string', relevance_score: 'number' };
const base = { allowed_domains: ['example.com'], max_depth: 1, max_pages: 2,
  max_follow_links: 1, min_delay_ms: 10, max_concurrency: 1 };

describe('web-navigation anti-rogue guards (kill tests)', () => {
  it('G-1 domain allowlist: off-list source is refused, never fetched', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://evil.test/x', 'p', SCHEMA, base);
    expect(r.items).toHaveLength(0);
    expect(r.pages_visited).toBe(0);
    expect(r.audit.some(a => a.action === 'refuse' && a.url.includes('evil.test'))).toBe(true);
  });

  it('G-2 follow-on depth cap: no audit entry exceeds max_depth', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/deep', 'p', SCHEMA, { ...base, max_depth: 1 });
    expect(Math.max(...r.audit.map(a => a.at_depth))).toBeLessThanOrEqual(1);
  });

  it('G-3 page cap: pages_visited never exceeds max_pages (anti-sprawl)', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/many', 'p', SCHEMA, { ...base, max_pages: 2 });
    expect(r.pages_visited).toBeLessThanOrEqual(2);
  });

  it('G-4 follow-links cap: links followed per page never exceeds max_follow_links', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/hub', 'p', SCHEMA, { ...base, max_follow_links: 1 });
    const follows = r.audit.filter(a => a.action === 'follow');
    expect(follows.length).toBeLessThanOrEqual(1);
  });

  it('G-5 robots.txt: a robots-disallowed path is skipped with reason', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/private', 'p', SCHEMA, base); // fixture robots disallows /private
    expect(r.audit.some(a => a.action === 'skip' && /robots/i.test(a.reason ?? ''))).toBe(true);
  });

  it('G-6 pacing: respects min_delay_ms between same-domain fetches', async () => {
    const c = new MockWebNavigationConnector();
    const spy: number[] = [];
    c.onFetch = (t: number) => spy.push(t);        // mock records simulated fetch clock ticks
    await c.navigate_and_extract('https://example.com/many', 'p', SCHEMA, { ...base, max_pages: 2, min_delay_ms: 100 });
    if (spy.length >= 2) expect(spy[1] - spy[0]).toBeGreaterThanOrEqual(100);
  });

  it('G-7 no-spend / no-login: synthesized tool vocabulary exposes no payment or login action', () => {
    const spec = synthesizeProgramSpecFromDomain(leadResearchDomain());
    const wire = JSON.stringify(spec).toLowerCase();
    for (const forbidden of ['checkout', 'payment', 'purchase', 'add_to_cart', 'login', 'sign_in', 'credential', 'password']) {
      expect(wire).not.toContain(`"${forbidden}"`); // no action/tool NAMED for a forbidden capability
    }
  });

  it('G-8 bounded follow-on composes across per-source fan-out aggregation', async () => {
    const domain = leadResearchDomain();
    const sources = sourceUrlsFromDomain(domain);
    expect(sources.length).toBeGreaterThanOrEqual(2);

    const c = new MockWebNavigationConnector();
    const maxPages = 2;
    const per_source = [];
    for (const source of sources) {
      per_source.push(await c.navigate_and_extract(source, 'p', SCHEMA, { ...base, max_pages: maxPages }));
    }

    const totalPagesVisited = per_source.reduce((sum, result) => sum + result.pages_visited, 0);
    expect(totalPagesVisited).toBeLessThanOrEqual(sources.length * maxPages);
  });
});

function sourceUrlsFromDomain(domain: Record<string, unknown>): string[] {
  const config = domain.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return [];
  }
  const sources = (config as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    return [];
  }
  return sources.flatMap((source) => {
    if (typeof source === 'string') {
      return source;
    }
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const url = (source as { url?: unknown }).url;
      return typeof url === 'string' ? url : [];
    }
    return [];
  });
}
