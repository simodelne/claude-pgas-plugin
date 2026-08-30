/**
 * Consumer-canary contract 3.0.0 — same-byte callable governance
 * (simodelne/pgas#1122, tracked as pgas-new#335).
 *
 * WHAT CHANGED AND WHY. Under contract 2.x this callable checked out mutable
 * `main`. The callable DEFINITION was pinned by the caller's `uses:@SHA`, but
 * the code under test was "whatever main is right now" — so the same pinned
 * callable could test different consumer bytes on two runs, and a `pass`
 * certified a moment rather than an artifact. 3.0.0 makes the consumer bytes
 * caller-declared and immutable.
 *
 * THE KILL-PROOF IS REAL. The mismatch cases below execute
 * `qc/scripts/verify-consumer-sha.sh` — the exact bytes the workflow step runs —
 * rather than asserting against a YAML string. A test that only pattern-matched
 * the workflow would keep passing if the gate logic rotted underneath it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(repoRoot, 'qc/scripts/verify-consumer-sha.sh');
const CALLABLE = '.github/workflows/tier1-canary-callable.yml';
const callable = readFileSync(join(repoRoot, CALLABLE), 'utf8');

const SHA_A = '5e521fc9d74480b9c8c87565296fddc7c8969be1';
const SHA_B = '12f83d21760a5c86d3ff6f8daf9697c07dbb729b';

/** Run the real gate; return its exit code and combined output. */
function runGate(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [GATE, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function callableFileDeclaring(contract: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-callable-'));
  const file = join(dir, 'tier1-canary-callable.yml');
  writeFileSync(file, `env:\n  CONSUMER_CANARY_CONTRACT: ${contract}\n`);
  return file;
}

describe('contract 3.0.0 consumer identity gate — retained kill-proof', () => {
  it('passes only when the requested SHA, the actual HEAD and the contract all agree', () => {
    const { code, out } = runGate([
      '--requested', SHA_A, '--actual', SHA_A,
      '--contract', '3.0.0', '--callable-file', callableFileDeclaring('3.0.0'),
    ]);
    expect(code, out).toBe(0);
    expect(out).toContain('classification=ok');
  });

  // DELIBERATE MISMATCH KILL-PROOF, retained per the pgas#1122 binding
  // amendment. Each case must fail, and must fail as config_infra — exit 3,
  // never exit 1 (which is the canary's product-regression code).
  it.each([
    ['requested SHA differs from the checked-out HEAD', [SHA_A, SHA_B, '3.0.0']],
    ['a branch name is passed instead of a commit (the contract 2.x behaviour)', ['main', SHA_A, '3.0.0']],
    ['a short SHA is passed', [SHA_A.slice(0, 7), SHA_A, '3.0.0']],
    ['consumer-sha is empty', ['', SHA_A, '3.0.0']],
    ['the checked-out HEAD could not be resolved', [SHA_A, '', '3.0.0']],
  ])('fails closed as config_infra when %s', (_case, [requested, actual, contract]) => {
    const { code, out } = runGate([
      '--requested', requested, '--actual', actual,
      '--contract', contract, '--callable-file', callableFileDeclaring('3.0.0'),
    ]);
    expect(code, `expected config_infra exit 3, got ${code}\n${out}`).toBe(3);
    expect(code, 'exit 1 is the product-regression code and must never be used here').not.toBe(1);
    expect(out).toContain('classification=config_infra');
  });

  it('verifies clean against the REAL callable file, not just a synthesized stub', () => {
    // Finding 7: the extraction was only ever exercised against bytes the test
    // itself wrote. Quoting, trailing whitespace or a CRLF checkout would produce
    // a FALSE skew and block a healthy release with nothing catching it.
    const { code, out } = runGate([
      '--requested', SHA_A, '--actual', SHA_A,
      '--contract', '3.0.0', '--callable-file', join(repoRoot, CALLABLE),
    ]);
    expect(code, out).toBe(0);
    expect(out).toContain('callable_contract_at_requested_sha=3.0.0');
  });

  it.each([
    ['--contract is empty (e.g. the workflow env key was renamed)',
     ['--requested', SHA_A, '--actual', SHA_A, '--contract', '']],
    ['--callable-file is omitted entirely',
     ['--requested', SHA_A, '--actual', SHA_A, '--contract', '3.0.0']],
  ])('refuses to silently skip the skew leg when %s', (_case, args) => {
    // A gate that disappears when its operands go missing is not a gate: both of
    // these previously reported `ok` with leg 3 never having run.
    const { code, out } = runGate(args as string[]);
    expect(code, out).toBe(3);
    expect(out).toContain('classification=config_infra');
  });

  it('fails fast instead of hanging when a flag is missing its value', () => {
    // `shift 2` with one argument left does not shift, so the parse loop spun
    // forever — turning a millisecond config fault into a 20-minute job timeout.
    const started = Date.now();
    const { code } = runGate(['--requested']);
    expect(code).toBe(3);
    expect(Date.now() - started, 'must fail fast, not spin').toBeLessThan(10_000);
  });

  it('cannot have its classification flipped by a newline in a caller value', () => {
    // $GITHUB_OUTPUT is last-key-wins, so an injected `classification=ok` line
    // would turn a genuine mismatch green.
    const outFile = join(mkdtempSync(join(tmpdir(), 'pgas-new-gho-')), 'out.txt');
    writeFileSync(outFile, '');
    try {
      // The gate exits 3 here (config_infra) — that is the expected outcome, so
      // the throw is swallowed deliberately; the assertion is on what it WROTE.
      execFileSync('bash', [GATE,
        '--requested', 'deadbeef\nclassification=ok', '--actual', SHA_A,
        '--contract', '3.0.0', '--callable-file', join(repoRoot, CALLABLE),
      ], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_OUTPUT: outFile } });
    } catch {
      /* expected: config_infra exits 3 */
    }
    const written = readFileSync(outFile, 'utf8');
    expect(written.match(/^classification=/gm), 'exactly one classification line').toHaveLength(1);
    expect(written).toContain('classification=config_infra');
    expect(written).not.toContain('classification=ok');
  });

  it('detects uses:@SHA / consumer-sha skew via the callable contract version', () => {
    // The realistic drift: PGAS pins `uses:` at a 3.0.0 callable but requests a
    // consumer SHA from before 3.0.0 existed.
    const { code, out } = runGate([
      '--requested', SHA_A, '--actual', SHA_A,
      '--contract', '3.0.0', '--callable-file', callableFileDeclaring('2.0.2'),
    ]);
    expect(code, out).toBe(3);
    expect(out).toContain('callable contract skew');
  });

  it('writes the durable identity tuple even on the failing path', () => {
    // A mismatch must be post-mortemable from the retained evidence artifact,
    // not merely inferable from a red job.
    const evidence = join(mkdtempSync(join(tmpdir(), 'pgas-new-evidence-')), 'canary.log');
    runGate([
      '--requested', SHA_A, '--actual', SHA_B,
      '--contract', '3.0.0', '--callable-file', callableFileDeclaring('3.0.0'),
      '--evidence', evidence,
    ]);
    const written = readFileSync(evidence, 'utf8');
    expect(written).toContain(`requested_consumer_sha=${SHA_A}`);
    expect(written).toContain(`actual_head=${SHA_B}`);
    expect(written).toContain('classification=config_infra');
    expect(written).toContain('callable_definition_sha256=');
  });
});

describe('contract 3.0.0 callable declaration', () => {
  it('requires consumer-sha with no default', () => {
    const input = /consumer-sha:\n\s+description:.*\n\s+required: true\n\s+type: string/;
    expect(callable, `${CALLABLE} must declare a required consumer-sha input`).toMatch(input);
    // A default would silently restore mutable-`main` behaviour the first time a
    // caller forgot the input — the exact fault 3.0.0 removes.
    const block = /consumer-sha:\n(?:\s+\w[^\n]*\n)+/.exec(callable)?.[0] ?? '';
    expect(block, 'consumer-sha must NOT be defaulted').not.toContain('default:');
  });

  it('checks out the declared SHA and never mutable main', () => {
    expect(callable).toContain('ref: ${{ inputs.consumer-sha }}');
    expect(
      /repository: simodelne\/pgas-new\n\s+ref: main/.test(callable),
      'the consumer checkout must not resolve mutable main',
    ).toBe(false);
  });

  it('declares the contract version the gate greps for', () => {
    expect(callable).toMatch(/^\s*CONSUMER_CANARY_CONTRACT:\s*3\.0\.0\s*$/m);
  });

  it('runs the identity gate before the product tests', () => {
    // Ordering is the whole point: bytes we cannot identify must never produce a
    // product signal, and must not burn a test run.
    //
    // Match the INVOCATION, not the script name. An earlier version of this test
    // searched for the bare filename and kept passing when the gate call was
    // replaced with `true` — the name still appeared in a header comment above.
    // Asserting on a mention rather than a call is not coverage.
    const gateAt = callable.indexOf('bash pgas-new/qc/scripts/verify-consumer-sha.sh');
    const testsAt = callable.indexOf('bash qc/scripts/run-canary.sh');
    expect(gateAt, 'callable must actually INVOKE the identity gate, not merely mention it')
      .toBeGreaterThan(-1);
    expect(testsAt, 'callable must still invoke the canary script').toBeGreaterThan(-1);
    expect(gateAt, 'the identity gate must precede the product tests').toBeLessThan(testsAt);
  });

  it('binds the gate invocation to the declared inputs', () => {
    // A gate invoked with the wrong operands is a gate that cannot fail. Pin the
    // operands so the call cannot be quietly defanged into a no-op.
    const step = callable.slice(callable.indexOf('bash pgas-new/qc/scripts/verify-consumer-sha.sh'));
    // Via env, never string-interpolated into `run:` — the validator must not be
    // the injection site for the value it validates.
    expect(step).toContain('--requested "$CONSUMER_SHA"');
    expect(callable).toContain('CONSUMER_SHA: ${{ inputs.consumer-sha }}');
    expect(
      callable.includes('--requested "${{ inputs.consumer-sha }}"'),
      'consumer-sha must not be interpolated directly into a run: block',
    ).toBe(false);
    expect(step).toContain('--actual "$(git -C pgas-new rev-parse HEAD)"');
    expect(step).toContain('--contract "${CONSUMER_CANARY_CONTRACT}"');
    expect(step).toContain('--evidence');
  });

  it('classifies an identity fault as config_infra and never as a product fail', () => {
    expect(callable).toContain('classification=config_infra');
    const verdictStep = callable.slice(callable.indexOf('- name: Resolve verdict'));
    expect(verdictStep, 'an identity fault must resolve to skip, not fail').toContain('verdict=skip');
    expect(callable).toContain("value: ${{ jobs.canary.outputs.classification }}");
  });

  it('does not let an identity fault fail the job and swallow the outputs', () => {
    // Finding 1: GitHub does not propagate workflow_call outputs from a FAILED
    // job. Without continue-on-error the skip/config_infra mapping never reaches
    // the caller and the aggregate just sees a hard-failed canary — the pgas#1122
    // amendment satisfied in the string and violated at the job level.
    const gateStep = callable.slice(
      callable.indexOf('- name: Same-byte consumer identity gate'),
      callable.indexOf('- name: Download pgas rc tarballs'),
    );
    expect(gateStep, 'the identity step must not fail the job').toContain('continue-on-error: true');
  });

  it('skips every product step when identity is unverified', () => {
    // continue-on-error must not mean "carry on and test anyway".
    for (const step of ['Download pgas rc tarballs', 'Verify exact candidate manifest', 'Run canary script']) {
      const at = callable.indexOf(`- name: ${step}`);
      expect(at, `${step} step missing`).toBeGreaterThan(-1);
      expect(
        callable.slice(at, at + 400),
        `${step} must be gated on identity success`,
      ).toContain("if: steps.identity.outcome == 'success'");
    }
  });

  it('checks out pgas before the gate so evidence survives an identity fault', () => {
    // Finding 2: `Upload evidence` uses a LOCAL action under ./pgas/. If that
    // checkout came after the gate, an identity fault would leave the action
    // unresolvable and discard the durable tuple — losing the record on exactly
    // the failure it exists for.
    const pgasCheckout = callable.indexOf('- name: Checkout pgas (for the htpc artifact action');
    const gate = callable.indexOf('- name: Same-byte consumer identity gate');
    expect(pgasCheckout).toBeGreaterThan(-1);
    expect(pgasCheckout, 'pgas checkout must precede the identity gate').toBeLessThan(gate);
  });

  it('keeps the merged pgas#1116 delegated-child probe', () => {
    // Contract 3.0.0 must not quietly drop the coverage #1116 forced in.
    const script = readFileSync(join(repoRoot, 'qc/scripts/run-canary.sh'), 'utf8');
    expect(script).toContain('tests/integration/hub-tools-falsifier.test.ts');
    expect(script).toContain('pgas#1116');
  });
});
