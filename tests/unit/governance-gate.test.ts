import { describe, it, expect } from 'vitest';
import {
  detectGovernedConstructs,
  fatalGovernanceViolations,
  UNAVOIDABLE_ARTIFACT_KINDS,
  type GovernedConstructKind,
} from '../../src/foundry-program/governance-gate.js';

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
const EXISTENTIAL_COMPLETION_BODY = `
export async function runStage(input, runtime) {
  const items = input.domain['work.items'] ?? [];
  const hasProposed = items.some((item) => item.status === 'proposed');
  return { result_json: JSON.stringify({ hasProposed }), items_json: '[]', digest: '' };
}`;
const PARTITION_BY_VERDICT_BODY = `
export async function runStage(input, runtime) {
  const items = input.domain['work.items'] ?? [];
  const accepted = items.filter((item) => item.status === 'accepted');
  return { result_json: JSON.stringify({ accepted }), items_json: '[]', digest: '' };
}`;
const NUMERIC_AGGREGATE_BODY = `
export async function runStage(input, runtime) {
  const items = input.domain['work.items'] ?? [];
  const totalHours = items.reduce((total, item) => total + item.hours, 0);
  return { result_json: JSON.stringify({ totalHours }), items_json: '[]', digest: '' };
}`;
const TOKEN_COVERAGE_BODY = `
export function validateCoverage(input) {
  const required = ['venue', 'date'];
  const text = String(input.domain.draft.text ?? '').toLowerCase();
  if (!required.every((token) => text.includes(token.toLowerCase()))) {
    throw new Error('draft is missing required coverage tokens');
  }
  return true;
}`;
const REGEX_VALIDATION_BODY = `
export function validateEmail(input) {
  const email = String(input.domain['lead.email'] ?? '');
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/u.test(email)) {
    throw new Error('lead email must match the email format');
  }
  if (/\\btest-only\\b/u.test(email)) {
    throw new Error('lead email must not contain test-only markers');
  }
  return true;
}`;
const SOURCE_GROUNDING_BODY = `
export function validateGrounding(input) {
  const source = String(input.domain['work.source.full_text'] ?? '').toLowerCase();
  const names = input.domain['lead.names'] ?? [];
  for (const name of names) {
    if (!source.includes(String(name).toLowerCase())) {
      throw new Error('extracted name is not grounded in the source text');
    }
  }
  return true;
}`;
const RECOVERY_STEER_BODY = `
export function steerRecoveryGuidance(input) {
  return input.domain.review.recovery_required
    ? 'Ask for a corrected answer before retrying.'
    : 'Continue with the current approval path.';
}`;
const NUMERIC_VALIDATION_BODY = `
export function validateFidelity(input) {
  if (input.domain.work.source.char_count < 40) {
    throw new Error('source is below the minimum fidelity floor');
  }
  return true;
}`;
const NUMERIC_BUSINESS_BRANCH_BODY = `
export function routeRisk(input) {
  if (input.domain.score.risk_score >= 90) {
    return { queue: 'security_escalation' };
  }
  return { queue: 'standard_ops' };
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
  it('flags an any-item field equality check as an existential completion guard', () => {
    const findings = detectGovernedConstructs(EXISTENTIAL_COMPLETION_BODY);
    expect(findings.map((x) => x.kind)).toContain('existential_completion_guard');
  });
  it('flags field-equality filters as partition-by-verdict computation', () => {
    const findings = detectGovernedConstructs(PARTITION_BY_VERDICT_BODY);
    expect(findings.map((x) => x.kind)).toContain('partition_by_verdict');
  });
  it('narrows numeric sum reduce from broad aggregate computation', () => {
    const kinds = detectGovernedConstructs(NUMERIC_AGGREGATE_BODY).map((x) => x.kind);
    expect(kinds).toContain('numeric_aggregate');
    expect(kinds).not.toContain('compute_aggregate');
  });
  it('flags required-token coverage throws as token coverage validation', () => {
    expect(detectGovernedConstructs(TOKEN_COVERAGE_BODY).map((x) => x.kind)).toContain('token_coverage_validation');
  });
  it('flags regex pattern validation separately from broad structural validation', () => {
    const kinds = detectGovernedConstructs(REGEX_VALIDATION_BODY).map((x) => x.kind);
    expect(kinds).toContain('regex_validation');
    expect(kinds).not.toContain('adhoc_validation_throw');
  });
  it('flags source-grounding validation separately from required-token coverage', () => {
    const kinds = detectGovernedConstructs(SOURCE_GROUNDING_BODY).map((x) => x.kind);
    expect(kinds).toContain('source_grounding_validation');
    expect(kinds).not.toContain('token_coverage_validation');
  });
  it('flags a steer/guidance emitter reading a typed recovery flag', () => {
    const findings = detectGovernedConstructs(RECOVERY_STEER_BODY);
    expect(findings.map((x) => x.kind)).toContain('recovery_steer');
  });
  it('flags numeric validation throws without broadening to ordinary numeric branching', () => {
    expect(detectGovernedConstructs(NUMERIC_VALIDATION_BODY).map((x) => x.kind)).toContain('numeric_validation');
    expect(detectGovernedConstructs(NUMERIC_BUSINESS_BRANCH_BODY).map((x) => x.kind)).not.toContain('numeric_validation');
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
  it('is fatal for active numeric-validation and recovery-steer imperative bodies', () => {
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(NUMERIC_VALIDATION_BODY),
      'stage_body',
      new Set(['numeric_validation']),
    ).map((v) => v.kind)).toEqual(['numeric_validation']);
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(RECOVERY_STEER_BODY),
      'stage_body',
      new Set(['recovery_steer']),
    ).map((v) => v.kind)).toEqual(['recovery_steer']);
  });
  it('is fatal for active #844 primitive imperative bodies', () => {
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(EXISTENTIAL_COMPLETION_BODY),
      'stage_body',
      new Set(['existential_completion_guard']),
    ).map((v) => v.kind)).toEqual(['existential_completion_guard']);
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(PARTITION_BY_VERDICT_BODY),
      'stage_body',
      new Set(['partition_by_verdict']),
    ).map((v) => v.kind)).toEqual(['partition_by_verdict']);
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(NUMERIC_AGGREGATE_BODY),
      'stage_body',
      new Set(['numeric_aggregate']),
    ).map((v) => v.kind)).toEqual(['numeric_aggregate']);
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(TOKEN_COVERAGE_BODY),
      'stage_body',
      new Set(['token_coverage_validation']),
    ).map((v) => v.kind)).toEqual(['token_coverage_validation']);
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(REGEX_VALIDATION_BODY),
      'stage_body',
      new Set(['regex_validation' as GovernedConstructKind]),
    ).map((v) => v.kind)).toEqual(['regex_validation', 'regex_validation']);
    expect(fatalGovernanceViolations(
      detectGovernedConstructs(SOURCE_GROUNDING_BODY),
      'stage_body',
      new Set(['source_grounding_validation' as GovernedConstructKind]),
    ).map((v) => v.kind)).toEqual(['source_grounding_validation']);
  });
});
