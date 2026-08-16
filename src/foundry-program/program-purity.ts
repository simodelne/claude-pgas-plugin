import type { ArtifactKind } from '../pgas-new/artifact-plan.js';
import { activeEnforcedConstructs } from './engine-primitive-registry.js';
import {
  UNAVOIDABLE_ARTIFACT_KINDS,
  detectGovernedConstructs,
  fatalGovernanceViolations,
  GovernanceRefusalError,
  type GovernedArtifactKind,
  type GovernedConstructKind,
  type GovernanceViolation,
} from './governance-gate.js';

export const ALLOWED_PROGRAM_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'registration',
  'contract',
  'connector',
  'handler',
  'projection',
  'stage',
  'tool',
  'export',
  'extract',
]);

export const PROJECTION_DEBT_EXEMPT: ReadonlySet<GovernedConstructKind> = new Set();

export type DeclarativeDebtBucket = 'logic' | 'io_adapter' | 'projection' | 'boilerplate';

export interface DeclarativeDebtEntry {
  readonly kind: ArtifactKind;
  readonly bucket: DeclarativeDebtBucket;
  readonly engine_ask: string;
  readonly north_star: string;
}

export const DECLARATIVE_DEBT: readonly DeclarativeDebtEntry[] = [
  {
    kind: 'handler',
    bucket: 'logic',
    engine_ask: 'K/L/M declarative choreography (pgas #844 comment)',
    north_star: 'delete handlers.ts; reactions declarative',
  },
  {
    kind: 'stage',
    bucket: 'logic',
    engine_ask: 'declarative-stages engine feature (Channel-4, TBD)',
    north_star: 'delete stages/*.ts',
  },
  {
    kind: 'projection',
    bucket: 'projection',
    engine_ask: 'projection-DSL (Channel-4, filed 2026-08-11)',
    north_star: 'delete projection.ts',
  },
  {
    kind: 'tool',
    bucket: 'io_adapter',
    engine_ask: 'shared $ref tools (Channel-4, TBD)',
    north_star: 'shared, not per-program',
  },
  {
    kind: 'connector',
    bucket: 'io_adapter',
    engine_ask: 'shared $ref tools (Channel-4, TBD)',
    north_star: 'shared, not per-program',
  },
  {
    kind: 'export',
    bucket: 'io_adapter',
    engine_ask: 'shared $ref export renderers (Channel-4, TBD)',
    north_star: 'shared, not per-program',
  },
  {
    kind: 'extract',
    bucket: 'io_adapter',
    engine_ask: 'shared $ref document extractors (Channel-4, TBD)',
    north_star: 'shared, not per-program',
  },
  {
    kind: 'registration',
    bucket: 'boilerplate',
    engine_ask: 'existing-repo residual registrar only; standalone uses registerProgramByConvention',
    north_star: 'delete residual registration.ts once attached targets have a convention home',
  },
];

export interface ProgramPurityFile {
  readonly path: string;
  readonly kind: ArtifactKind;
}

export interface ProgramPurityViolation extends ProgramPurityFile {
  readonly reason: string;
}

export class ProgramPurityError extends Error {
  readonly violations: readonly ProgramPurityViolation[];

  constructor(violations: readonly ProgramPurityViolation[]) {
    super(`Program purity refusal: ${violations.map((violation) => `${violation.path} (${violation.kind})`).join(', ')}`);
    this.name = 'ProgramPurityError';
    this.violations = violations;
  }
}

export interface GeneratedProgramSource extends ProgramPurityFile {
  readonly sourceText: string;
}

export interface ProgramSourceGovernanceViolation {
  readonly path: string;
  readonly artifactKind: ArtifactKind;
  readonly governedArtifactKind: GovernedArtifactKind;
  readonly violation: GovernanceViolation;
}

export interface ProgramSourceGovernanceExemption {
  readonly path: string;
  readonly artifactKind: ArtifactKind;
  readonly governedArtifactKind: GovernedArtifactKind;
  readonly findingKinds: readonly GovernedConstructKind[];
}

export interface ProgramSourceGovernanceReport {
  readonly fatalViolations: readonly ProgramSourceGovernanceViolation[];
  readonly unavoidableExemptions: readonly ProgramSourceGovernanceExemption[];
}

export function assertProgramDirPurity(files: readonly ProgramPurityFile[]): void {
  const violations = files
    .filter((file) => isProgramTypeScriptPath(file.path))
    .filter((file) => !ALLOWED_PROGRAM_ARTIFACT_KINDS.has(file.kind))
    .map((file) => ({
      ...file,
      reason: 'per-program TypeScript must classify to an allowlisted generated artifact kind',
    }));

  if (violations.length > 0) {
    throw new ProgramPurityError(violations);
  }
}

export function enforcedConstructsForArtifact(kind: ArtifactKind | GovernedArtifactKind): ReadonlySet<GovernedConstructKind> {
  const active = activeEnforcedConstructs();
  if (kind !== 'projection') {
    return active;
  }
  return new Set([...active].filter((construct) => !PROJECTION_DEBT_EXEMPT.has(construct)));
}

export function scanGeneratedProgramSourceGovernance(
  files: readonly GeneratedProgramSource[],
): ProgramSourceGovernanceReport {
  const fatal: ProgramSourceGovernanceViolation[] = [];
  const unavoidable: ProgramSourceGovernanceExemption[] = [];

  for (const file of files) {
    if (!isProgramTypeScriptPath(file.path)) {
      continue;
    }
    const governedArtifactKind = governedArtifactKindFor(file.kind);
    if (!governedArtifactKind) {
      continue;
    }
    const findings = detectGovernedConstructs(file.sourceText);
    const violations = fatalGovernanceViolations(
      findings,
      governedArtifactKind,
      enforcedConstructsForArtifact(file.kind),
    );
    fatal.push(...violations.map((violation) => ({
      path: file.path,
      artifactKind: file.kind,
      governedArtifactKind,
      violation,
    })));
    if (findings.length > 0 && UNAVOIDABLE_ARTIFACT_KINDS.has(governedArtifactKind)) {
      unavoidable.push({
        path: file.path,
        artifactKind: file.kind,
        governedArtifactKind,
        findingKinds: uniqueFindingKinds(findings.map((finding) => finding.kind)),
      });
    }
  }

  return {
    fatalViolations: fatal,
    unavoidableExemptions: unavoidable,
  };
}

export function assertGeneratedProgramSourceGovernance(
  files: readonly GeneratedProgramSource[],
  options: {
    onUnavoidableExemption?: (exemption: ProgramSourceGovernanceExemption) => void;
  } = {},
): void {
  const report = scanGeneratedProgramSourceGovernance(files);
  for (const exemption of report.unavoidableExemptions) {
    options.onUnavoidableExemption?.(exemption);
  }
  if (report.fatalViolations.length === 0) {
    return;
  }
  throw new GovernanceRefusalError(
    report.fatalViolations[0]?.path ?? 'generated_program_source',
    report.fatalViolations.map((entry) => entry.violation),
  );
}

function isProgramTypeScriptPath(path: string): boolean {
  return /(?:^|\/)programs\/[^/]+\/(?!__tests__\/).+\.tsx?$/u.test(path);
}

function governedArtifactKindFor(kind: ArtifactKind): GovernedArtifactKind | undefined {
  switch (kind) {
    case 'handler':
      return 'reaction_handler';
    case 'tool':
    case 'registration':
    case 'contract':
      return 'resolver';
    case 'projection':
      return 'projection';
    case 'stage':
      return 'stage_body';
    case 'connector':
    case 'extract':
      return 'connector';
    case 'export':
      return 'byte_generator';
    default:
      return undefined;
  }
}

function uniqueFindingKinds(kinds: readonly GovernedConstructKind[]): GovernedConstructKind[] {
  return [...new Set(kinds)];
}
