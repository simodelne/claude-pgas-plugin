// GOLDEN FIXTURE — materialized copy of templates/pgas-new/consumer/web-navigation-connector.ts.tmpl

export interface GuardContext {
  readonly allowed_domains: readonly string[];     // registrable domains the run may touch
  readonly max_depth: number;                       // follow-on link depth ceiling
  readonly max_pages: number;                       // pages fetched per source ceiling
  readonly max_follow_links: number;                // links followed per page ceiling
  readonly min_delay_ms: number;                    // per-domain pacing floor
  readonly max_concurrency: number;                 // concurrent fetches ceiling
}
export interface NavAuditEntry {
  readonly action: 'fetch' | 'follow' | 'extract' | 'skip' | 'refuse';
  readonly url: string;
  readonly reason?: string;                         // populated for skip/refuse
  readonly at_depth: number;
}
export interface ExtractedItem { readonly [key: string]: unknown } // shaped by config extraction_schema
export interface NavigateAndExtractResult {
  readonly items: readonly ExtractedItem[];
  readonly pages_visited: number;
  readonly audit: readonly NavAuditEntry[];
}
export interface WebNavigationHostConnector {
  navigate_and_extract(
    source: string,
    purpose: string,
    extraction_schema: Record<string, string>,
    guard: GuardContext,
  ): Promise<NavigateAndExtractResult>;
}
