# Foundry Gap Analysis - DD Report Class

Engine pin: `@simodelne/pgas-server@3.21.0` from `src/pgas-new/version.ts`.
Analysis SHA: `cae456eab8a5c725b017719a3170b088b12ffa45` (`main`, PR #231
merged).

The foundry is now credible for standalone, fixed-shape PGAS programs that
combine upload, static child delegation, per-item confirmation, and plain DOCX
export, but the latest DD-report runs show it is not yet a governed-program
foundry. The raw reduced program rendered 51 files, typechecked, passed static
gates, ingested real uploaded files, delegated three static child reviews, and
reached approval, but it did not complete or export without a foundry-tail
patch. That tail patch is now merged. The larger remaining gap is that the real
SimoneOS DD-report program needed governed repository embedding, metadata-only
data-room scale, bounded dynamic document batches, a frontend contract, and a
report-shaped artifact pipeline that the standalone scaffold still cannot emit.

## Closed This Cycle

- Confirmation-loop tail re-arm is closed: `.dd-report-exp/FOUNDRY-FIX-REPORT.md:8`
  names the observed root cause, `.dd-report-exp/FOUNDRY-FIX-REPORT.md:55-64`
  describes the emitted `FieldFalsy <all_terminal>` precondition and prompt
  guidance, `.dd-report-exp/FOUNDRY-FIX-REPORT.md:150-165` shows zero-patch
  re-synthesis emitted it automatically, and PR #231 is recorded at
  `.dd-report-exp/FOUNDRY-FIX-REPORT.md:177-179`.

## Gap Table

| Pri | Name | Observation | Claim status | Foundry vs model | Severity | Fix direction + falsifier | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Governed repo attach/embedding is not synthesized | The SimoneOS audit says pgas-new only ran `validate-manifest`, `plan-attach`, and `render-attach`, and "The generic rendered scaffold was not accepted as final behavior" (`/home/simone/simoneos/audit/PGAS-NEW-due-diligence-report.md:9-18`). The real program uses SimoneOS `patterns` (`specs.yml:40-67`), eRoom/DD service channels (`specs.yml:68-85`), per-mode projection (`specs.yml:335-462`), frontend spec (`frontend.spec.yml:174-291`), and repo tests (`audit/PGAS-NEW-due-diligence-report.md:26-40`). | Observed. Inference: standalone render does not satisfy governed-program acceptance. | Foundry-code/product gap, not qwen36 quality. | Blocks real governed programs. | Add an attach target that emits SimoneOS-governed specs, projection, frontend spec, registration, handlers, and tests into the host repo contract. Falsifier: foundry renders DD-report into a clean SimoneOS branch and `qc:onboard`, `specs:loadcheck`, typecheck, program tests, and frontend DOCX tests pass without discarding the scaffold. | L |
| 2 | Dynamic fan-out over N documents is absent; live DD used fixed child stages | The generated DD descriptor hard-codes `review_doc_1 -> review_doc_2 -> review_doc_3 -> aggregate` (`.dd-report-exp/raw-spec-context.json:235-256`) and exactly three children (`.dd-report-exp/raw-spec-context.json:312-385`). The raw verdict explicitly says delegation held as "three static child DD review sessions, not an in-program document loop" (`.dd-report-exp/VERDICT.md:62-67`) and "not dynamic fan-out" (`.dd-report-exp/VERDICT.md:122-124`). The registry admits single-child fan-out/dynamic targeting still refuse (`src/foundry-program/capability-registry.ts:66-69`; `src/foundry-program/synthesizer.ts:8047-8078`). | Observed. | Foundry-code gap. | Blocks variable-size DD/data-room programs. | Introduce a document queue/batch/fan-out synthesis primitive that creates child sessions from runtime document IDs instead of predeclared `doc1/doc2/doc3` stages. Falsifier: a five-document upload results in five child sessions, keyed by document ID, without adding five explicit review stages to the source descriptor. | L |
| 3 | Per-child delegation payload is not document-slice isolated | Each generated child maps `request.topic` to the full uploaded blob (`work.source.full_text`) (`.dd-report-exp/raw-spec-context.json:328-330`, `:352-354`, `:376-378`). In the capstone log, the `doc1` result says it analyzed all three VDR documents while the seeded topic was doc1 (`session-logs/dd-report-class-live-1785065187417/session-log.ndjson:320`). The governed implementation instead builds a payload from one document record (`tool-handlers.ts:1284-1308`). | Observed. Inference: giving every child the whole corpus caused cross-document bleed. | Foundry-code gap exposed through model behavior. | Blocks trustworthy document-level diligence; needs hand-patch for real DD. | Emit document extraction/registry state keyed by document ID and map each child to one document object or downloaded text/provenance. Falsifier: child prompt/world for doc1 contains no doc2/doc3 body text, and the child result cannot cite non-target document IDs. | M |
| 4 | Scale-safe per-mode projection is unproven and currently violated by generated DD | Generated `approve_sections` and `assemble_report` projections include broad state, `work.source.full_text`, every review result, and child delegation result fields (`.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/specs.yml:711-790`, `:791-823`). The real program's preamble forbids full document text/registry/raw child report dumps (`/home/simone/simoneos/programs/simoneos/due-diligence-report/specs.yml:15-21`) and its projection uses metadata windows, queue windows, summaries, active section context, and approved sections (`specs.yml:359-453`; `projection.ts:100-113`). | Observed. | Foundry-code gap. | Blocks hard/large governed programs; would fail scale and confidentiality constraints. | Add projection synthesis that is mode-specific, bounded, and redacts full corpus/raw child reports by default. Falsifier: a 1000-doc fixture has bounded prompt tokens and no full registry/body text in any model-visible projection. | L |
| 5 | Registry "live-proven" evidence is composition-incomplete | The registry requires live-drive hard gates before `synthesizes` (`capability-registry.ts:36-39`) and marks per-item confirmation, delegation, upload, docx extraction, and docx export as synthesized/live-proven (`capability-registry.ts:60-86`, `:111-114`). The live tests prove those as separate surfaces: confirmation loop ends at `complete` (`tests/integration/generated-live-drive.test.ts:540-573`), delegation is a parent plus one child (`:575-606` and `:608-639`), upload is standalone (`:641-671`), export is standalone (`:673-707`), and multi-child delegation is route-level/static (`tests/integration/multi-child-delegation-falsifier.test.ts:30-35`, `:74-154`). The confirmation-tail bug existed because `confirmation_loop -> gated downstream stage -> complete` was not covered (`.dd-report-exp/FOUNDRY-FIX-REPORT.md:14`). | Observed. Inference: registry status lacks a composition proof dimension. | Foundry evidence/governance gap, not model quality. | High trust risk; can hide composition gaps behind truthful isolated proofs. | Make registry evidence a matrix of isolated, pairwise, and DD-class compositions. Falsifier: each "live-proven" claim links to a run that actually exercised it in the downstream composition claimed, including confirmation -> export and delegation -> aggregation -> approval. | M |
| 6 | Capstone zero-patch live proof stalled upstream at `review_doc_3`; classification remains undetermined | Post-fix capstone re-synthesis emitted the guard automatically (`.dd-report-exp/FOUNDRY-FIX-REPORT.md:150-165`), but the capstone live-drive stopped before approval/export (`.dd-report-exp/FOUNDRY-FIX-REPORT.md:173-175`). Parent logs show `delegation_requested` for `doc3_call` and state persisted at `review_doc_3`, `running:true`, last terminal `request_doc3` (`session-logs/dd-report-class-live-1785065187417/session-log.ndjson:307`, `:319`, `:328-336`). Child doc3 entered delegation round 2 with no completion line in the captured log (`session-logs/doc3-1785065777895/session-log.ndjson:7-11`). | Observed stall; cause hypothesized only. | Undetermined: host/model latency/resource, child delegation flake, or parent/child composition. Do not classify as foundry-code root cause yet. | Blocks zero-patch capstone proof, not yet a proven foundry bug. | Rerun under no-load with full parent/child logs, provider latency counters, in-flight snapshots, and preserved timeout reason. Falsifier: repeated no-load runs complete through doc3 and approval/export, or failing logs pin a completed child result ignored by parent. | M |
| 7 | Domain-intake/stage classification needed manual steering before render | The initial unconstrained render failed: `reasoning contract synthesis failed for stage upload_docs after 4 attempts; ... result_schema.fields must declare 3..7 core fields; got 2` (`.dd-report-exp/VERDICT.md:22`; `.dd-report-exp/RAW_RENDER.attempt1.txt:2`). The run only rendered after a "domain-intake descriptor adjustment" (`.dd-report-exp/VERDICT.md:23`) and the verdict records the adjustment as marking `upload_docs` and `approve_sections` pure-compute/capability-driven after misclassification (`.dd-report-exp/VERDICT.md:92-99`). | Observed. | Foundry stage-classifier/domain-synthesis gap; model contributed only the failed contract output. | Needs pre-render hand steering for this class. | Detect upload/confirmation stages from documents/interaction descriptors before reasoning-contract synthesis, and fail with an actionable descriptor error if ambiguous. Falsifier: the original descriptor synthesizes zero-touch or refuses before attempting an invalid reasoning contract. | M |
| 8 | Generated DOCX export is a domain-state dump, not a governed report renderer | The patched rerun produced a real DOCX of 23,929 bytes with `section_count:37` (`.dd-report-exp/VERDICT-RERUN.md:36-43`). The generated export stage iterates all domain keys and renders stage outputs or any scalar `work.*` path (`.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/stages/assemble_report.ts:35-72`). The real program assembles only approved sections and charts into `dd_report_docx` (`tool-handlers.ts:635-666`; `specs.yml:996-1006`; `frontend.spec.yml:282-290`). | Observed. | Foundry-code/output-quality gap, not model quality. | Needs hand-patch for client-grade artifacts. | Synthesize report-specific artifact contracts that consume approved section drafts and findings, not arbitrary domain state. Falsifier: generated DOCX has only the approved report sections and charts, no internal stage/result keys or raw source dumps. | M |
| 9 | Generated static gates are too shallow for DD-class composition | Raw generated static gates passed 6 files / 7 tests, but the verdict caveat says they exercised upload behavior, not full upload + delegation + confirmation + export (`.dd-report-exp/VERDICT.md:27`). The raw live run then failed to reach export (`.dd-report-exp/VERDICT.md:75-80`). | Observed. | Foundry test harness gap. | Trust gap; can greenlight an incomplete scaffold. | Generate hermetic end-to-end static/composition tests for each declared capability chain, with fake child sessions, confirmation decisions, and artifact assertions. Falsifier: static gates fail before the live run on the raw confirmation-tail/downstream-export issue. | M |
| 10 | Rich frontend/governed approval UI is refused by the registry and absent from standalone render | Registry `rich_frontend` is `refuses` with "only basic widget projection" evidence (`src/foundry-program/capability-registry.ts:97-101`). The real DD frontend declares workspace layouts, focus panels, confirmation widgets, artifact lists, download actions, and completion surfaces (`frontend.spec.yml:174-291`) driven by derived projection fields (`projection.ts:60-135`). | Observed. | Foundry-code/product gap. | Blocks governed UX, especially approval-heavy programs. | Implement frontend-spec synthesis against the SimoneOS widget catalog and projection builder contract. Falsifier: generated DD attach emits a frontend spec with approval, revision, workspace context, artifact download, and tests pass against SimoneOS frontend registration. | L |
| 11 | Delegation is degrade-only; strict/continue semantics remain refused | Generated DD children are `optional:true` (`.dd-report-exp/raw-spec-context.json:332-335`, `:356-359`, `:380-383`). The synthesizer explicitly says v1 delegation is degrade-only and refuses `continue` mode and strict delegation when `optional !== true` (`src/foundry-program/synthesizer.ts:8047-8078`). The real governed DD program also marks its DD service channel optional (`specs.yml:79-85`), but real deal workflows need a policy choice between degrade, retry, and fail-closed. | Observed. Inference: current foundry cannot synthesize fail-closed DD child review. | Foundry-code gap. | Blocks high-assurance governed flows that cannot silently degrade missing reviews. | Add strict/continue delegation policies with typed timeout/failure propagation and retry/status modes. Falsifier: a generated strict child failure blocks or aborts with a typed user-visible error, while the happy path still reaches complete. | M |
| 12 | qwen36 structural conformance remains noisy under DD-scale prompts | Raw/capstone logs show repeated model outputs with multiple terminal actions rejected by GKStructural: raw approval round 13 returned three `propose_item` actions (`session-log.ndjson:599`), child doc3 had an initial "response must contain exactly one terminal action" gate miss (`session-logs/doc3-1785065777895/session-log.ndjson:9`), and earlier raw rounds also had structural/type retries (`session-log.ndjson:96`, `:183`, `:196`). Gates recovered in several cases. | Observed. | Model-quality/guard-load issue; not a foundry-code root cause unless prompts/projections are oversized or ambiguous. | Reliability/cost risk, not a direct foundry blocker by itself. | Reduce prompt state, make current action contracts narrower, and track retries as a model-quality metric separate from foundry failures. Falsifier: same program under bounded projections has near-zero GKStructural retries across repeated qwen36 runs. | S/M |
| 13 | Shared-host aggregate `npm test` is resource-fragile | `.dd-report-exp/FOUNDRY-FIX-REPORT.md:95-118` records exact `npm test` failures under resource pressure (`Resource temporarily unavailable` / Rolldown panic) while individual failed suites passed. `RAYON_NUM_THREADS=1 npm test` then passed 97 files / 691 tests plus static gates (`.dd-report-exp/FOUNDRY-FIX-REPORT.md:120-132`). `.dd-report-exp/rerun/zero-patch-long.json:5` also records a live-drive `Rate limit exceeded` harness error. | Observed. | Harness/infra gap, not synthesis and not qwen36 output quality. | CI/operator trust gap; can obscure real foundry regressions. | Bound workers/threads and rate-limit retries in the default aggregate command path or CI profile. Falsifier: exact default aggregate checks pass repeatedly on simone-lab without manual env overrides or nested Vitest/Rolldown resource failures. | S/M |

## Capability Registry Audit

- `per_item_confirmation`: live-proven in isolation as `plan_work -> review_work -> complete`
  (`tests/integration/generated-live-drive.test.ts:540-573`). The latest cycle proved
  the registry evidence was composition-incomplete for a downstream gated stage
  (`.dd-report-exp/FOUNDRY-FIX-REPORT.md:14`). Post-PR #231 synthesis now emits
  the missing precondition, but the post-fix zero-patch capstone did not reach the
  approval tail (`.dd-report-exp/FOUNDRY-FIX-REPORT.md:173-175`), so full
  zero-patch DD-class proof remains unproven.
- `delegation_child_session`: single live parent/child is proven
  (`tests/integration/generated-live-drive.test.ts:575-606`), and N distinct
  static children are route-level proven (`tests/integration/multi-child-delegation-falsifier.test.ts:30-35`,
  `:123-154`). Dynamic target/fan-out/continue/strict are explicitly refused
  (`src/foundry-program/synthesizer.ts:8047-8078`). The DD live run exercised
  static `doc1/doc2/doc3`, not dynamic N.
- `document_upload_intake`: isolated upload is live-proven
  (`tests/integration/generated-live-drive.test.ts:641-671`) and raw DD also
  ingested real markdown bytes (`.dd-report-exp/VERDICT.md:56-60`). This does
  not prove eRoom-scale metadata-only registry or bounded projection.
- `document_extraction_docx`: isolated DOCX extraction is live-proven in the
  registry (`src/foundry-program/capability-registry.ts:84-87`) but was not part
  of the latest DD run, which uploaded markdown fixtures.
- `export_docx_plain`: isolated export is live-proven
  (`tests/integration/generated-live-drive.test.ts:673-707`) and patched DD
  produced a real DOCX (`.dd-report-exp/VERDICT-RERUN.md:36-45`). The generated
  DD renderer is still domain-dump-shaped rather than governed-report-shaped
  (`stages/assemble_report.ts:35-72`).
- `rich_frontend`, `document_extraction_pdf`, `export_html`,
  `export_docx_trackchange`, and `loop_reset` are not open hidden live-proven
  claims: the registry marks them refused or scaffolded-with-gap
  (`src/foundry-program/capability-registry.ts:90-129`).

## Prioritized Roadmap

1. Make DD-report-class a first-class composition gate, not a set of isolated
   capability demos. The gate should require upload/eRoom registry, dynamic
   document fan-out, child result aggregation, per-section approval, downstream
   DOCX export, bounded projections, and artifact proof.
2. Close dynamic document fan-out plus document-slice isolation. This is the
   single highest-leverage next fix because governed DD cannot scale or remain
   trustworthy while every document child is a static stage fed the whole corpus.
3. Add bounded per-mode projection synthesis with explicit "no full registry /
   no full raw child reports / active section only" invariants.
4. Build governed SimoneOS attach synthesis: specs, patterns, projection,
   frontend spec, handlers, registration, and tests that pass in the target repo
   without discarding the rendered scaffold.
5. Replace the generic domain-dump DOCX stage with report-shaped artifact
   contracts that consume approved sections and findings.
6. Upgrade registry evidence from binary `synthesizes` to composition-scoped
   proof claims.
7. Deepen generated static gates so they fail on missing downstream composition
   before a live provider run.
8. Resolve the capstone `review_doc_3` stall with a controlled rerun before
   categorizing it as foundry, host, or model.
9. Add strict/continue delegation policies after dynamic fan-out is stable.
10. Stabilize shared-host verification defaults (`npm test`, nested Vitest,
    Rolldown, and live-drive rate limiting).

## Five-Level Honesty Summary

- Designed: The foundry can describe a reduced DD pipeline with upload,
  three static delegated review stages, aggregation, section drafting,
  per-item confirmation, and plain DOCX export. The real governed design also
  requires eRoom metadata pagination, bounded dispatch batches, projection
  windows, frontend widgets, and governed attach.
- Merged: PR #231 merged the confirmation-loop tail guard and guidance into the
  canonical synthesizer path. Registry entries still state broad
  `synthesizes` claims without composition-scoped proof metadata.
- Deployed: At SHA `cae456eab8a5c725b017719a3170b088b12ffa45`, standalone
  re-synthesis rendered 51 files and emitted the all-terminal `propose_item`
  precondition. Engine pin for this analysis is `@simodelne/pgas-server@3.21.0`.
- Invoked: Raw live invoked upload, static `doc1/doc2/doc3` child delegation,
  aggregate, draft, and approval, but not export. The patched rerun invoked
  export and produced a real DOCX. The post-fix zero-patch capstone invoked
  upload/delegation through `review_doc_3` but did not reach approval/export.
- Active: Real uploaded bytes, static child delegation, the patched approval
  tail, and plain DOCX emission are active/proven in the latest evidence. Dynamic
  N fan-out, governed SimoneOS embedding, scale-safe projection, rich frontend
  emission, strict delegation, and zero-patch DD-class completion remain
  genuinely unproven.
