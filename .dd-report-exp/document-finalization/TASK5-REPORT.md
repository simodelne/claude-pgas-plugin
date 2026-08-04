# Task 5 Report - durable_channel + checkpoint/resume for the hub session

Date: 2026-08-04
Branch: `feat/foundry-durable-resumable-hub-session`

## Diagnosis

Installed engine: `@simodelne/pgas-server@3.26.0` from `node_modules/@simodelne/pgas-server/dist-bundle`.

What the engine already provides:

- `durable_channel` is a public feature, and channel schemas already expose `durable`/`durability`: `_shared-types.d.ts:132`, `_shared-types.d.ts:487-488`, `_shared-types.d.ts:1952-1955`.
- `runtime_control` already declares `pause`, `resume`, `stop`, and `checkpoint`: `_shared-types.d.ts:2736-2747`; route handlers expose resume/checkpoint controls at `create-server.mjs:27583-27603`.
- Session serialization already captures domain/artifacts/notebook/amendment state, governance, rounds, pending inputs, child ownership, control state, durable queue snapshot, recent envelopes, awaiting decision, and decision zone: `create-server.mjs:9027-9048`.
- `resumeSession` rehydrates domain/governance/decision, durable queue snapshot, mode, round number, running flag, rounds, protocol records, pending inputs, child ownership, control state, recent envelopes, and awaiting decision: `create-server.mjs:9073-9132`.
- Route-backed sessions already resume from persisted state through `getOrResume`: `create-server.mjs:15420-15473`.
- Regular route triggers persist serialized session state after each round: `create-server.mjs:12675-12679`.
- Checkpoint create/restore already snapshots live session state and restores the checkpoint back into the persisted session record: `create-server.mjs:26798-26848`; checkpoint API routes are mounted at `create-server.mjs:28115-28149`.

What `durable_channel` changes:

- The runtime only constructs a durable queue when the spec has feature `durable_channel` and at least one inbound channel has `durable: true`: `create-server.mjs:7872-7877`.
- Adapter input is only enqueued/dequeued and acked/nacked when both the feature and channel flag are present: `create-server.mjs:8961-9013`.
- The queue manager provides ordered delivery, retry/dead-letter behavior, and serialization/deserialization: `create-server.mjs:5980-6105`.
- YAML `durable: true` plus `durability.max_retries`/`ordering` compiles into the runtime channel config: `create-server.mjs:20340-20437`.

Real gap:

- BoundedSession + route checkpoint/resume already preserve hub domain state, including artifacts, notebook, and amendment records. The foundry gap was only synthesis opt-in: conversational hub specs did not declare `durable_channel` and did not mark the conversation entry channel durable.

## Synthesis Change

Changed `src/foundry-program/synthesizer.ts`:

- Detects whether the synthesized program contains a conversational hub: `src/foundry-program/synthesizer.ts:263-274`.
- Adds `durable_channel` only for those hub programs: `src/foundry-program/synthesizer.ts:370-379`.
- Marks the configured entry channel durable with FIFO retry metadata only for those hub programs: `src/foundry-program/synthesizer.ts:524-530`.

No custom checkpoint/resume machinery was added.

## Falsifier RED to GREEN

New falsifier:

```text
tests/integration/hub-durable-resume-falsifier.test.ts
```

Coverage:

- YAML feature/channel durable declarations: `tests/integration/hub-durable-resume-falsifier.test.ts:57-63`.
- Compiled runtime channel durable metadata: `tests/integration/hub-durable-resume-falsifier.test.ts:84-91`.
- File-backed route session create, checkpoint, restart, restore, and follow-up trigger: `tests/integration/hub-durable-resume-falsifier.test.ts:93-150`.
- Artifact, amendment, and notebook sentinel state: `tests/integration/hub-durable-resume-falsifier.test.ts:29-43`.

RED after fixture setup was corrected:

```text
$ npx vitest run --config tests/vitest.config.ts tests/integration/hub-durable-resume-falsifier.test.ts --pool=threads --maxWorkers=1
AssertionError: expected [ 'base', 'runtime_control', ...(2) ] to include 'durable_channel'
AssertionError: expected { direction: 'In', sync: 'Async' } to match object { durable: true, durability: ... }
AssertionError: expected { id: 'user_text', ...(8) } to match object { durable: true, durability: ... }
Test Files  1 failed (1)
Tests       1 failed (1)
Duration    1.46s
```

GREEN after the synthesizer change:

```text
$ npx vitest run --config tests/vitest.config.ts tests/integration/hub-durable-resume-falsifier.test.ts --pool=threads --maxWorkers=1
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    1.57s
```

## Verification Tails

```text
$ npm run typecheck
> pgas-new@3.24.0 typecheck
> tsc --noEmit
```

```text
$ npx vitest run --config tests/vitest.config.ts --pool=threads --maxWorkers=1 \
  tests/integration/hub-durable-resume-falsifier.test.ts \
  tests/integration/hub-mode-autoadvance-falsifier.test.ts \
  tests/integration/hub-selective-projection-falsifier.test.ts \
  tests/integration/hub-tools-falsifier.test.ts \
  tests/integration/skill-triage-falsifier.test.ts \
  tests/integration/generated-toolkit-awareness-falsifier.test.ts \
  tests/integration/confirmation-loop-terminal-advance-falsifier.test.ts \
  tests/integration/confirmation-engine-behavior.test.ts \
  tests/integration/export-decision-only-autoadvance-falsifier.test.ts \
  tests/unit/architectural-invariants.test.ts \
  tests/unit/stage-classifier.test.ts \
  tests/unit/synthesizer-confirmation-loop.test.ts \
  tests/unit/synthesizer-scale-safe-projection.test.ts
Test Files  13 passed (13)
Tests       37 passed (37)
Duration    18.13s
```

```text
$ env -u NPM_TOKEN npm run test:unit
Test Files  115 passed | 4 skipped (119)
Tests       746 passed | 14 skipped (760)
Duration    187.07s
```

```text
$ env -u NPM_TOKEN npm run test:static
PASS: Vitest suite passed
[6/6] optional generated scaffold install/test
SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run
=== Result: 8 pass, 0 fail ===
```

Legal-opinion re-synthesis/render check used a copied domain-synthesis cache and `/tmp` output; it rendered and imported the generated program without mutating `.dd-report-exp/legal-opinion`:

```json
{
  "renderedFiles": 46,
  "modes": 11,
  "childArtifacts": 2,
  "specOnlyDurable": false,
  "renderedDurable": false,
  "userText": { "direction": "In", "sync": "Async" },
  "compiledUserText": {
    "direction": "In",
    "sync": "Async",
    "durable": false,
    "durability": null
  }
}
```
