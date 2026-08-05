// GOLDEN FIXTURE — materialized copy of templates/pgas-new/consumer/web-navigation-mock.ts.tmpl

import type {
  ExtractedItem,
  GuardContext,
  NavigateAndExtractResult,
  NavAuditEntry,
  WebNavigationHostConnector,
} from './web-navigation-connector.js';

export class MockWebNavigationConnector implements WebNavigationHostConnector {
  onFetch?: (tick: number) => void;

  private tick = 0;
  private readonly lastFetchTickByDomain = new Map<string, number>();

  async navigate_and_extract(
    source: string,
    purpose: string,
    extraction_schema: Record<string, string>,
    guard: GuardContext,
  ): Promise<NavigateAndExtractResult> {
    const audit: NavAuditEntry[] = [];
    const maxDepth = nonNegativeInteger(guard.max_depth);
    const maxPages = nonNegativeInteger(guard.max_pages);
    const maxFollowLinks = nonNegativeInteger(guard.max_follow_links);
    const queue = fixtureInitialQueueForSource(source);
    const visited = new Set<string>();
    const pages: Array<{ url: string; depth: number }> = [];

    while (queue.length > 0) {
      const page = queue.shift() as { url: string; depth: number };
      if (visited.has(page.url)) {
        continue;
      }

      if (!isAllowedUrl(page.url, guard)) {
        audit.push({ action: 'refuse', url: page.url, reason: 'domain not allowlisted', at_depth: Math.min(page.depth, maxDepth) });
        continue;
      }

      const robotsReason = robotsDisallowReason(page.url);
      if (robotsReason) {
        audit.push({ action: 'skip', url: page.url, reason: robotsReason, at_depth: Math.min(page.depth, maxDepth) });
        continue;
      }

      if (pages.length >= maxPages) {
        audit.push({ action: 'skip', url: page.url, reason: 'max_pages cap reached', at_depth: Math.min(page.depth, maxDepth) });
        break;
      }

      visited.add(page.url);
      this.recordFetchTick(page.url, guard);
      pages.push(page);
      audit.push({ action: 'fetch', url: page.url, at_depth: page.depth });

      let followsForPage = 0;
      for (const href of fixtureLinksForPage(page.url)) {
        const nextUrl = resolveFixtureUrl(href, page.url);
        if (!nextUrl) {
          audit.push({ action: 'skip', url: href, reason: 'invalid_url', at_depth: page.depth });
          continue;
        }
        if (followsForPage >= maxFollowLinks) {
          audit.push({ action: 'skip', url: nextUrl, reason: 'max_follow_links cap reached', at_depth: page.depth });
          continue;
        }

        const nextDepth = page.depth + 1;
        if (nextDepth > maxDepth) {
          audit.push({ action: 'skip', url: nextUrl, reason: 'max_depth cap reached', at_depth: page.depth });
          continue;
        }

        followsForPage += 1;
        audit.push({ action: 'follow', url: nextUrl, at_depth: nextDepth });
        queue.push({ url: nextUrl, depth: nextDepth });
      }
    }

    const items = pages.length === 0 ? [] : Object.keys(extraction_schema).map((key, index) => {
      const page = pages[index % Math.max(1, pages.length)] ?? { url: source, depth: 0 };
      const item = itemFromSchema(extraction_schema, key, purpose, page.url);
      audit.push({ action: 'extract', url: page.url, at_depth: page.depth });
      return item;
    });

    return {
      items,
      pages_visited: pages.length,
      audit,
    };
  }

  private recordFetchTick(url: string, guard: GuardContext): void {
    const domain = registrableDomainForUrl(url);
    const minDelay = nonNegativeInteger(guard.min_delay_ms);
    const previous = domain ? this.lastFetchTickByDomain.get(domain) : undefined;
    if (previous !== undefined && this.tick - previous < minDelay) {
      this.tick = previous + minDelay;
    }
    this.onFetch?.(this.tick);
    if (domain) {
      this.lastFetchTickByDomain.set(domain, this.tick);
    }
  }
}

function fixtureInitialQueueForSource(source: string): Array<{ url: string; depth: number }> {
  if (source === 'https://example.com/many') {
    return [
      { url: source, depth: 0 },
      { url: 'https://example.com/many?page=2', depth: 0 },
      { url: 'https://example.com/many?page=3', depth: 0 },
    ];
  }
  return [{ url: source, depth: 0 }];
}

function fixtureLinksForPage(url: string): string[] {
  const links: Record<string, string[]> = {
    'https://example.com/team': [
      'https://example.com/team/alex',
      'https://example.com/team/blair',
    ],
    'https://example.com/deep': ['https://example.com/deep/level-1'],
    'https://example.com/deep/level-1': ['https://example.com/deep/level-2'],
    'https://example.com/hub': [
      'https://example.com/team/alex',
      'https://example.com/team/blair',
      'https://example.com/team/casey',
    ],
  };
  return links[url] ?? [];
}

function isAllowedUrl(url: string, guard: GuardContext): boolean {
  const domain = registrableDomainForUrl(url);
  if (!domain) {
    return false;
  }
  const allowedDomains = guard.allowed_domains.map(normalizeRegistrableDomain).filter((value): value is string => Boolean(value));
  return allowedDomains.includes(domain);
}

function robotsDisallowReason(url: string): string | undefined {
  const parsed = parseUrl(url);
  if (!parsed) {
    return 'invalid_url';
  }
  const domain = registrableDomainForUrl(url);
  const disallowed = domain ? FIXTURE_ROBOTS_DISALLOW[domain] ?? [] : [];
  return disallowed.some((path) => parsed.pathname === path || parsed.pathname.startsWith(`${path}/`))
    ? `robots.txt disallows ${parsed.pathname}`
    : undefined;
}

function resolveFixtureUrl(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function registrableDomainForUrl(url: string): string | undefined {
  const parsed = parseUrl(url);
  return parsed ? normalizeRegistrableDomain(parsed.hostname) : undefined;
}

function normalizeRegistrableDomain(value: string): string | undefined {
  const hostname = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .split('/')[0]
    ?.replace(/\.$/u, '');
  if (!hostname) {
    return undefined;
  }
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 2) {
    return hostname;
  }
  const suffix = labels.slice(-2).join('.');
  if (COMMON_MULTI_LABEL_SUFFIXES.has(suffix) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return suffix;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function itemFromSchema(schema: Record<string, string>, seed: string, purpose: string, url: string): ExtractedItem {
  const item: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(schema)) {
    item[key] = fixtureValue(key, type, seed, purpose, url);
  }
  return item;
}

function fixtureValue(key: string, type: string, seed: string, purpose: string, url: string): unknown {
  if (type === 'number') return key === 'relevance_score' ? 0.82 : seed.length;
  if (type === 'boolean') return true;
  return `${seed} fixture for ${key} from ${url} (${purpose})`;
}

const FIXTURE_ROBOTS_DISALLOW: Record<string, string[]> = {
  'example.com': ['/private'],
};

const COMMON_MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'com.br',
  'co.jp',
]);
