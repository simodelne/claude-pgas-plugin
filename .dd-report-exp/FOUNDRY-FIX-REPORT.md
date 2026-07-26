# Foundry Fix Report: Confirmation-Loop Tail Re-Arm

Date: 2026-07-26
Branch: `fix/confirmation-loop-tail-rearm`

## Diagnosed Root Cause

Observed from `.dd-report-exp/VERDICT-RERUN.md`: the DD-report generated program stalled after the final section approval because `approve_sections.propose_item` was an `awaits_user_decision` action with no `FieldFalsy work.report_sections.all_terminal` precondition. After the collection became terminal, the model called `propose_item` again for a done message, re-arming `awaits_user_decision` and suppressing the downstream `assemble_report` continuation. A manual generated-program patch adding that precondition plus prompt guidance let the program reach `complete_assemble_report`, render a DOCX, and complete.

Observed from the preserved DD driver: `.dd-report-exp/scripts/synthesize-dd.ts` uses the canonical `intake.interaction_json` `confirmation_loops` descriptor for `approve_sections`, with transition `approve_sections -> assemble_report` guarded by `work.report_sections.all_terminal`. The preserved generated spec had the manual workaround already applied, so it is evidence of the workaround, not the raw buggy output.

Observed in the synthesizer: the canonical confirmation-loop path emits `propose_item` in `applyConfirmationLoopIntentModeWiring` / `applyConfirmationLoopIntentActions`, emits the `compute_..._all_terminal` aggregate helper, and emits the forward transition guard. Before this fix it did not emit a mode precondition on the awaiting `propose_item` action, and it intentionally does not emit a non-awaiting `complete_<loop_stage>` action for confirmation-loop stages.

Inferred coverage hole: the existing "live-proven" choreography exercised a confirmation loop as the last substantive stage before `complete`. It proved the aggregate could become true and completion could be reached, but it did not cover `confirmation_loop -> gated downstream stage -> complete`, where a post-terminal re-armed await can suppress the downstream gated stage.

## Falsifier

Path: `tests/unit/synthesizer-confirmation-loop.test.ts`

Added test: `gates the awaiting propose action after a terminal loop before a downstream stage`.

The test synthesizes `intake -> plan_work -> review_work (confirmation_loop) -> assemble_work -> complete`, asserts that `review_work` advances to `assemble_work` on `work_units.all_terminal`, asserts there is no non-awaiting `complete_review_work` action, and requires `review_work.preconditions.propose_item` to contain `FieldFalsy work_units.all_terminal` plus prompt/guidance text not to call `propose_item` again.

RED output before the fix:

```text
> pgas-new@3.23.0 test:unit
> vitest run --config tests/vitest.config.ts --pool=threads --maxWorkers=1 tests/unit/synthesizer-confirmation-loop.test.ts

FAIL tests/unit/synthesizer-confirmation-loop.test.ts > confirmation_loop descriptor synthesis > gates the awaiting propose action after a terminal loop before a downstream stage
AssertionError: expected undefined to deeply equal [ { kind: 'FieldFalsy', ... } ]
  at tests/unit/synthesizer-confirmation-loop.test.ts:141

Test Files 1 failed (1)
Tests 1 failed | 6 passed (7)
```

GREEN output after the fix:

```text
> pgas-new@3.23.0 test:unit
> vitest run --config tests/vitest.config.ts --pool=threads --maxWorkers=1 tests/unit/synthesizer-confirmation-loop.test.ts

Test Files 1 passed (1)
Tests 7 passed (7)
Duration 1.40s
```

## Synthesizer Change

File/function: `src/foundry-program/synthesizer.ts`, `applyConfirmationLoopIntentModeWiring`.

Before: confirmation-loop stages included the awaiting `propose_item` action in mode vocabulary and added `user_confirmation` / `widget_output` channels, but did not prevent that awaiting action from firing after the aggregate guard became true.

After: the same canonical confirmation-loop path adds:

```yaml
preconditions:
  propose_item:
    - kind: FieldFalsy
      path: <loop.aggregate.guard_field>
```

Also updated `applyConfirmationLoopPrompts` and `applyConfirmationLoopGuidance` so generated authors are told not to call the propose action again or open another confirmation prompt once the aggregate guard is true.

I did not add a separate non-awaiting loop-completion action; the existing design still advances confirmation loops through the aggregate transition guard.

## Verification

`npm run typecheck`

```text
> pgas-new@3.23.0 typecheck
> tsc --noEmit
```

`npm run test:unit`

```text
Test Files 97 passed | 4 skipped (101)
Tests 691 passed | 14 skipped (705)
Duration 146.46s
```

`npm run test:static`

```text
PASS: Vitest suite passed
[6/6] optional generated scaffold install/test
PASS: generated scaffold install/typecheck/test passed

=== Result: 9 pass, 0 fail ===
```

`npm test` exact command on this shared host did not complete green: nested generated Vitest/Rolldown startup failed under resource pressure (`Resource temporarily unavailable` / `Rolldown panicked`) and one rerun then sat quiet after the nested foundry scaffold failure. The failed aggregate files all passed when rerun directly:

```text
npm run test:unit -- tests/sota/harness.test.ts
Test Files 1 passed (1)
Tests 4 passed (4)

npm run test:unit -- tests/integration/generated-delegation-smoke.test.ts
Test Files 1 passed (1)
Tests 4 passed (4)

npm run test:unit -- tests/integration/generated-multistage-smoke.test.ts
Test Files 1 passed (1)
Tests 1 passed (1)

npm run test:unit -- tests/integration/generated-upload-smoke.test.ts
Test Files 1 passed (1)
Tests 2 passed (2)

npm run test:unit -- tests/integration/foundry-end-to-end.test.ts
Test Files 1 passed (1)
Tests 4 passed (4)
Duration 33.28s
```

Non-skipping resource-limited aggregate verification:

```text
RAYON_NUM_THREADS=1 npm test

Test Files 97 passed | 4 skipped (101)
Tests 691 passed | 14 skipped (705)
Duration 172.38s

PASS: generated scaffold install/typecheck/test passed

=== Result: 9 pass, 0 fail ===
```

No existing tests were weakened or skipped.

## Capstone

Synthesis command:

```text
PGAS_PROVIDER=openai PGAS_OPENAI_BASE_URL=http://localhost:8000/v1 PGAS_OPENAI_MODEL=qwen36-27b PGAS_ROUND_TIMEOUT_MS=600000 node --import tsx .dd-report-exp/scripts/synthesize-dd.ts
```

Result:

```text
[synthesize-dd] rendered 51 files to /home/simone/pgas-new/.dd-report-exp/generated/dd-report-class-live
```

Zero-patch spec proof after re-synthesis:

```yaml
approve_sections:
  transitions:
    - target: assemble_report
      guard:
        kind: FieldTruthy
        path: work.report_sections.all_terminal
  preconditions:
    propose_item:
      - kind: FieldFalsy
        path: work.report_sections.all_terminal
```

The regenerated prompt also includes: `do not call propose_item again or open another confirmation prompt`.

Live-drive command:

```text
PGAS_PROVIDER=openai PGAS_OPENAI_BASE_URL=http://localhost:8000/v1 PGAS_OPENAI_MODEL=qwen36-27b PGAS_ROUND_TIMEOUT_MS=600000 node --import tsx .dd-report-exp/scripts/live-drive-dd.ts
```

Capstone live-drive did not reach `complete` in this worker. I stopped it after roughly ten minutes without a new `.dd-report-exp/raw/live-drive-raw.json` result. Partial logs show the unpatched regenerated program reached delegated `review_doc_3` (`session-logs/dd-report-class-live-1785065187417/session-log.ndjson`) but had not yet reached `approve_sections` or `assemble_report`. The local model endpoint was available (`GET /v1/models` returned `qwen36-27b`), so this is recorded as time-boxed/stalled before the approval/export tail, not as a reproduced foundry failure. No new DOCX was produced by this capstone attempt.

Capstone zero-patch completion: no.

## PR

TBD
