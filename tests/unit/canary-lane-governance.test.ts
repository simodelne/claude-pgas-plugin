/**
 * Governance lock for the tier-1 canary lane (simodelne/pgas#1116).
 *
 * WHY THIS FILE EXISTS. PGAS 6.2.0 shipped GREEN through the pgas-new release
 * canary while regressing delegated children: the canary drove render,
 * decision-only and export paths, but NOTHING drove a delegated child to a
 * terminal mode. The generated child's completing call was rejected before
 * translation (first-bad fe2c6d3e6 / pgas#1108), `work.done` was never written,
 * the child burned its whole round cap and settled `SC-9 failed` with the parent
 * `degraded` — and the release gate never saw it.
 *
 * A canary is only worth its `pass` if its coverage cannot silently shrink. This
 * file is the ratchet: deleting the delegated-child leg from `CANARY_TESTS`, or
 * gutting the assertions that make that leg meaningful, fails here.
 *
 * It deliberately asserts BEHAVIOUR-BEARING content, not just a filename — a
 * file present in the list but stripped of its terminal-completion assertions
 * would satisfy a naive membership check while measuring nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), 'utf8');

const CANARY_SCRIPT = 'qc/scripts/run-canary.sh';
const CALLABLE_WORKFLOW = '.github/workflows/tier1-canary-callable.yml';
const DELEGATED_CHILD_LEG = 'tests/integration/hub-tools-falsifier.test.ts';

/**
 * Extract the `CANARY_TESTS=( ... )` members exactly as bash would expand them:
 * one bare word per line, `#`-comment lines ignored.
 */
function canaryTests(script: string): string[] {
  const block = /^CANARY_TESTS=\(\n([\s\S]*?)^\)$/m.exec(script);
  if (block === null) throw new Error(`${CANARY_SCRIPT}: CANARY_TESTS array not found`);
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('tier-1 canary lane governance (pgas#1116)', () => {
  it('drives a delegated child to a terminal mode', () => {
    // THE RATCHET. Deleting this entry from run-canary.sh fails right here.
    expect(
      canaryTests(read(CANARY_SCRIPT)),
      `${CANARY_SCRIPT} must keep the delegated-child terminal-completion leg; ` +
        'pgas 6.2.0 shipped a delegated-child regression green precisely because it was absent',
    ).toContain(DELEGATED_CHILD_LEG);
  });

  it('lists only canary tests that actually exist', () => {
    // A canary naming a moved/renamed file measures nothing; run-canary.sh
    // skips on a missing entry, which blocks a release rather than passing it.
    for (const test of canaryTests(read(CANARY_SCRIPT))) {
      expect(() => read(test), `${CANARY_SCRIPT} lists a missing test: ${test}`).not.toThrow();
    }
  });

  it('keeps the delegated-child leg asserting terminal completion and a non-degraded parent', () => {
    // Membership alone is not coverage. These are the assertions that make the
    // leg able to catch the pgas#1116 shape: the child must reach a terminal
    // mode and the parent must not silently degrade.
    const leg = read(DELEGATED_CHILD_LEG);
    expect(leg, 'delegated-child leg must assert the settled child result').toContain(
      "'hub.delegation.research.settled'",
    );
    expect(leg, 'delegated-child leg must assert the parent did NOT degrade').toContain(
      "'hub.delegation.research.degraded'",
    );
    expect(
      leg,
      'delegated-child leg must assert the child returned its result, not a round-cap failure',
    ).toContain('RESEARCH_RESULT_PATH}.summary');
  });

  it('states in the script why the delegated-child leg may not be removed', () => {
    // Rationale-in-place: a future reader deleting the entry must first read
    // why it is there. Wording may evolve; the issue reference may not vanish.
    const script = read(CANARY_SCRIPT);
    expect(script, 'run-canary.sh must cite the issue that forced this leg').toContain('pgas#1116');
    expect(script.toLowerCase(), 'run-canary.sh lane wording must name the delegated-child leg')
      .toContain('delegated child');
  });

  it('advertises the delegated-child leg in the callable workflow summary', () => {
    // The step summary is what a human reads when triaging a canary verdict; it
    // must not claim a narrower archetype than the lane actually runs.
    expect(
      read(CALLABLE_WORKFLOW).toLowerCase(),
      `${CALLABLE_WORKFLOW} verdict annotation must name the delegated-child lane`,
    ).toContain('delegated-child');
  });
});
