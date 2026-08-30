#!/usr/bin/env bash
#
# Same-byte consumer identity gate — consumer-canary contract 3.0.0
# (simodelne/pgas#1122, tracked here as pgas-new#335).
#
# WHY THIS EXISTS. Under contract 2.x this callable checked out mutable `main`.
# The callable DEFINITION was pinned by the caller's `uses:@SHA`, but the code
# under test was "whatever main is right now", so two runs of the same pinned
# callable could test different consumer bytes. A `pass` therefore certified a
# moment, not an artifact. Contract 3.0.0 makes the consumer bytes immutable and
# caller-declared: PGAS binds `uses:@HEAD` and `consumer-sha: HEAD` to the SAME
# value, and this gate refuses to run the product tests unless what landed on
# disk is exactly what was requested.
#
# CLASSIFICATION IS LOAD-BEARING (pgas#1122 binding amendment). A `consumer-sha`
# mismatch is a CONFIGURATION/INFRASTRUCTURE fault of the release plumbing — it
# is never evidence that the consumer's product regressed. It must therefore
# never surface as `fail`. This script emits `config_infra` and the caller maps
# that to `skip`, which still BLOCKS the release under the strict aggregate but
# attributes the block honestly.
#
# Exit codes:
#   0 = identity verified — safe to run the product tests
#   3 = config_infra — the requested/actual/callable identity does not agree
#
# Deliberately NOT exit 1: 1 is the canary's "product regression" code and
# reusing it here is exactly the misattribution the amendment forbids.

set -uo pipefail

REQUESTED=""       # inputs.consumer-sha, as the caller declared it
ACTUAL=""          # git rev-parse HEAD of the checked-out consumer tree
CONTRACT=""        # contract version this RUNNING callable definition declares
CALLABLE_FILE=""   # the callable definition AS CHECKED OUT at REQUESTED
EVIDENCE=""        # optional: file to append the durable tuple to
GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-}"

need_value() {
  # `shift 2` with only one argument left returns 1 WITHOUT shifting, so the
  # while-loop spins forever. That turns a millisecond config fault into a
  # 20-minute job timeout — the exact opposite of this gate's fail-fast intent.
  [ $# -ge 2 ] || { echo "missing value for $1" >&2; exit 3; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --requested)      need_value "$@"; REQUESTED="${2:-}"; shift 2 ;;
    --actual)         need_value "$@"; ACTUAL="${2:-}"; shift 2 ;;
    --contract)       need_value "$@"; CONTRACT="${2:-}"; shift 2 ;;
    --callable-file)  need_value "$@"; CALLABLE_FILE="${2:-}"; shift 2 ;;
    --evidence)       need_value "$@"; EVIDENCE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 3 ;;
  esac
done

FULL_SHA_RE='^[0-9a-f]{40}$'
problems=()

# (1) The requested SHA must be a FULL 40-hex commit id. A branch name, a tag, a
#     short SHA, or an empty string all reintroduce exactly the mutability this
#     contract removes — `main` most of all, which is the 2.x behaviour.
if [ -z "$REQUESTED" ]; then
  problems+=("consumer-sha is empty; contract 3.0.0 requires a caller-declared full commit SHA")
elif ! printf '%s' "$REQUESTED" | grep -Eq "$FULL_SHA_RE"; then
  problems+=("consumer-sha '${REQUESTED}' is not a full 40-hex commit SHA (a branch/tag/short SHA is mutable)")
fi

# (2) What actually landed on disk must be that exact commit. Catches a silently
#     failed/redirected checkout and any resolver that quietly fell back.
if [ -z "$ACTUAL" ]; then
  problems+=("actual checked-out HEAD is empty; the consumer tree was not resolved")
elif ! printf '%s' "$ACTUAL" | grep -Eq "$FULL_SHA_RE"; then
  problems+=("actual checked-out HEAD '${ACTUAL}' is not a full 40-hex commit SHA")
elif [ "$REQUESTED" != "$ACTUAL" ]; then
  problems+=("consumer-sha mismatch: requested '${REQUESTED}' but HEAD is '${ACTUAL}'")
fi

# (3) The callable DEFINITION that is running must agree with the definition at
#     the requested SHA.
#
#     HONEST SCOPE NOTE: a called reusable workflow cannot introspect its own
#     `uses:@SHA` pin — `github.workflow_ref`/`workflow_sha` resolve to the
#     CALLER's workflow, not the callee's. So this leg cannot compare commit ids
#     directly. What it CAN do is compare the contract version the running
#     definition declares against the one declared by the definition checked out
#     at `consumer-sha`. That catches the realistic drift this contract exists to
#     prevent — pinning `uses:` at a contract-3.0.0 callable while requesting a
#     consumer SHA from before 3.0.0 — without pretending to a check the platform
#     does not expose. The callable file digest is exported alongside so the
#     caller, which DOES know its own `uses:` pin, can close the loop.
CALLABLE_DIGEST="unavailable"
CHECKED_OUT_CONTRACT="unavailable"
# Both operands are REQUIRED. Previously an empty --contract (e.g. after someone
# renames the workflow's CONSUMER_CANARY_CONTRACT env key, which expands to ""
# under bash -e without error) or an omitted --callable-file made this whole leg
# vanish while the script still reported `ok`.
if [ -z "$CONTRACT" ]; then
  problems+=("--contract is empty; the running callable declares no contract version to compare against")
fi
if [ -z "$CALLABLE_FILE" ]; then
  problems+=("--callable-file is empty; the callable definition at the requested consumer SHA was never inspected")
else
  if [ ! -f "$CALLABLE_FILE" ]; then
    problems+=("callable definition '${CALLABLE_FILE}' is absent at the requested consumer SHA")
  else
    CALLABLE_DIGEST="$(sha256sum "$CALLABLE_FILE" | cut -d' ' -f1)"
    CHECKED_OUT_CONTRACT="$(sed -n 's/^[[:space:]]*CONSUMER_CANARY_CONTRACT:[[:space:]]*//p' "$CALLABLE_FILE" \
      | head -1 | tr -d '\r"'"'"'' | sed 's/[[:space:]]*$//')"
    if [ -z "$CHECKED_OUT_CONTRACT" ]; then
      CHECKED_OUT_CONTRACT="unavailable"
      problems+=("callable definition at the requested consumer SHA declares no CONSUMER_CANARY_CONTRACT")
    elif [ -n "$CONTRACT" ] && [ "$CHECKED_OUT_CONTRACT" != "$CONTRACT" ]; then
      problems+=("callable contract skew: running definition declares '${CONTRACT}' but the definition at the requested consumer SHA declares '${CHECKED_OUT_CONTRACT}'")
    fi
  fi
fi

if [ ${#problems[@]} -eq 0 ]; then
  CLASSIFICATION="ok"
else
  CLASSIFICATION="config_infra"
fi

# DURABLE TUPLE. Written BEFORE any non-zero exit, so a mismatch is still
# post-mortemable from the retained evidence artifact rather than inferable only
# from a red job.
emit_tuple() {
  echo "=== consumer identity (contract ${CONTRACT:-unknown}) ==="
  echo "requested_consumer_sha=${REQUESTED:-<empty>}"
  echo "actual_head=${ACTUAL:-<empty>}"
  echo "callable_contract_running=${CONTRACT:-<empty>}"
  echo "callable_contract_at_requested_sha=${CHECKED_OUT_CONTRACT}"
  echo "callable_definition_sha256=${CALLABLE_DIGEST}"
  echo "classification=${CLASSIFICATION}"
  for p in ${problems+"${problems[@]}"}; do
    echo "problem=${p}"
  done
  echo "=========================================="
}

emit_tuple
if [ -n "$EVIDENCE" ]; then
  mkdir -p "$(dirname "$EVIDENCE")"
  emit_tuple >> "$EVIDENCE"
fi
# Strip anything outside a conservative charset and bound the length, so a
# caller-supplied value can never introduce a newline (and therefore never inject
# an extra `classification=ok` line that would win by last-key-wins).
sanitize() { printf '%s' "${1:-}" | tr -cd '0-9a-zA-Z._-' | cut -c1-64; }

if [ -n "$GITHUB_OUTPUT_FILE" ]; then
  {
    echo "classification=$(sanitize "$CLASSIFICATION")"
    echo "requested_consumer_sha=$(sanitize "$REQUESTED")"
    echo "actual_head=$(sanitize "$ACTUAL")"
    echo "callable_definition_sha256=$(sanitize "$CALLABLE_DIGEST")"
  } >> "$GITHUB_OUTPUT_FILE"
fi

if [ "$CLASSIFICATION" = "ok" ]; then
  echo "OK — consumer identity verified; the bytes under test are exactly the requested SHA."
  exit 0
fi

echo "CONFIG_INFRA: consumer identity could not be verified — refusing to run product tests." >&2
for p in "${problems[@]}"; do echo "  - $p" >&2; done
exit 3
