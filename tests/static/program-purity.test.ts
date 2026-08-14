import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PROGRAM_ARTIFACT_KINDS,
  ProgramPurityError,
} from '../../src/foundry-program/program-purity.js';
import { kindForRequestedArtifact } from '../../src/pgas-new/artifact-plan.js';
import { renderExistingRepoAttachment } from '../../src/pgas-new/template-renderer.js';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';
import { renderRepresentativeCorpus } from '../fixtures/representative-corpus.js';

const MANIFEST: WiringManifest = {
  schema_version: 1,
  repo: { kind: 'existing_repo', package_manager: 'npm' },
  pgas: {
    server_package: '@simodelne/pgas-server',
    allowed_imports: [
      '@simodelne/pgas-server/plugin.js',
      '@simodelne/pgas-server/create-server.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/channels/index.js',
      '@simodelne/pgas-server/routes/index.js',
    ],
  },
  paths: {
    programs_dir: 'programs',
    audit_dir: 'audit',
    pgas_new_dir: '.pgas/pgas-new',
  },
  registration: { strategy: 'curator_request' },
  verification: {
    commands: {
      install: 'npm install --no-audit --no-fund',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    },
  },
  curator: {
    github_owner: 'simodelne',
    github_repo: 'simoneos',
  },
};

describe('program purity backstop', () => {
  it('renders the representative corpus without non-allowlisted per-program TypeScript', async () => {
    const programs = await renderRepresentativeCorpus();
    const violations = programs.flatMap((program) =>
      program.files
        .map((file) => ({
          corpusName: program.corpusName,
          path: file.path,
          planKind: file.planKind,
          classifierKind: kindForRequestedArtifact(file.path),
        }))
        .filter((file) =>
          file.planKind !== file.classifierKind ||
          !ALLOWED_PROGRAM_ARTIFACT_KINDS.has(file.classifierKind)));

    expect(violations).toEqual([]);
  });

  it('does not classify retired report-data.ts as an allowed generated program artifact', () => {
    expect(kindForRequestedArtifact('src/programs/lead-research-agent/report-data.ts')).toBe('metadata');
  });

  it('KILL TEST: refuses an unclassified per-program TypeScript file at render time', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-program-purity-rogue-'));
    try {
      expect(() => renderExistingRepoAttachment({
        repoRoot,
        slug: 'review',
        name: 'Review',
        manifest: MANIFEST,
        requestedArtifactPaths: ['programs/review/lead-reasoner.ts'],
      })).toThrow(ProgramPurityError);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
