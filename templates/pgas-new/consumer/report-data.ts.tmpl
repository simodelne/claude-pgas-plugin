import type { StructuredReport } from './pdf-report-connector.js';

export function assembleStructuredReport(domain: Record<string, unknown>): StructuredReport {
  const config = recordValue(valueAtPath(domain, 'config'));
  const purpose = stringValue(config.purpose) ?? stringValue(valueAtPath(domain, 'purpose')) ?? '';
  const title = stringValue(config.title) ?? 'Lead Report';
  const perSource = perSourceEntries(firstDefined(
    valueAtPath(domain, 'aggregate.per_source'),
    valueAtPath(domain, 'work.aggregate.per_source'),
    resultJsonRecord(valueAtPath(domain, 'aggregate.output')).per_source,
    resultJsonRecord(valueAtPath(domain, 'work.aggregate.output')).per_source,
  ));
  const leads = leadEntries(firstDefined(
    valueAtPath(domain, 'persist.new_vs_existing'),
    valueAtPath(domain, 'work.persist.new_vs_existing'),
    resultJsonRecord(valueAtPath(domain, 'persist.output')).new_vs_existing,
    resultJsonRecord(valueAtPath(domain, 'work.persist.output')).new_vs_existing,
  ));
  const guardAuditSummary = auditEntries(firstDefined(
    valueAtPath(domain, 'audit'),
    valueAtPath(domain, 'work.audit'),
    valueAtPath(domain, 'aggregate.audit'),
    resultJsonRecord(valueAtPath(domain, 'navigate_source.output')).audit,
    resultJsonRecord(valueAtPath(domain, 'work.navigate_source.output')).audit,
  ));

  return {
    title,
    purpose,
    executive_summary: executiveSummary(purpose, perSource, leads, guardAuditSummary),
    per_source: perSource,
    leads,
    guard_audit_summary: guardAuditSummary,
  };
}

function executiveSummary(
  purpose: string,
  perSource: readonly { source: string; found: number; pages_visited: number }[],
  leads: readonly Record<string, unknown>[],
  audit: readonly { action: string; url: string; reason?: string }[],
): string {
  const reviewed = perSource.length;
  const found = perSource.reduce((sum, source) => sum + source.found, 0);
  const refusedOrSkipped = audit.filter((entry) => entry.action === 'refuse' || entry.action === 'skip').length;
  return [
    `Purpose: ${purpose || 'not specified'}.`,
    `Sources reviewed: ${String(reviewed)}.`,
    `Source findings: ${String(found)}.`,
    `Leads carried forward: ${String(leads.length)}.`,
    `Guard audit entries: ${String(audit.length)} (${String(refusedOrSkipped)} refused or skipped).`,
  ].join(' ');
}

function perSourceEntries(value: unknown): Array<{ source: string; found: number; pages_visited: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = recordValue(item);
    const source = stringValue(record.source) ?? stringValue(record.url);
    if (!source) {
      return [];
    }
    return [{
      source,
      found: numberValue(record.found) ?? numberValue(record.item_count) ?? arrayLength(record.items),
      pages_visited: numberValue(record.pages_visited) ?? 0,
    }];
  });
}

function leadEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => ({ ...record }));
}

function auditEntries(value: unknown): Array<{ action: string; url: string; reason?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = recordValue(item);
    const action = stringValue(record.action);
    const url = stringValue(record.url);
    if (!action || !url) {
      return [];
    }
    const reason = stringValue(record.reason);
    return [{
      action,
      url,
      ...(reason ? { reason } : {}),
    }];
  });
}

function valueAtPath(domain: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(domain, path)) {
    return domain[path];
  }
  let cursor: unknown = domain;
  for (const part of path.split('.')) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function resultJsonRecord(value: unknown): Record<string, unknown> {
  const record = recordValue(value);
  if (typeof record.result_json === 'string') {
    try {
      return recordValue(JSON.parse(record.result_json) as unknown);
    } catch {
      return {};
    }
  }
  return recordValue(record.result_json);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
  }
  return undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
