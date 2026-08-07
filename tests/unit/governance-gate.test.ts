import { describe, it, expect } from 'vitest';
import { detectGovernedConstructs, fatalGovernanceViolations, UNAVOIDABLE_ARTIFACT_KINDS } from '../../src/foundry-program/governance-gate.js';

const DEDUP_BODY = `
export async function runStage(input, runtime) {
  const seen = new Set();
  const records = input.domain['persist.records'] ?? input.domain['aggregate.leads'] ?? [];
  const deduped = records.filter((r) => { if (seen.has(r.email)) return false; seen.add(r.email); return true; });
  return { result_json: JSON.stringify({ deduped }), items_json: '[]', digest: '' };
}`;
const THIN_GLUE_BODY = `
export async function runStage(input, runtime) {
  const report = assembleStructuredReport(input.domain);
  const bytes = await runtime.connectors.pdf_report.render_report(report);
  return { result_json: JSON.stringify({ pdf_bytes: bytes.length }), items_json: '[]', digest: '' };
}`;
const ITERATION_CURSOR_BODY = `
export async function runStage(input, runtime) {
  const items = input.domain['work.items'] ?? [];
  const statuses = input.domain['work.item_statuses'] ?? [];
  const next = [];
  for (const item of items) {
    const status = statuses.find((candidate) => candidate.item_id === item.id);
    if (!status || status.state !== 'pending') continue;
    next.push(item);
  }
  return { result_json: JSON.stringify({ next }), items_json: '[]', digest: '' };
}`;
const COMPLETION_GUARD_BODY = `
export async function runStage(input, runtime) {
  const items = input.domain['work.items'] ?? [];
  const allApproved = items.every((item) => item.status === 'approved');
  return { result_json: JSON.stringify({ allApproved }), items_json: '[]', digest: '' };
}`;
const RECOVERY_STEER_BODY = `
export function steerRecoveryGuidance(input) {
  return input.domain.review.recovery_required
    ? 'Ask for a corrected answer before retrying.'
    : 'Continue with the current approval path.';
}`;

describe('detectGovernedConstructs', () => {
  it('flags a Set-based dedup and a multi-path fallback', () => {
    const f = detectGovernedConstructs(DEDUP_BODY);
    const kinds = f.map((x) => x.kind);
    expect(kinds).toContain('compute_dedup');
    expect(kinds).toContain('multi_path_fallback');
  });
  it('finds nothing governable in a thin-glue pass-through body', () => {
    expect(detectGovernedConstructs(THIN_GLUE_BODY)).toEqual([]);
  });
  it('does not treat a plain map projection as score computation', () => {
    const findings = detectGovernedConstructs(`
export async function runStage(input, runtime) {
  const records = input.domain['persist.records'] ?? [];
  const names = records.map((x) => x.name);
  return { result_json: JSON.stringify({ names }), items_json: '[]', digest: '' };
}`);
    expect(findings.map((x) => x.kind)).not.toContain('compute_score');
  });
  it('does not treat a single declared read plus default as multi-path fallback', () => {
    const findings = detectGovernedConstructs(`
export async function runStage(input, runtime) {
  const records = input.domain['persist.records'] ?? [];
  return { result_json: JSON.stringify({ count: records.length }), items_json: '[]', digest: '' };
}`);
    expect(findings.map((x) => x.kind)).not.toContain('multi_path_fallback');
  });
  it('flags a conservative manual id-join loop as an iteration cursor', () => {
    const findings = detectGovernedConstructs(ITERATION_CURSOR_BODY);
    expect(findings.map((x) => x.kind)).toContain('iteration_cursor');
  });
  it('flags an all-items field equality check as a completion guard', () => {
    const findings = detectGovernedConstructs(COMPLETION_GUARD_BODY);
    expect(findings.map((x) => x.kind)).toContain('completion_guard');
    expect(findings.map((x) => x.kind)).not.toContain('domain_shape_branch');
  });
  it('flags a steer/guidance emitter reading a typed recovery flag', () => {
    const findings = detectGovernedConstructs(RECOVERY_STEER_BODY);
    expect(findings.map((x) => x.kind)).toContain('recovery_steer');
  });
});

describe('fatalGovernanceViolations', () => {
  it('is fatal for an enforced compute_dedup in a stage body, with an actionable message', () => {
    const findings = detectGovernedConstructs(DEDUP_BODY);
    const fatal = fatalGovernanceViolations(findings, 'stage_body', new Set(['compute_dedup']));
    expect(fatal.length).toBeGreaterThan(0);
    expect(fatal[0].message).toMatch(/dedup|keyed_by|engine primitive/i);
  });
  it('exempts the unavoidable set (byte_generator not policed even with a dedup)', () => {
    const findings = detectGovernedConstructs(DEDUP_BODY);
    expect(fatalGovernanceViolations(findings, 'byte_generator', new Set(['compute_dedup']))).toEqual([]);
    expect(UNAVOIDABLE_ARTIFACT_KINDS.has('byte_generator')).toBe(true);
  });
  it('does not make a detected-but-unenforced kind fatal (Phase-1 scoping)', () => {
    const findings = detectGovernedConstructs(DEDUP_BODY); // also has multi_path_fallback
    const fatal = fatalGovernanceViolations(findings, 'stage_body', new Set(['compute_dedup']));
    expect(fatal.every((v) => v.kind === 'compute_dedup')).toBe(true); // multi_path_fallback detected but not enforced yet
  });
  it('is fatal for active cursor and completion-guard imperative bodies', () => {
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(ITERATION_CURSOR_BODY),
      'stage_body',
      new Set(['iteration_cursor']),
    ).map((v) => v.kind)).toEqual(['iteration_cursor']);
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(COMPLETION_GUARD_BODY),
      'stage_body',
      new Set(['completion_guard']),
    ).map((v) => v.kind)).toEqual(['completion_guard']);
  });
});
