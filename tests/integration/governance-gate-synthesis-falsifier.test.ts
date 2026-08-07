import { describe, it, expect } from 'vitest';
import { verifyGovernanceOfStageBody } from '../../src/foundry-program/domain-synthesis.js';
import { GovernanceRefusalError } from '../../src/foundry-program/governance-gate.js';
import { activeEnforcedConstructs } from '../../src/foundry-program/engine-primitive-registry.js';

const BRITTLE = `export async function runStage(input, runtime){ const s=new Set(); const recs=input.domain['persist.records']??[]; const d=recs.filter(r=>{if(s.has(r.email))return false;s.add(r.email);return true;}); return {result_json:JSON.stringify({d}),items_json:'[]',digest:''}; }`;
const CONFORMANT = `export async function runStage(input, runtime){ const rep=assembleStructuredReport(input.domain); const b=await runtime.connectors.pdf_report.render_report(rep); return {result_json:JSON.stringify({n:b.length}),items_json:'[]',digest:''}; }`;
const COMPLETION_BRANCH = `export async function runStage(input, runtime){ if ((input.domain['review.items']??[]).every((item)=>item.status==='approved')) { return { result_json: JSON.stringify({ complete: true }), items_json: '[]', digest: '' }; } return { result_json: JSON.stringify({ complete: false }), items_json: '[]', digest: '' }; }`;
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
});
