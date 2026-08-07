import { describe, it, expect } from 'vitest';
import { verifyGovernanceOfStageBody } from '../../src/foundry-program/domain-synthesis.js';
import { GovernanceRefusalError } from '../../src/foundry-program/governance-gate.js';
import { activeEnforcedConstructs, ENGINE_PRIMITIVE_REGISTRY } from '../../src/foundry-program/engine-primitive-registry.js';

const BRITTLE = `export async function runStage(input, runtime){ const s=new Set(); const recs=input.domain['persist.records']??[]; const d=recs.filter(r=>{if(s.has(r.email))return false;s.add(r.email);return true;}); return {result_json:JSON.stringify({d}),items_json:'[]',digest:''}; }`;
const CONFORMANT = `export async function runStage(input, runtime){ const rep=assembleStructuredReport(input.domain); const b=await runtime.connectors.pdf_report.render_report(rep); return {result_json:JSON.stringify({n:b.length}),items_json:'[]',digest:''}; }`;
const COMPLETION_BRANCH = `export async function runStage(input, runtime){ if ((input.domain['review.items']??[]).every((item)=>item.status==='approved')) { return { result_json: JSON.stringify({ complete: true }), items_json: '[]', digest: '' }; } return { result_json: JSON.stringify({ complete: false }), items_json: '[]', digest: '' }; }`;

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
  it('keeps pending family members detected but non-fatal until the registry activates them', () => {
    expect([...activeEnforcedConstructs()]).toEqual(['compute_dedup']);
    expect(() => verifyGovernanceOfStageBody(COMPLETION_BRANCH, 'stage_body')).not.toThrow();
  });
  it('the synthesis gate seam refuses completion branching when a synthetic registry activates it', () => {
    const synthetic = ENGINE_PRIMITIVE_REGISTRY.map((entry) => entry.computation_class === 'domain_shape_branch'
      ? { ...entry, foundry_enforcement: 'active' as const }
      : entry);

    expect(() => verifyGovernanceOfStageBody(
      COMPLETION_BRANCH,
      'stage_body',
      activeEnforcedConstructs(synthetic),
    )).toThrow(GovernanceRefusalError);
  });
});
