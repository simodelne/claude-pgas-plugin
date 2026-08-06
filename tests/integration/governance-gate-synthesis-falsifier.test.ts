import { describe, it, expect } from 'vitest';
import { verifyGovernanceOfStageBody } from '../../src/foundry-program/domain-synthesis.js';
import { GovernanceRefusalError } from '../../src/foundry-program/governance-gate.js';

const BRITTLE = `export async function runStage(input, runtime){ const s=new Set(); const recs=input.domain['persist.records']??[]; const d=recs.filter(r=>{if(s.has(r.email))return false;s.add(r.email);return true;}); return {result_json:JSON.stringify({d}),items_json:'[]',digest:''}; }`;
const CONFORMANT = `export async function runStage(input, runtime){ const rep=assembleStructuredReport(input.domain); const b=await runtime.connectors.pdf_report.render_report(rep); return {result_json:JSON.stringify({n:b.length}),items_json:'[]',digest:''}; }`;

describe('governance gate in synthesis (fail-closed)', () => {
  it('KILL TEST: a stage body with an enforced dedup construct is refused before write', () => {
    expect(() => verifyGovernanceOfStageBody(BRITTLE, 'stage_body')).toThrow(GovernanceRefusalError);
    try { verifyGovernanceOfStageBody(BRITTLE, 'stage_body'); } catch (e) {
      expect((e as GovernanceRefusalError).violations[0].message).toMatch(/keyed_idempotent_collection|dedup/i);
    }
  });
  it('a conformant thin-glue body passes', () => {
    expect(() => verifyGovernanceOfStageBody(CONFORMANT, 'stage_body')).not.toThrow();
  });
  it('an unavoidable byte-generator with the same construct is NOT refused', () => {
    expect(() => verifyGovernanceOfStageBody(BRITTLE, 'byte_generator')).not.toThrow();
  });
});
