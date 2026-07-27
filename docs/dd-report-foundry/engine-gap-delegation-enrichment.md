# Gap A Runtime Slice Delivery Report

Date: 2026-07-27
Branch: `fix/delegation-slice-runtime-delivery`
Base: `origin/main` at `1af8ae77`
Verdict: ENGINE-BLOCKED

## Diagnosed Root Cause

The static foundry synthesis is correct, but the pinned public engine does not deliver
`delegationPolicy.inputEnrichment` into the child session's declared round-0 request
domain.

Observed static synthesis:

- `.dd-report-exp/generated/dd-report-class-live/src/programs/dd-report-class-live/registration.ts:19`
  registers `inputEnrichment` from:
  - `work.source.current_document.text` -> `request.topic`
  - `work.source.current_document.id` -> `request.document_id`
  - `work.source.current_document.name` -> `request.document_name`
- `.dd-report-exp/generated/dd-report-class-live/src/programs/doc1/specs.yml:78`
  and `.dd-report-exp/generated/dd-report-class-live/src/programs/doc1/specs.yml:123`
  include `inputs.request`, `inputs.request.topic`, `inputs.request.document_id`,
  and `inputs.request.document_name` in child projections.

Observed parent dispatch logs:

- `session-logs/dd-report-class-live-1785157730597/session-log.ndjson:524`
  is round 15 in `review_doc_1`, terminal `request_doc1`.
  The accepted delegation payload is only:
  `{"topic":"Due Diligence Review of Customer Contracts","query":"Analyze legal and financial risks in customer contracts."}`.
  The round mutations only mark the request as requested and copy this short object into
  `review_doc_1.delegation.doc1.request`; no document text is present in the action payload.
- `session-logs/dd-report-class-live-1785157730597/session-log.ndjson:566`
  is round 16, after child 1 returns. It sets `work.source.current_document` for the
  next stage only after the prior child result is completed.
- `session-logs/dd-report-class-live-1785157730597/session-log.ndjson:727`
  and `session-logs/dd-report-class-live-1785157730597/session-log.ndjson:831`
  repeat the same short top-level `topic/query` dispatch shape for docs 2 and 3.

Observed child logs:

- `session-logs/doc1-1785158075338/session-log.ndjson:1` starts child round 0 with a
  small prompt, not a document-sized prompt.
- `session-logs/doc1-1785158075338/session-log.ndjson:25` returns
  `seeded_topic:""` and says no document ID or name was provided.
- `session-logs/doc2-1785158341620/session-log.ndjson:17` says no specific text was
  provided in the delegation context.
- `session-logs/doc3-1785158472661/session-log.ndjson:17` says no specific text was
  provided in the delegation context.

Observed engine boundary:

- `node_modules/@simodelne/pgas-server/dist-bundle/testing.mjs:20267` builds the child
  initial-domain patches from the raw delegation payload before enrichment. It only
  seeds `inputs.domain_context` and `inputs.request.*` from `payload.domain_context`
  and `payload.request`.
- `node_modules/@simodelne/pgas-server/dist-bundle/testing.mjs:14061` creates the child
  session and applies that raw initial domain before `inputEnrichment` is resolved.
- `node_modules/@simodelne/pgas-server/dist-bundle/testing.mjs:14069` then applies
  `inputEnrichment` to a separate `enrichedInput` object.
- `node_modules/@simodelne/pgas-server/dist-bundle/testing.mjs:13847` builds the child
  trigger event from that enriched object.
- `node_modules/@simodelne/pgas-server/dist-bundle/testing.mjs:13780` converts an object
  payload for the child `user_text` channel into text. If the object has a top-level
  `query`, it returns only that query string, discarding nested enriched
  `request.topic`, `request.document_id`, and `request.document_name`.

Root cause, observed vs inferred:

- Observed: the child projection declares the request paths, so this is not a projection
  omission.
- Observed: the engine creates and seeds the child initial domain from the raw payload
  before applying `inputEnrichment`.
- Observed: the enriched payload is then converted to the child `user_text` trigger;
  because the raw payload had top-level `query`, the nested enriched request fields are
  not delivered through that trigger either.
- Inferred from the above engine path: foundry synthesis cannot force hidden parent
  state into the child round-0 `inputs.request.*` using the pinned public delegation API.
  It would have to ask the parent model to copy document text into the raw effect payload,
  which is not deterministic slice isolation and reintroduces the bug class.

Classification: payload shaping / engine delivery semantics. Timing contributes to the
static per-doc flow, but the decisive boundary is that per-dispatch `inputEnrichment`
does not seed the child's declared request domain.

## Falsifier Status

Stopped before adding a tracked failing test per the engine-boundary rule. A hermetic
route-level falsifier for the desired behavior should assert:

- synthesize the per-document delegation program;
- upload documents with distinct sentinel text;
- drive the parent to `request_docN`;
- inspect the child round-0 domain/projection, or the child service's accepted delegated
  request payload;
- require doc N's sentinel under `inputs.request.topic` or equivalent declared child
  request path;
- reject empty, slug, or another document's sentinel.

Expected result on `1af8ae77`: RED, because `inputEnrichment` is applied after child
initial-domain seeding and is not routed into `inputs.request.*`.

No RED->GREEN test was committed because the minimal correct fix requires an upstream
engine surface rather than foundry-only synthesis.

## Required Upstream Engine Request

Add a public delegation API/behavior that materializes per-dispatch enrichment into the
child's initial round-0 domain before the first child prompt is built. Acceptable forms:

1. Apply `delegationPolicy.inputEnrichment` before `buildInitialDomainPatches`, and build
   those patches from the enriched payload.
2. Add a public `initialDomainEnrichment` or `delegationRequestPayloadBuilder` surface
   that can map parent-world paths into child declared paths such as
   `inputs.request.topic`, `inputs.request.document_id`, and
   `inputs.request.document_name`.
3. Emit route-test-visible audit metadata showing the raw payload, enriched payload,
   accepted child initial-domain patches, and skipped enrichment paths.

The engine should preserve nested `request.*` enrichment when the child declares those
request paths, instead of relying on `toDelegatedText` for `user_text`.

## Verification

No production code was changed. Full verification commands were not run because this is
an engine-blocked diagnosis rather than a foundry synthesis patch.

Cheap static confirmation: the existing Gap-3 slice-isolation unit covers the static
mapping and remains conceptually orthogonal. The observed failure is runtime delivery of
that mapping into the child session.

## PR

No PR was opened. The requested runtime fix needs upstream engine support in
`@simodelne/pgas-server`; patching private bundled internals would violate the
engine-boundary rule.
