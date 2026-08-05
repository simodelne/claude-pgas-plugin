import type { PdfReportHostConnector, StructuredReport } from './pdf-report-connector.js';

export const DEFAULT_PDF_REPORT_TITLE = 'LEAD REPORT DEFAULT';

export class MockPdfReportConnector implements PdfReportHostConnector {
  async render_report(report: StructuredReport): Promise<Uint8Array> {
    const title = report.title.trim().length > 0 ? report.title : DEFAULT_PDF_REPORT_TITLE;
    return new TextEncoder().encode([
      'PDF_REPORT_STUB',
      `TITLE: ${title}`,
      `PURPOSE: ${report.purpose}`,
      'EXECUTIVE SUMMARY',
      report.executive_summary,
      'PER SOURCE',
      stableStringify(report.per_source),
      'LEADS',
      stableStringify(report.leads),
      'GUARD AUDIT SUMMARY',
      stableStringify(report.guard_audit_summary),
      'END PDF_REPORT_STUB',
    ].join('\n'));
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortForStableJson(record[key]);
  }
  return sorted;
}
