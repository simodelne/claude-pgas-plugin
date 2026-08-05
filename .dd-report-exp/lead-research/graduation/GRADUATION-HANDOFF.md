# Lead Research Agent Graduation Handoff

## Program
Lead Research Agent is a config-driven guarded web/social lead-research PGAS program. It fans out over configured public
sources, performs bounded guarded navigation through host connectors, extracts leads and contacts against a configured
schema, dedupes and persists them across sessions, and renders a structured PDF report.

Design spec reference: `docs/superpowers/specs/2026-08-05-lead-research-agent-design.md`.

## Staged Package
- Domain intake: `.dd-report-exp/lead-research/lead-research-agent-domain.json`
- Clean generated program: `.dd-report-exp/lead-research/generated/`
- Re-synthesis helper: `.dd-report-exp/lead-research/resynthesize-lead-research.ts`
- Full hermetic smoke: `tests/integration/lead-research-hermetic-smoke.test.ts`
- Re-synthesis summary: `.dd-report-exp/lead-research/resynthesis-summary.json`

The staged helper re-synthesizes the standalone scaffold into `.dd-report-exp/lead-research/generated/`. It does not
mutate simoneos or any consumer repo.

## Foundry Delivered
- A reusable lead-research program shape driven by `sources`, `purpose`, `extraction_schema`, and `guard_config`.
- Typed host-connector contracts, generated mocks, generated wiring, and report-data assembly for the three host-backed
  gaps: guarded web navigation, cross-session persistence, and PDF rendering.
- Deterministic anti-rogue web-navigation guards and bounded per-source follow-on, enforced by generated spec structure
  and the connector contract rather than by LLM compliance.
- A default-off, gap-gated standalone scaffold that remains fully drivable against mocks before the curator swaps in real
  backends.

## Smoke Proofs
- Capability assessment in `tests/integration/lead-research-hermetic-smoke.test.ts` asserts `refuses=[]` and
  `unknown=[]`.
- The same smoke asserts `config_driven_extraction_schema` synthesizes and the three host-backed capabilities
  `web_navigation_guarded`, `cross_session_persistence`, and `export_pdf_report` appear in `scaffolds_with_gap`.
- The full hermetic drive reaches terminal `complete` against generated mock connectors.
- The drive harvests a `pdf_report` artifact, confirms the report bytes contain the configured title, and confirms
  `work.audit` is non-empty with guard actions.

## Host Connectors To Implement
The foundry ships typed contracts, mocks, and wiring. The curator must replace the mocks with real implementations in the
graduated standalone repo.

### `WebNavigationHostConnector`
Contract: `navigate_and_extract(source, purpose, extraction_schema, guard_ctx) -> { items[], pages_visited, audit[] }`.

Real implementation: wire pgas-web's guarded Playwright driver and guard logic from `/home/simone/pgas-web` as the
engine-agnostic backend. Start from the driver and guard sources such as `/home/simone/pgas-web/src/driver/browser-driver.ts`,
`/home/simone/pgas-web/src/driver/robots.ts`, and the pgas-web guard tests/docs, then adapt them to this connector
contract.

The real connector must honor the G-1..G-7 obligations verbatim:
- G-1 Domain allowlist: navigation is confined to configured `sources` domains plus explicitly allowed follow-on domains;
  off-list navigation is refused.
- G-2 Follow-on bounding: `max_depth`, `max_pages`, and `max_follow_links` are hard caps for each source; bounded
  follow-on cannot wander beyond those limits.
- G-3 No-spend: payment, purchase, checkout, or other spend actions are refused.
- G-4 No-login: v1 is public-only; credential submission and login retries are refused.
- G-5 Immutable audit log: every navigate, follow, fetch, extract, skip, or refuse action is recorded deterministically
  and the audit cannot be skipped.
- G-6 robots.txt compliance: robots-disallowed paths are skipped before fetch.
- G-7 Respectful pacing: per-domain `min_delay_ms` and `max_concurrency` are enforced as rate limits.

### `PersistenceHostConnector`
Contract: `upsert_lead(records, dedupe_key)`, `upsert_contact(records, dedupe_key)`, `query(filter)`, and
`dedupe(records, dedupe_key)`.

Real implementation: the cross-session DB / CRM store. It must preserve records across runs, dedupe by the configured
key, and report new vs. existing records for the final report.

### `PdfReportHostConnector`
Contract: `render_report(StructuredReport) -> bytes`.

Real implementation: the SOTA PDF renderer. It receives the structured report assembled by the generated program and
returns PDF bytes for the `pdf_report` artifact.

## Config Surface
- `sources`: website or social-profile URLs. Each source can specify allowed follow-on domains; default is same-domain
  follow-on only.
- `purpose`: the lead-research objective used to score relevance and shape the report narrative.
- `extraction_schema`: configured lead/contact fields and expected scalar types; extraction must emit records with these
  keys.
- `guard_config`: per-source `max_depth`, `max_pages`, `max_follow_links`, per-domain `min_delay_ms`, `max_concurrency`,
  and allowlist policy. Runtime config may only operate within the foundry's hard ceilings.

## Regeneration
Run:

```bash
npx tsx .dd-report-exp/lead-research/resynthesize-lead-research.ts
```

This regenerates the standalone scaffold at `.dd-report-exp/lead-research/generated/` with the connector contracts, mocks,
wiring, report-data assembly, and capability gaps.

## Deferred To v2
- Authed / social-login navigation.
- The CRM itself; v1 delivers the persistence foundation and connector contract, not CRM UI/workflows.
- PII / data-handling hardening for stored contacts beyond the v1 audit trail.

## Curator Gate
- Create the standalone repo from the generated scaffold.
- Replace the three mocks with real `WebNavigationHostConnector`, `PersistenceHostConnector`, and `PdfReportHostConnector`
  implementations.
- Re-run the hermetic smoke against mocks, then add live backend tests in the standalone repo before production use.
