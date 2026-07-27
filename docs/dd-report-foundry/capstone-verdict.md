# Gap 6 Capstone Report

Date: 2026-07-27
Repository: `/home/simone/pgas-new`
Main commit: `1af8ae77a5b950cfedbdfe8b8d7decfe9d110b3a`
Phase/artifacts prefix: `gap6-capstone-live-drive`

## Headline

The reduced DD-report-class run reached runtime `complete` and produced a real DOCX with **0 generated-program patches**. The strict harness summary still reports `ok: false` because its `terminal` boolean is `false`, even though the session log records `session_terminal` at round 31 with `mode: complete` and `running: false`.

Important measurement findings:

- Confirmation-tail re-arm is confirmed end-to-end: approval converged with 3 accepted sections and no generated patch.
- Delegation did not stall: all three child sessions completed and the parent collected them.
- Document-slice isolation is statically emitted, but not confirmed end-to-end: child outputs show missing document request/text context.
- Static projection include lists are bounded, but the final persisted/export world still contains `work.source.full_text`, and the DOCX includes a `Work Source Full Text` section.

## Commands

Re-synthesis:

```bash
PGAS_PROVIDER=openai \
PGAS_OPENAI_BASE_URL=http://localhost:8000/v1 \
PGAS_OPENAI_MODEL=qwen36-27b \
PGAS_ROUND_TIMEOUT_MS=600000 \
node --import tsx .dd-report-exp/scripts/synthesize-dd.ts
```

Live drive:

```bash
PGAS_PROVIDER=openai \
PGAS_OPENAI_BASE_URL=http://localhost:8000/v1 \
PGAS_OPENAI_MODEL=qwen36-27b \
PGAS_ROUND_TIMEOUT_MS=600000 \
DD_EXP_DRIVE_TIMEOUT_MS=2400000 \
DD_EXP_PHASE=gap6-capstone \
DD_EXP_OUT=.dd-report-exp/raw/gap6-capstone-live-drive.json \
DD_EXP_DOCX=.dd-report-exp/raw/gap6-capstone-live-drive.docx \
node --import tsx .dd-report-exp/scripts/live-drive-dd.ts
```

The extra `DD_EXP_DRIVE_TIMEOUT_MS=2400000` kept the total-drive wall clock within the requested approximately 40 minute allowance while preserving the 600000 ms per-round timeout.

## Static Re-synthesis Check

Verdict:

- Confirmation-tail precondition: **Y**
- Document-slice child payloads: **Y, static emission**
- Bounded projections: **Y, static projection include lists**

Evidence:

```text
.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/specs.yml:269-272
preconditions:
  propose_item:
    - kind: FieldFalsy
      path: work.report_sections.all_terminal
```

```text
.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/registration.ts:19
delegationPolicy: { allowedTargetPrograms: ['doc1', 'doc2', 'doc3'], inputEnrichment: [{ source: 'work.source.current_document.text', target: 'request.topic' }, { source: 'inputs.initial_user_text', target: 'domain_context.original_request' }, { source: 'work.source.current_document.id', target: 'request.document_id' }, { source: 'work.source.current_document.name', target: 'request.document_name' }] }
```

```text
.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/specs.yml:827-830
path: work.source.current_document
from_arg: document_slice_doc1
from_state: work.source.documents.0

.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/specs.yml:864-867
path: work.source.current_document
from_arg: document_slice_doc2
from_state: work.source.documents.1

.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/specs.yml:901-904
path: work.source.current_document
from_arg: document_slice_doc3
from_state: work.source.documents.2
```

Structured projection check:

```json
{
  "hasTail": true,
  "projectionModeCount": 10,
  "badProjectionPaths": []
}
```

Note: the regenerated spec still contains `work.source.full_text` inside author/domain prompt strings and action descriptions. The bounded-projection check above is specifically over projection include paths.

## Zero-patch Reach

Generated-program patch count: **0**

Classification:

- F foundry-gap patches: 0
- D domain patches: 0
- E harness patches: 0

Generated tree hash after the run:

```text
0fe927921d8967d7c13cca55e3741feeb8c65b8ca2762e7e9aba420de20dae4f  -
```

Generated file mtimes remained at synthesis time, before the live drive:

```text
2026-07-27 13:07 .dd-report-exp/generated/dd-report-class-live/src/programs/doc2/specs.yml
2026-07-27 13:07 .dd-report-exp/generated/dd-report-class-live/src/programs/doc3/specs.yml
2026-07-27 13:07 .dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/specs.yml
2026-07-27 13:07 .dd-report-exp/generated/dd-report-class-live/src/server.ts
```

Runtime result summary:

```json
{
  "ok": false,
  "final_mode": "complete",
  "terminal": false,
  "status": "Completed",
  "rounds": 31,
  "triggers": 21,
  "provider_hits": 113,
  "provider_exchange_count": 113,
  "confirmation": {
    "decisions_sent": 3,
    "approved_count": 3,
    "all_terminal": true
  },
  "export": {
    "docx_base64_present": true,
    "decoded_docx_bytes": 26488,
    "wrote_docx": true,
    "docx_path": ".dd-report-exp/raw/gap6-capstone-live-drive.docx",
    "section_count": 49
  }
}
```

Terminal evidence from `session-logs/dd-report-class-live-1785157730597/session-log.ndjson`:

- line 1215: `modeBeforeRound: "assemble_report"`, `modeAfterRound: "complete"`
- line 1217: `status_changed` from `Running` to `Completed`
- line 1224: `type: "session_terminal"`, `round: 31`, `mode: "complete"`, `running: false`

Mode trail:

```text
intake -> upload_docs -> review_doc_1 -> review_doc_2 -> review_doc_3 -> aggregate -> draft_sections -> approve_sections -> assemble_report -> complete
```

Terminal action trail ended with:

```text
round 25 propose_item
round 26 propose_item
round 27 propose_item
round 28 __fallback__
round 29 session_status
round 30 complete_assemble_report
```

The round 28 fallback was caused by qwen proposing `assemble_report` while still in `approve_sections`; the run recovered without edits via `session_status`, entered `assemble_report`, then completed.

## DOCX Proof

Path: `/home/simone/pgas-new/.dd-report-exp/raw/gap6-capstone-live-drive.docx`
Size: `26488 bytes`

`unzip -l`:

```text
Archive:  .dd-report-exp/raw/gap6-capstone-live-drive.docx
  Length      Date    Time    Name
---------  ---------- -----   ----
      794  1980-00-00 00:00   [Content_Types].xml
      588  1980-00-00 00:00   _rels/.rels
      197  1980-00-00 00:00   docProps/app.xml
      307  1980-00-00 00:00   docProps/core.xml
    23544  1980-00-00 00:00   word/document.xml
      390  1980-00-00 00:00   word/styles.xml
---------                     -------
    25820                     6 files
```

`word/document.xml` text hits:

```text
      1 3.4x
      2 Apex Retail
      2 Executive Summary
      6 IP portfolio
      2 Key Findings
      1 OSHA
      3 Red Flags and Significant Findings
      6 Vendor A
      1 Work Source Full Text
      6 change-of-control
      1 covenant breach
      9 customer concentration
      1 unresolved litigation
```

The DOCX is structurally valid and contains report sections plus red-flag/finding evidence. The `Work Source Full Text` hit is also evidence of the runtime/export corpus-leak finding.

## Delegation Boundary

There was no delegation stall.

Child summary:

```json
{
  "doc1": {
    "status": "complete",
    "sessionId": "doc1-1785158075338",
    "rounds": 2,
    "mode": "complete",
    "seeded_topic_excerpt": "",
    "red_flags_json": "[]",
    "settled": true,
    "degraded": false
  },
  "doc2": {
    "status": "complete",
    "sessionId": "doc2-1785158341620",
    "rounds": 2,
    "mode": "complete",
    "seeded_topic_excerpt": "dd-report-class-live",
    "red_flags_json": "[{\"flag\":\"Compliance Delay\",\"severity\":\"Medium\",\"description\":\"Vendor B and C have not renewed ISO certifications by the deadline.\"},{\"flag\":\"Invoice Variance\",\"severity\":\"High\",\"description\":\"Vendor A shows consistent 15% over-invoicing compared to delivery receipts.\"}]",
    "settled": true,
    "degraded": false
  },
  "doc3": {
    "status": "complete",
    "sessionId": "doc3-1785158472661",
    "rounds": 2,
    "mode": "complete",
    "seeded_topic_excerpt": "",
    "red_flags_json": "[]",
    "settled": true,
    "degraded": false
  }
}
```

Boundary finding: the static `inputEnrichment` uses `work.source.current_document`, but the child sessions did not show real per-document context in their outputs:

- `doc1-1785158075338`: final output says "No specific document ID or name provided in inputs".
- `doc2-1785158341620`: first output says no specific text was provided; final output used `seeded_topic: "dd-report-class-live"` and invented `Document_02_Supply_Chain_Audit.pdf`/Vendor A facts.
- `doc3-1785158472661`: outputs say no specific text content was provided in the delegation context.

Parent collection did work: parent world contains all three `review_doc_N.delegation.docN.result` objects, all `settled: true`, all `degraded: false`, and the parent advanced through `aggregate`, `draft_sections`, approval, export, and `complete`.

## Runtime Projection/World Check

Final world snapshot:

```json
{
  "work_source_full_text": "string",
  "full_text_len": 1302,
  "current_doc_name": "01_customer-contracts.md",
  "current_doc_text_len": 416,
  "fan_out_results": false,
  "source_doc_count": 3
}
```

So:

- No raw `fan_out.results` leak was observed.
- `work.source.full_text` remained in final persisted world state.
- The DOCX export also rendered `Work Source Full Text`.

This means static bounded projection emission passed, but bounded projection is not confirmed end-to-end under the "no corpus leak in world" criterion.

## Fix Composition

Confirmation-tail re-arm: **confirmed end-to-end**. Regenerated spec contains `FieldFalsy work.report_sections.all_terminal`; live run accepted 3 sections, set `all_terminal: true`, reached `assemble_report`, then `complete`, with 0 generated patches.

Document-slice isolation: **static emission confirmed, end-to-end not confirmed**. The generated parent policy and document-slice mutations use `work.source.current_document`, but child outputs show they did not receive usable per-document request/text content.

Dynamic fan-out: **not directly exercised**. This domain is static-3. All 3 child sessions were spawned, completed, settled, and collected by the parent.

Scale-safe/bounded projection: **static emission confirmed, end-to-end not confirmed**. Projection include lists contain no `work.source.full_text`, no `work.source.documents`, and no raw `fan_out.results`; final persisted world/DOCX still carried `work.source.full_text`.

## Verdict

Reduced DD-report-class reached runtime `complete` plus a real DOCX with **ZERO generated-program patches**: **YES**.

Strict harness `ok`/`terminal` proof: **NO** (`ok: false`, `terminal: false`, while session log shows `session_terminal` at round 31).

No stall occurred. The main real finding is not a liveness stall; it is a boundary/projection composition issue: child delegation completed but did not receive usable document-slice request context, and the final world/export still exposed whole-corpus `work.source.full_text`.
