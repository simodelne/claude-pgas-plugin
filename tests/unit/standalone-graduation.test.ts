import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handlers, reactionHandlers } from '../../src/foundry-program/handlers.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

// #107 — run_static_verification accepted a noncanonical status ("succeeded") via
// from_arg and persisted it verbatim, blocking the next gate (which requires the
// exact string "passed"). The handler now canonicalizes the reported status to
// the graduation enum.
describe('#107 run_static_verification canonicalizes the reported status', () => {
  async function staticStatus(status: string): Promise<unknown> {
    const result = await handlers.run_static_verification!({ status, evidence_id: 'x' } as never) as Record<string, unknown>;
    return result.status;
  }

  it('rewrites a verbose leading pass sentence to the canonical "passed"', async () => {
    expect(await staticStatus('passed: npm_typecheck and npm_test completed')).toBe('passed');
  });

  it('rewrites a synonym ("succeeded") to the canonical "passed"', async () => {
    expect(await staticStatus('succeeded')).toBe('passed');
  });

  it('canonicalizes common synonyms across the enum', async () => {
    expect(await staticStatus('success')).toBe('passed');
    expect(await staticStatus('OK')).toBe('passed');
    expect(await staticStatus('Completed')).toBe('passed');
    expect(await staticStatus('failure')).toBe('failed');
    expect(await staticStatus('n/a')).toBe('skipped');
  });

  it('passes already-canonical values through unchanged', async () => {
    expect(await staticStatus('passed')).toBe('passed');
    expect(await staticStatus('skipped')).toBe('skipped');
  });

  it('rejects an unrecognized status instead of masking it as passed', async () => {
    await expect(staticStatus('weird-custom')).rejects.toThrow(/verification status/i);
  });
});

describe('graduation verification status reactions canonicalize verbose status text', () => {
  const cases = [
    {
      reactionName: 'normalize_static_verification_status',
      statusPath: 'graduation.static_verification',
      evidencePath: 'graduation.static_verification_status_text',
      raw: 'passed: npm_typecheck and npm_test completed for document-finalization static verification',
    },
    {
      reactionName: 'normalize_smoke_verification_status',
      statusPath: 'graduation.smoke_verification',
      evidencePath: 'graduation.smoke_verification_status_text',
      raw: 'passed: generated-program smoke test completed',
    },
    {
      reactionName: 'normalize_live_verification_status',
      statusPath: 'graduation.live_verification',
      evidencePath: 'graduation.live_verification_status_text',
      raw: 'passed: live-provider verification completed',
    },
    {
      reactionName: 'normalize_rebase_static_verification_status',
      statusPath: 'graduation.rebase_verification',
      evidencePath: 'graduation.rebase_verification_status_text',
      raw: 'passed: post-rebase static verification completed',
    },
  ] as const;

  it.each(cases)('canonicalizes $statusPath and preserves the verbose text as evidence', ({ reactionName, statusPath, evidencePath, raw }) => {
    const reaction = reactionHandlers.get(reactionName);
    expect(reaction).toBeTypeOf('function');

    expect(reaction!(new Map<string, unknown>([[statusPath, raw]]), undefined as never, undefined as never)).toEqual({
      mutations: [
        { op: 'MSet', path: statusPath, value: 'passed' },
        { op: 'MSet', path: evidencePath, value: raw },
      ],
    });
  });

  it('canonicalizes recorded rebase status text and preserves the verbose text as evidence', () => {
    const reaction = reactionHandlers.get('normalize_rebase_status');
    const raw = 'passed: branch rebased cleanly on origin/main';
    expect(reaction!(new Map<string, unknown>([['graduation.rebase_status', raw]]), undefined as never, undefined as never)).toEqual({
      mutations: [
        { op: 'MSet', path: 'graduation.rebase_status', value: 'passed' },
        { op: 'MSet', path: 'graduation.rebase_status_text', value: raw },
      ],
    });
  });

  it('rejects ambiguous recorded verification text before the ladder can progress', () => {
    const reaction = reactionHandlers.get('normalize_static_verification_status');
    expect(() =>
      reaction!(new Map<string, unknown>([['graduation.static_verification', 'static checks looked okay']]), undefined as never, undefined as never),
    ).toThrow(/run_static_verification status must begin with "passed" or "failed"/i);
  });
});

// #106 — a fresh standalone output is not a git repo (or has no origin), so
// git_rebase_latest must skip the rebase gracefully instead of hard-failing on
// `git fetch origin`.
describe('#106 git_rebase_latest tolerates standalone targets without an origin', () => {
  it('returns passed (skip) when the target is not a git repository', async () => {
    const target = tempDir('pgas-new-standalone-rebase-');
    const result = await handlers.git_rebase_latest!({
      domain: { 'program.target_dir': target },
    } as never) as Record<string, unknown>;

    expect(result.status).toBe('passed');
    expect(String(result.reason)).toMatch(/standalone|origin/i);
  });

  it('returns passed (skip) when the target is a git repo with no origin remote', async () => {
    const target = tempDir('pgas-new-standalone-rebase-git-');
    execFileSync('git', ['init', '-q'], { cwd: target });
    const result = await handlers.git_rebase_latest!({
      domain: { 'program.target_dir': target },
    } as never) as Record<string, unknown>;

    expect(result.status).toBe('passed');
    expect(String(result.reason)).toMatch(/origin/i);
  });

  it('git_status reports clean/no-repo instead of failing on a non-git target', async () => {
    const target = tempDir('pgas-new-standalone-status-');
    const result = await handlers.git_status!({
      domain: { 'program.target_dir': target },
    } as never) as Record<string, unknown>;

    expect(result).toMatchObject({ clean: true, lines: [], not_a_git_repo: true });
  });
});

// A recorded rebase means git_rebase_latest succeeded or was a standalone no-op
// (conflicts throw and never record). The engine model predicts the status arg
// and, for a standalone target, may report known no-op/clean labels — which must
// still open the exact-"passed" rebase_verify gate. Ambiguous free text rejects.
// Regression: a live standalone drive stalled with
// graduation.rebase_status="no-op-standalone".
describe('normalize_rebase_status canonicalizes recorded rebase results', () => {
  const reaction = reactionHandlers.get('normalize_rebase_status');

  function resolve(status: string): unknown {
    const out = reaction!(new Map<string, unknown>([['graduation.rebase_status', status]]), undefined as never, undefined as never);
    return out;
  }

  it('is registered', () => {
    expect(reaction).toBeTypeOf('function');
  });

  it('maps a model-invented standalone no-op status to passed', () => {
    expect(resolve('no-op-standalone')).toEqual({
      mutations: [
        { op: 'MSet', path: 'graduation.rebase_status', value: 'passed' },
        { op: 'MSet', path: 'graduation.rebase_status_text', value: 'no-op-standalone' },
      ],
    });
  });

  it('maps skipped/known non-failure phrasings to passed', () => {
    for (const status of ['skipped', 'noop', 'not applicable', 'n/a', 'done', 'clean']) {
      const expectedMutations = [{ op: 'MSet', path: 'graduation.rebase_status', value: 'passed' }];
      if (['noop', 'not applicable', 'clean'].includes(status)) {
        expectedMutations.push({ op: 'MSet', path: 'graduation.rebase_status_text', value: status });
      }
      expect(resolve(status)).toEqual({ mutations: expectedMutations });
    }
  });

  it('is a no-op when already passed', () => {
    expect(resolve('passed')).toBeUndefined();
  });

  it('preserves an explicit failure (a real rebase conflict throws before recording, so this only fires on model-reported failures)', () => {
    expect(resolve('failed')).toBeUndefined();
    // Failure synonyms canonicalize to 'failed' and are preserved, never bumped to passed.
    expect(resolve('failure')).toEqual({
      mutations: [{ op: 'MSet', path: 'graduation.rebase_status', value: 'failed' }],
    });
    expect(resolve('error')).toEqual({
      mutations: [{ op: 'MSet', path: 'graduation.rebase_status', value: 'failed' }],
    });
  });

  it('rejects ambiguous free-text rebase status before the ladder can progress', () => {
    expect(() => resolve('branch looked clean after manual review')).toThrow(
      /git_rebase_latest status must begin with "passed" or "failed"/i,
    );
  });
});
