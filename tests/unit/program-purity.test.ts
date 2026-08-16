import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PROGRAM_ARTIFACT_KINDS,
  DECLARATIVE_DEBT,
  ProgramPurityError,
  PROJECTION_DEBT_EXEMPT,
  assertGeneratedProgramSourceGovernance,
  assertProgramDirPurity,
  scanGeneratedProgramSourceGovernance,
} from '../../src/foundry-program/program-purity.js';
import { GovernanceRefusalError } from '../../src/foundry-program/governance-gate.js';

const NUMERIC_AGGREGATE_SOURCE = `
  export function executiveSummary(perSource: Array<{ found: number }>): number {
    return perSource.reduce((total, source) => total + source.found, 0);
  }
`;

const DEDUP_SOURCE = `
  export function projectedItems(items: string[]): string[] {
    return [...new Set(items)];
  }
`;

describe('program purity registry', () => {
  it('KILL TEST: refuses per-program TypeScript outside the structural allowlist', () => {
    expect(() => assertProgramDirPurity([
      { path: 'src/programs/lead-research-agent/lead-reasoner.ts', kind: 'metadata' },
    ])).toThrow(ProgramPurityError);
  });

  it('allows colocated existing-repo tests outside the program logic boundary', () => {
    expect(() => assertProgramDirPurity([
      { path: 'programs/governed-memo-mini/__tests__/spec-load.test.ts', kind: 'test' },
      { path: 'programs/governed-memo-mini/__tests__/projection.test.ts', kind: 'test' },
    ])).not.toThrow();
  });

  it('accepts a convention-registered standalone program directory with no registration.ts', () => {
    expect(() => assertProgramDirPurity([
      { path: 'src/programs/lead-research-agent/specs.yml', kind: 'spec' },
      { path: 'src/programs/lead-research-agent/handlers.ts', kind: 'handler' },
      { path: 'src/programs/lead-research-agent/handlers/index.ts', kind: 'handler' },
      { path: 'src/programs/lead-research-agent/tools.ts', kind: 'tool' },
    ])).not.toThrow();
  });

  it('tracks every non-terminal allowed code kind with an engine ask', () => {
    const terminalAllowed = new Set(['contract']);
    const missingDebt = [...ALLOWED_PROGRAM_ARTIFACT_KINDS]
      .filter((kind) => !terminalAllowed.has(kind))
      .filter((kind) => {
        const debt = DECLARATIVE_DEBT.find((entry) => entry.kind === kind);
        return !debt?.engine_ask.trim();
      });

    expect(missingDebt).toEqual([]);
  });

  it('retires projection numeric_aggregate governance debt exemption', () => {
    expect([...PROJECTION_DEBT_EXEMPT]).toEqual([]);
    const projectionDebt = DECLARATIVE_DEBT.find((entry) => entry.kind === 'projection');
    expect(projectionDebt?.north_star).toBe('delete projection.ts');
  });
});

describe('generated source governance coverage', () => {
  it('KILL TEST: refuses dedup logic in projection artifacts', () => {
    expect(() => assertGeneratedProgramSourceGovernance([
      {
        path: 'src/programs/lead-research-agent/projection.ts',
        kind: 'projection',
        sourceText: DEDUP_SOURCE,
      },
    ])).toThrow(GovernanceRefusalError);
  });

  it('KILL TEST: refuses numeric_aggregate in projection artifacts after render-derived adoption', () => {
    expect(() => assertGeneratedProgramSourceGovernance([
      {
        path: 'src/programs/lead-research-agent/report-data.ts',
        kind: 'projection',
        sourceText: NUMERIC_AGGREGATE_SOURCE,
      },
    ])).toThrow(GovernanceRefusalError);
  });

  it('KILL TEST: keeps numeric_aggregate fatal outside projection artifacts', () => {
    expect(() => assertGeneratedProgramSourceGovernance([
      {
        path: 'src/programs/lead-research-agent/handlers.ts',
        kind: 'handler',
        sourceText: NUMERIC_AGGREGATE_SOURCE,
      },
    ])).toThrow(GovernanceRefusalError);
  });

  it('scans connector artifacts while recording unavoidable exemptions', () => {
    const report = scanGeneratedProgramSourceGovernance([
      {
        path: 'src/programs/lead-research-agent/connectors/web-navigation.ts',
        kind: 'connector',
        sourceText: DEDUP_SOURCE,
      },
    ]);

    expect(report.fatalViolations).toEqual([]);
    expect(report.unavoidableExemptions).toEqual([
      expect.objectContaining({
        path: 'src/programs/lead-research-agent/connectors/web-navigation.ts',
        findingKinds: ['compute_dedup'],
      }),
    ]);
  });
});
