#!/usr/bin/env bash
#
# pgas-new tier-1 canary executor (CONSUMER-CANARY-CONTRACT.md § 2.2, § 5 step 3).
#
# Answers exactly one question: does this pgas release candidate break the
# foundry's coupling to the engine's declarative surface?
#
# pgas-new is a CANONICAL consumer (it depends on @simodelne/pgas-server) but a
# POD-LESS one: no backend, no container, no deploy target. So unlike the
# simoneos reference there is no image build and no pod SSH — the archetype is
# "install the rc, typecheck against it, drive the engine-coupled paths".
#
# Exit codes are the contract (§ 2.2):
#   0 = pass  — the rc did not regress pgas-new's engine coupling
#   1 = fail  — behavioural regression caught (§ 2.3)
#   2 = skip  — infra error; we could NOT exercise the rc (§ 2.3)
#
# The distinction in § 2.3 is load-bearing and is why this script never lets a
# setup failure masquerade as a green run: a canary that "passes" without having
# actually loaded the rc is worse than no canary, because it certifies a release
# nobody exercised. See the RC-IDENTITY GATE below.

set -uo pipefail

TARBALL_DIR=""
RUN_ID="${CANARY_RUN_ID:-local}"

while [ $# -gt 0 ]; do
  case "$1" in
    --pgas-tarball-dir) TARBALL_DIR="${2:-}"; shift 2 ;;
    --run-id)           RUN_ID="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

EVIDENCE_DIR="qc/evidence/${RUN_ID}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/canary.log"

# ONE file in the evidence directory, deliberately.
#
# `upload-artifact-htpc` sets MAX_DIRECTORY_ENTRY_OBSERVATIONS = MAX_MEMBER_COUNT
# = 3 and counts EVERY entry it observes while walking the source directory —
# so a 4th file fails the upload with "source directory entry observations
# exceed bound", even on an otherwise clean pass. That is exactly what happened
# on the 6.1.2 RC1: the engine path returned CANARY_VERDICT=pass and the JOB
# still failed, afterwards, on the upload.
#
# So every transient capture below goes to a SCRATCH dir outside the evidence
# directory and is folded into this single log. Bound is 3; we use 1, which
# leaves headroom rather than sitting one file away from the same failure.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Everything this script prints is evidence (§ 4.2). `-a` appends, so the
# provenance header the workflow writes before this script runs is preserved.
exec > >(tee -a "$LOG") 2>&1

emit_verdict() {
  # Contract § 2.4: emit a verdict on EVERY path, including failure paths.
  echo "verdict=$1" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "CANARY_VERDICT=$1"
}

skip() { echo "SKIP (infra): $*"; emit_verdict skip; exit 2; }
fail() { echo "FAIL (regression): $*"; emit_verdict fail; exit 1; }

echo "=== pgas-new tier-1 canary — run ${RUN_ID} ==="
echo "tarball dir: ${TARBALL_DIR}"
date -u +"started: %Y-%m-%dT%H:%M:%SZ"

# ---------------------------------------------------------------- infra setup
[ -n "$TARBALL_DIR" ] || skip "--pgas-tarball-dir was not supplied"
[ -d "$TARBALL_DIR" ] || skip "tarball dir '$TARBALL_DIR' does not exist"

# ABSOLUTE path, deliberately. npm resolves a bare relative path like
# `pgas-rc/simodelne-pgas-server-6.0.0.tgz` as a GitHub `user/repo` SHORTHAND and
# tries to git-clone `ssh://git@github.com/pgas-rc/...` — caught by the first
# dry-run of this script. An absolute path is unambiguously a file spec.
SERVER_TGZ=$(find "$(cd "$TARBALL_DIR" && pwd)" -maxdepth 1 -name 'simodelne-pgas-server-*.tgz' | sort | head -1)
[ -n "$SERVER_TGZ" ] || skip "no simodelne-pgas-server-*.tgz found in '$TARBALL_DIR'"
[ -f "$SERVER_TGZ" ] || skip "resolved rc tarball '$SERVER_TGZ' is not a file"
echo "rc tarball: $SERVER_TGZ"

echo
echo "=== step 1/4: install baseline deps ==="
npm ci --no-audit --no-fund || skip "npm ci failed — cannot build a tree to test the rc in"

echo
echo "=== step 2/4: install the rc tarball ==="
# --no-save is REQUIRED, not stylistic. `npm install <tarball>` rewrites the
# dependency spec in package.json, and tests/unit/version.test.ts asserts that
# spec equals `^${PGAS_SERVER_VERSION}`. Without --no-save the canary would
# report `fail` for pin bookkeeping rather than for an engine regression —
# a false red, which under § 2.3 is exactly as harmful as a false green.
npm install --no-save --no-audit --no-fund "$SERVER_TGZ" \
  || skip "installing the rc tarball failed — the rc was never exercised"

# --------------------------------------------------------- RC-IDENTITY GATE
# The single most important check in this script.
#
# Everything below would happily pass against the PINNED engine if the install
# silently no-opped. pgas's own canary driver warns about precisely this shape:
# a canary that SUCCEEDED while ZERO consumers actually exercised the rc. So
# before drawing any conclusion, prove the bits under test are the rc's bits.
#
# A mismatch is `skip`, never `fail`: we have learned nothing about the rc, and
# claiming a regression we did not observe would be a fabricated signal.
echo
echo "=== step 3/4: RC-IDENTITY GATE — prove the rc is what is loaded ==="
INSTALLED=$(node -p "require('./node_modules/@simodelne/pgas-server/package.json').version" 2>/dev/null) \
  || skip "could not read the installed @simodelne/pgas-server version"
PINNED=$(node -p "require('./package.json').dependencies['@simodelne/pgas-server']" 2>/dev/null || echo "unknown")

echo "installed engine version: ${INSTALLED}"
echo "pgas-new's pinned spec:   ${PINNED}"

TARBALL_VERSION=$(basename "$SERVER_TGZ" | sed -E 's/^simodelne-pgas-server-(.+)\.tgz$/\1/')
echo "rc tarball version:       ${TARBALL_VERSION}"

if [ "$INSTALLED" != "$TARBALL_VERSION" ]; then
  skip "installed engine is ${INSTALLED} but the rc tarball is ${TARBALL_VERSION} — the rc is NOT loaded, so this run proves nothing about it"
fi
echo "OK — the engine under test IS the release candidate."

# ------------------------------------------------------- TOOLCHAIN PREFLIGHT
# Before any conclusion about the rc, prove the TEST RUNNER itself can boot in
# this environment. Without this, an environment fault is indistinguishable from
# an engine regression and gets reported as `fail` — a FALSE RED, which under
# § 2.3 is exactly as harmful as a false green: it blocks a good release.
#
# This is not hypothetical. The first dry-run of this script reported `fail`
# when the real cause was npm's long-standing optional-dependency bug
# (https://github.com/npm/cli/issues/4828) silently omitting
# `@rolldown/binding-linux-x64-gnu`, so vitest could not load vite at all and
# ZERO tests executed.
echo
echo "=== preflight: can the test runner boot at all? ==="
PREFLIGHT_TEST=tests/unit/version.test.ts   # tiny, imports no engine code
preflight() { npx vitest run "$PREFLIGHT_TEST" --config tests/vitest.config.ts --pool=threads; }

if ! preflight > "$SCRATCH/preflight.log" 2>&1; then
  echo "preflight failed — attempting the known npm optional-dependency repair"
  cat "$SCRATCH/preflight.log"
  if grep -q "Cannot find native binding\|Cannot find module '@rolldown/" "$SCRATCH/preflight.log"; then
    # Targeted, and deliberately best-effort: reinstall the optional binaries npm
    # skipped. If this does not fix it, we skip rather than guess.
    npm install --no-save --no-audit --no-fund --force \
      "@rolldown/binding-$(node -p 'process.platform + "-" + process.arch')-gnu" 2>&1 | tail -3 || true
  fi
  if ! preflight > "$SCRATCH/preflight-retry.log" 2>&1; then
    cat "$SCRATCH/preflight-retry.log" || true
    skip "the vitest toolchain cannot boot in this environment — no conclusion about the rc is possible (preflight output is inlined above)"
  fi
fi
echo "OK — the test runner boots; a red below is the ENGINE, not the environment."

# ------------------------------------------------------------- the real work
echo
echo "=== step 4/4: exercise pgas-new's engine coupling against the rc ==="

# (a) TYPECHECK. For a foundry this is a first-class behavioural signal, not a
#     lint: pgas-new consumes the engine's PUBLIC types to synthesize programs.
#     A breaking .d.ts change is a real consumer-visible regression even when
#     every runtime path still works.
echo
echo "--- (a) typecheck against the rc's published types ---"
if ! npm run typecheck; then
  fail "pgas-new no longer typechecks against the rc's public types"
fi
echo "OK — typechecks against the rc."

# (b) THE RENDER / DECISION / DELEGATED-CHILD PATHS. These drive real
#     synthesized programs end-to-end against the rc engine: capability: render
#     + RenderProvider + ArtifactStore + RenderSectionList, the author-less
#     decision_only export stage with its AfterMutation-scoped dispatch, and a
#     DELEGATED CHILD REACHING A TERMINAL MODE. They are hermetic (scripted
#     author, no provider, no GPU), which is what makes them a sound release
#     gate — a red here is the engine, not model nondeterminism.
#
#     WHY THE DELEGATED-CHILD LEG EXISTS (simodelne/pgas#1116 — do not remove).
#     PGAS 6.2.0 shipped GREEN through this canary while regressing delegated
#     children: `hub-tools-falsifier` was NOT in this list, and none of the
#     other five drives a child to a terminal mode. The generated child kept
#     proposing its `work -> complete` hop, the engine rejected the completing
#     call before translation (first-bad fe2c6d3e6 / pgas#1108 promoted a
#     presentation-only JSON-schema sentinel into a runtime admission
#     contract), so `work.done` was never written, the child burned its whole
#     round cap and settled `SC-9 failed` with the parent `degraded`. A canary
#     that cannot see that is not measuring the engine surface this foundry
#     actually depends on. `tests/unit/canary-lane-governance.test.ts` fails if
#     this entry is deleted.
echo
echo "--- (b) render + decision-only + delegated-child paths against the rc ---"
CANARY_TESTS=(
  tests/integration/render-section-list-falsifier.test.ts
  tests/integration/render-capability-falsifier.test.ts
  tests/integration/export-render-falsifier.test.ts
  tests/integration/export-decision-only-autoadvance-falsifier.test.ts
  tests/integration/pdf-report-export-falsifier.test.ts
  # Delegated child -> terminal mode (pgas#1116). Governance-locked; see above.
  tests/integration/hub-tools-falsifier.test.ts
)
for t in "${CANARY_TESTS[@]}"; do
  [ -f "$t" ] || skip "expected canary test '$t' is missing — the suite moved and this canary is measuring the wrong thing"
done

CANARY_OUT="$SCRATCH/canary-tests.log"
if ! npx vitest run "${CANARY_TESTS[@]}" --config tests/vitest.config.ts --pool=threads > "$CANARY_OUT" 2>&1; then
  cat "$CANARY_OUT" || true
  # Distinguish once more (§ 2.3): if the runner died rather than a test failing,
  # that is still infra. Only an actual test failure is a regression.
  if grep -q "Cannot find native binding\|Cannot find module '@rolldown/\|ENOSPC\|ECONNRESET" "$CANARY_OUT"; then
    skip "the test runner faulted mid-run (environment, not the rc)"
  fi
  fail "the rc regressed pgas-new's render / decision-only engine coupling"
fi
cat "$CANARY_OUT"
echo "OK — render + decision-only paths green against the rc."

echo
date -u +"finished: %Y-%m-%dT%H:%M:%SZ"
echo "=== PASS — rc ${TARBALL_VERSION} did not regress pgas-new ==="
emit_verdict pass
exit 0
