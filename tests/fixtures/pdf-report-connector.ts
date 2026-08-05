export interface StructuredReport {
  readonly title: string;
  readonly purpose: string;
  readonly executive_summary: string;
  readonly per_source: ReadonlyArray<{ source: string; found: number; pages_visited: number }>;
  readonly leads: readonly Record<string, unknown>[];
  readonly guard_audit_summary: ReadonlyArray<{ action: string; url: string; reason?: string }>;
}

export interface PdfReportHostConnector {
  render_report(report: StructuredReport): Promise<Uint8Array>;
}
