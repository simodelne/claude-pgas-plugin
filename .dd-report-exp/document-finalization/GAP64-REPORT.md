# GAP-DF-6.4 Report

## Constraint Relaxation

- Relaxed the former document/delegation same-host-stage mutual exclusion in `src/foundry-program/synthesizer.ts:10618`.
- The replacement compatibility gate is `documentDelegationCompatibilityErrors` at `src/foundry-program/synthesizer.ts:10652`.
- A same-stage child is accepted only when it is a required upload descriptor feeding the reusable `document-ingest` identity and its payload maps are:
  - `request.documents=work.document.documents`
  - `request.extraction_contract=work.document.extraction_contract`
- Genuinely incompatible same-stage children remain rejected before approval with a repair message at `src/foundry-program/synthesizer.ts:10688`.
- The reusable delegation intake path now always runs compatibility validation, even without available-program metadata, through `src/foundry-program/handlers.ts:443` and `src/foundry-program/synthesizer.ts:730`.

## Upload To Delegation Wiring

- `normalizeDocumentIngestDelegation` wires the same-stage `document-ingest` child payload after manifest resolution at `src/foundry-program/synthesizer.ts:2262`.
- The generated payload is `request.documents -> work.document.documents` and `request.extraction_contract -> work.document.extraction_contract`, while preserving unrelated maps such as `domain_context.original_request`.
- The parent schema now declares the document collection, extraction contract, and artifact fields in `applyDocumentsSchema` at `src/foundry-program/synthesizer.ts:1751` and `collectDocumentsSchemaPaths` at `src/foundry-program/synthesizer.ts:11142`.
- `artifact_shape` is preserved on the descriptor at `src/foundry-program/synthesizer-store.ts:54` and used by the extraction contract at `src/foundry-program/synthesizer.ts:2097`.
- The same-stage `document_ingest` action gets a `FieldTruthy(work.document_ready)` precondition at `src/foundry-program/synthesizer.ts:1353`, so upload/host extraction settles before delegation.

## Child Result To Document Artifacts

- `settle_document_ingest_delegation.write_scope` includes `work.document.summary`, `work.document.sections`, section fields, and `work.document.ingest_result_harvested` through `documentIngestHarvestWriteScope` at `src/foundry-program/synthesizer.ts:1452`.
- Compatible same-stage `document-ingest` children use `settleDocumentIngestDelegationResult` via `renderDelegationReactionEntries` at `src/foundry-program/synthesizer.ts:4894`.
- The generated settle helper starts at `src/foundry-program/synthesizer.ts:5012`; on `status=complete`, it writes the child result into `work.document.summary`, `work.document.sections`, concrete section paths, and `work.document.ingest_result_harvested`.
- The helper accepts structured output from top-level result fields, nested `result`, `structured_data`, or `pipeline_result.structured_data`, and normalizes section/clauses arrays or objects into `{id, heading, status, text}`.

## Falsifier

- Added the product-path falsifier at `tests/integration/foundry-repo-targeting-flow.test.ts:31`.
- The test drives the real foundry session Q1-Q6, records a document descriptor on `ingest`, records `record_q5_delegation` to manifest `document-ingest` on the same `ingest` stage, approves, advances to synthesis, and asserts the generated spec contains the upload descriptor plus same-stage ingest delegation.
- RED on the origin/main behavior with the falsifier patch:
  - Command: `npx vitest run tests/integration/foundry-repo-targeting-flow.test.ts -t "allows upload descriptor" --reporter=dot`
  - Failure: `documents descriptor and delegation.children[0] must not share host stage ingest`
  - Stack included `src/foundry-program/synthesizer.ts:10324` and `src/foundry-program/handlers.ts:622`.
- GREEN after the fix:
  - Command: `npx vitest run tests/integration/foundry-repo-targeting-flow.test.ts -t "allows upload descriptor" --reporter=dot`
  - Tail: `Test Files 1 passed (1); Tests 1 passed | 7 skipped (8); Duration 2.14s`.

## Additional Regression Coverage

- Updated document descriptor unit coverage at `tests/unit/documents-descriptor.test.ts:169` to accept the valid same-stage upload-to-`document-ingest` shape.
- Added pre-approval repair coverage at `tests/unit/documents-descriptor.test.ts:187` for incompatible same-stage delegation children.
- Full existing foundry product path suite passed:
  - Command: `npx vitest run tests/integration/foundry-repo-targeting-flow.test.ts --reporter=dot`
  - Tail: `Test Files 1 passed (1); Tests 8 passed (8); Duration 1.70s`.
- Existing document/upload/extraction/delegation suites passed:
  - Unit group tail: `Test Files 7 passed (7); Tests 57 passed (57); Duration 1.69s`.
  - Integration group tail: `Test Files 7 passed (7); Tests 15 passed (15); Duration 8.83s`.
- `foundry-end-to-end` did not Abort locally:
  - Command: `npx vitest run tests/integration/foundry-end-to-end.test.ts --reporter=dot`
  - Tail: `Test Files 1 passed (1); Tests 4 passed (4); Duration 23.25s`.

## Requested Verification

- `npm run typecheck`: passed, tail `pgas-new@3.24.0 typecheck` / `tsc --noEmit`.
- `env -u NPM_TOKEN npm run test:unit`: passed, tail `Test Files 116 passed | 4 skipped (120)` and `Tests 755 passed | 14 skipped (769)`.
- `env -u NPM_TOKEN npm run test:static`: passed, tail `=== Result: 8 pass, 0 fail ===`; optional generated scaffold install/test skipped because `NPM_TOKEN` was unset.
- Legal-opinion re-synthesis passed:
  - `timeout 300s env -u NPM_TOKEN node --import tsx .dd-report-exp/legal-opinion/scripts/synthesize-legal-opinion.ts`
  - Tail: rendered 46 files to `.dd-report-exp/legal-opinion/generated/legal-opinion-drafter`.
- Legal-opinion static/render checks passed:
  - Static tail included `bad_projection_paths: []`, `capability_gaps: []`, and `export_surfaces: { docx: true }`.
  - Render tail included `"ok": true`, `"section_count": 89`, `"approved_content_count": 89`, and `"forbidden_substring_hits": []`.

## Scope Notes

- No simoneos files were modified.
- No secrets or package-token dependent paths were used.
- Code-review subagents were not spawned because the available multi-agent tool policy requires an explicit user request for spawning agents; deterministic self-review and verification were used instead.
