# Changelog

## v3.27.2

- Engine alignment: generated scaffolds now target `@simodelne/pgas-server@3.27.2`.
- Reasoning contracts: added `record_array` fields for repeated-record `domain_spec.produces.result_json` schemas.
- Lead research: record-array extraction now declares array/object `P.*.<field>` state paths and uses `MAppend from_arg` so native tools receive and store structured lead records.
- Delegation enrichment scoping: `inputEnrichment` entries are scoped per child via `targetProgram` (engine 3.27.0 P4.2) when a delegation has multiple distinct child targets; single-child/all-target behavior is byte-identical (#290).
- Server config: exposed the typed `roundTimeoutMs` per-round liveness timeout (engine 3.27.1) in the foundry server and generated standalone scaffolds, resolved from `PGAS_ROUND_TIMEOUT_MS` (unset = env/5-minute default; `0` disables the watchdog) (#291).
- Generated-program hardening: gated the delegation `seeded_topic` invariant + smoke assertion on actual `request.topic` enrichment (dropped where a child is seeded a source, not a topic), and fixed the generated deterministic-path test to handle `decision_only` auto-hops and delegation fan-out topologies (#288).

## v3.26.0

- Lead-research-agent foundry line: added `config_driven_extraction_schema` as a synthesizable capability, with `web_navigation_guarded`, `cross_session_persistence`, and `export_pdf_report` registered as host-backed `scaffolds_with_gap`.
- Guarded web navigation: added deterministic anti-rogue guards G-1..G-7 for domain allowlists, bounded follow-on (`max_depth` / `max_pages` / `max_follow_links`), robots.txt, pacing (`min_delay_ms` / `max_concurrency`), no-spend, no-login, and immutable audit.
- Config-driven lead research: added per-source fan-out with allowed follow-on domains, purpose-scored extraction against `extraction_schema`, aggregation, dedupe/upsert, and guard/audit reporting.
- Graduation packaging: standalone scaffold generation now bundles typed host connector contracts, mocks, wiring, and report-data assembly for lead research, default-off and gap-gated until the curator implements real backends.

## v3.25.0

- Engine alignment: generated scaffolds now target engine `3.26.0` (from `3.24.0`) with the matching scaffold adaptations for `inputs.domain_context` seeding, deterministic-drive paths, and live-provider skip mode.
- Document-finalization synthesis: added cyclic conversational HUB topology, ad-hoc hub tools (`web_search` plus delegation-as-tool), `skill_triage` with skill catalog intake, selective section-artifact projection through `inline_world_query`, and durable channels with checkpoint/resume.
- Existing-repo product-path hardening: closed the 12-gap Option-b run through the foundry itself, covering skill-catalog intake, slug-safe delegation ids, manifest payload-map adaptation, upload plus ingest-delegation coexistence, Codex-author/Qwen-body split, deterministic export-stage bodies, canonical graduation verification status, live-provider `/models` probing, existing-repo `web_search` and live-drive import paths, reused-delegation child imports by slug, and the existing-repo smoke gate.
- Verification note: document-finalization was synthesized and static/hermetic-smoke verified; reused-delegation live UAT remains environment-bound to real simoneos and is graduated.

## v3.24.0

- Legal-opinion foundry line: pinned generated scaffolds to engine 3.24.0 (pgas#770) and hardened delegation, grounding, DOCX export hygiene, confirmation-loop completion, decision-only auto-advance export, drafting-stage projection, and propose_item payload tolerance. Together these changes synthesize a spotless Bahrain legal-opinion drafter end to end with no steering (#243-#255).
- Toolkit awareness: generated programs now surface the engine toolkit to agents, including state query, engine notebook, and session controls (#257).
- Audit remediation: repo-wide audit plus 13 batches fixed 4 HIGH bugs, closed MEDIUM findings, cleaned engine usage, added generated-helper parity harness coverage, and began the synthesizer.ts decomposition (#256, #258, #259, #260).
- Deferred: FC-11/FC-30 dedup and the remaining synthesizer.ts decomposition are intentionally carried forward.
