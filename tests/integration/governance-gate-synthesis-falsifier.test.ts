import { describe, it, expect } from 'vitest';
import { verifyGovernanceOfStageBody } from '../../src/foundry-program/domain-synthesis.js';
import { GovernanceRefusalError } from '../../src/foundry-program/governance-gate.js';
import { activeEnforcedConstructs } from '../../src/foundry-program/engine-primitive-registry.js';

const BRITTLE = `export async function runStage(input, runtime){ const s=new Set(); const recs=input.domain['persist.records']??[]; const d=recs.filter(r=>{if(s.has(r.email))return false;s.add(r.email);return true;}); return {result_json:JSON.stringify({d}),items_json:'[]',digest:''}; }`;
const CONFORMANT = `export async function runStage(input, runtime){ const rep=assembleStructuredReport(input.domain); const b=await runtime.connectors.pdf_report.render_report(rep); return {result_json:JSON.stringify({n:b.length}),items_json:'[]',digest:''}; }`;
const COMPLETION_BRANCH = `export async function runStage(input, runtime){ if ((input.domain['review.items']??[]).every((item)=>item.status==='approved')) { return { result_json: JSON.stringify({ complete: true }), items_json: '[]', digest: '' }; } return { result_json: JSON.stringify({ complete: false }), items_json: '[]', digest: '' }; }`;
const EXISTENTIAL_COMPLETION_BODY = `export async function runStage(input, runtime){ const items=input.domain['review.items']??[]; const hasProposed=items.some((item)=>item.status==='proposed'); return { result_json: JSON.stringify({ hasProposed }), items_json: '[]', digest: '' }; }`;
const PARTITION_BODY = `export async function runStage(input, runtime){ const items=input.domain['review.items']??[]; const accepted=items.filter((item)=>item.status==='accepted'); return { result_json: JSON.stringify({ accepted }), items_json: '[]', digest: '' }; }`;
const NUMERIC_AGGREGATE_BODY = `export async function runStage(input, runtime){ const items=input.domain['review.items']??[]; const hours=items.reduce((total,item)=>total+item.hours,0); return { result_json: JSON.stringify({ hours }), items_json: '[]', digest: '' }; }`;
const TOKEN_COVERAGE_BODY = `export function validateCoverage(input){ const tokens=['venue','date']; const text=String(input.domain.draft.text??'').toLowerCase(); if(!tokens.every((token)=>text.includes(token.toLowerCase()))){ throw new Error('missing token'); } return true; }`;
const REGEX_VALIDATION_BODY = `export function validatePattern(input){ const text=String(input.domain.draft.email??''); if(!/^[^@]+@[^@]+$/.test(text)){ throw new Error('bad email'); } return true; }`;
const SOURCE_GROUNDING_BODY = `export function validateGrounding(input){ const source=String(input.domain.source.text??''); const extracted=String(input.domain.draft.name??''); if(!source.includes(extracted)){ throw new Error('not grounded'); } return true; }`;
const ORDINARY_DOMAIN_BRANCH = `export async function runStage(input, runtime){ if (input.domain['review.kind'] === 'fast') { return { result_json: JSON.stringify({ queue: 'fast' }), items_json: '[]', digest: '' }; } return { result_json: JSON.stringify({ queue: 'normal' }), items_json: '[]', digest: '' }; }`;
const NUMERIC_VALIDATION_BRANCH = `export async function runStage(input, runtime){ if (input.domain.work.source.char_count < 40) { throw new Error('low fidelity source'); } return { result_json: JSON.stringify({ ok: true }), items_json: '[]', digest: '' }; }`;
const RECOVERY_STEER_BODY = `export function steerRecoveryGuidance(input){ return input.domain.review.recovery_required ? 'Ask for a corrected answer before retrying.' : 'Continue.'; }`;

describe('governance gate in synthesis (fail-closed)', () => {
  it('KILL TEST: a stage body with an enforced dedup construct is refused before write', () => {
    expect(() => verifyGovernanceOfStageBody(BRITTLE, 'stage_body')).toThrow(GovernanceRefusalError);
    try { verifyGovernanceOfStageBody(BRITTLE, 'stage_body'); } catch (e) {
      expect((e as GovernanceRefusalError).violations[0].message).toMatch(/keyed_by|dedup/i);
    }
  });
  it('a conformant thin-glue body passes', () => {
    expect(() => verifyGovernanceOfStageBody(CONFORMANT, 'stage_body')).not.toThrow();
  });
  it('an unavoidable byte-generator with the same construct is NOT refused', () => {
    expect(() => verifyGovernanceOfStageBody(BRITTLE, 'byte_generator')).not.toThrow();
  });
  it('activates only narrow landed cursor/completion constructs without broad domain-branch contraction', () => {
    expect([...activeEnforcedConstructs()]).toEqual([
      'iteration_cursor',
      'completion_guard',
      'compute_dedup',
      'numeric_validation',
      'recovery_steer',
      'existential_completion_guard',
      'partition_by_verdict',
      'numeric_aggregate',
      'token_coverage_validation',
      'regex_validation',
      'source_grounding_validation',
    ]);
    expect(() => verifyGovernanceOfStageBody(ORDINARY_DOMAIN_BRANCH, 'stage_body')).not.toThrow();
  });
  it('KILL TEST: active completion equality bodies must use derived_paths, not imperative every()', () => {
    expect(() => verifyGovernanceOfStageBody(COMPLETION_BRANCH, 'stage_body')).toThrow(GovernanceRefusalError);
  });
  it('KILL TEST: active numeric validation must use numeric predicates, not imperative threshold throws', () => {
    expect(() => verifyGovernanceOfStageBody(NUMERIC_VALIDATION_BRANCH, 'stage_body')).toThrow(GovernanceRefusalError);
  });
  it('KILL TEST: active recovery steering must use recovery_steers, not typed-flag guidance emitters', () => {
    expect(() => verifyGovernanceOfStageBody(RECOVERY_STEER_BODY, 'stage_body')).toThrow(GovernanceRefusalError);
  });
  it('KILL TEST: active #844 primitives refuse their imperative equivalents', () => {
    expect(() => verifyGovernanceOfStageBody(EXISTENTIAL_COMPLETION_BODY, 'stage_body')).toThrow(GovernanceRefusalError);
    expect(() => verifyGovernanceOfStageBody(PARTITION_BODY, 'stage_body')).toThrow(GovernanceRefusalError);
    expect(() => verifyGovernanceOfStageBody(NUMERIC_AGGREGATE_BODY, 'stage_body')).toThrow(GovernanceRefusalError);
    expect(() => verifyGovernanceOfStageBody(TOKEN_COVERAGE_BODY, 'stage_body')).toThrow(GovernanceRefusalError);
  });
  it('KILL TEST: active #862 predicates refuse their imperative equivalents', () => {
    expect(() => verifyGovernanceOfStageBody(REGEX_VALIDATION_BODY, 'stage_body')).toThrow(GovernanceRefusalError);
    expect(() => verifyGovernanceOfStageBody(SOURCE_GROUNDING_BODY, 'stage_body')).toThrow(GovernanceRefusalError);
  });
});
