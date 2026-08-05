# lead-research-agent — Design Spec

**Date:** 2026-08-05
**Status:** Approved design, pre-implementation
**Owner:** pgas-new foundry (builds the program + connectors + mocks + spec guards); the graduated program's **curator**
implements the real backends (browser driver, DB, PDF renderer) + frontend + the future CRM.
**Target:** a **brand-new standalone repo** synthesized by the pgas-new foundry (engine `@simodelne/pgas-server@3.26.0`).

## 1. Purpose

`lead-research-agent` is a **reusable, config-driven** PGAS agent. Given a configured list of websites/social profiles, a
research purpose, and an extraction schema, it navigates each source (following relevant links *within* the source,
strictly bounded by guards), extracts purpose-relevant leads/contacts/info, **persists them across sessions** (the
foundation of a future CRM), and produces a **SOTA-formatted PDF report**.

It is **domain-agnostic**: the sources, purpose, and extraction schema are **configuration parameters, not hardwired** —
so the same program serves recruiting, sales prospecting, competitive research, diligence, etc. by config alone.

Its safety-critical property (the pgas-web lineage, and the lesson from the pgas-rag web-scraping agent going rogue):
**every ethical/operational guard is enforced deterministically by the synthesized spec and the connector contract — not
by the LLM.** Replace the model with an adversary and it still cannot leave the allowlisted domains, exceed the follow-on
caps, ignore robots.txt, submit payments, log in, or skip the audit log.

## 2. Foundry boundary (load-bearing framing)

The foundry deals with the **PGAS program**, not the frontend/backend. For every host-side concern it builds the **typed
host-connector contract + a mock + the wiring**, and the deterministic **spec-level guards**. It does **not** implement
real browsers, databases, or PDF renderers. Those — plus any frontend/backend and the future CRM — are the **curator's**
responsibility once the program graduates into its own repo. The program is fully verifiable pre-graduation against the
mocks (guards included).

## 3. Configuration parameters (the reusability core)

All domain-specific inputs are config, never code:

- **`sources`** — list of website/social-profile URLs; each with its **allowed follow-on domain(s)** (default: same
  registrable domain).
- **`purpose`** — the research goal in natural language; guides extraction relevance scoring.
- **`extraction_schema`** — the domain output schema: what constitutes a lead/contact/relevant item, e.g.
  `{ name, role, company, email, profile_url, notes, relevance_score }`. Fully configurable per domain.
- **`guard_config`** — per-source caps: `max_depth`, `max_pages`, `max_follow_links`; per-domain `min_delay_ms`;
  `max_concurrency`; allowlist policy. Sensible safe defaults; the config only tightens/loosens within hard ceilings the
  spec enforces.

## 4. Topology (config-driven fan-out pipeline)

```
intake(sources, purpose, extraction_schema, guard_config)
  → FAN-OUT per source ──▶ [ guarded agentic navigate + bounded follow-on + extract-relevant-to-purpose ]
  → aggregate (across sources)
  → dedupe (by config key, e.g. email / profile_url)
  → persist (upsert leads/contacts via PersistenceHostConnector; cross-session)
  → render SOTA PDF report (PdfReportHostConnector) + harvest as first-class artifact
  → complete
```

Per source, navigation is **agentic** (the agent follows relevant links *within* the source) but **strictly bounded** by
the follow-on caps — this bounded follow-on is the anti-sprawl guard. The audit log is written throughout (every navigate
+ extract action).

## 5. Deterministic guards (anti-rogue — enforced by spec + connector, never the LLM)

**Spec-level** (synthesized reactions / preconditions; hold regardless of model output):
1. **Domain allowlist** — navigation confined to `sources` domains + explicitly-allowed follow-on domains; off-list
   navigation is refused.
2. **Follow-on bounding** — per-source `max_depth` / `max_pages` / `max_follow_links` hard caps; the agentic follow-on
   cannot wander unboundedly (the pgas-rag rogue-scraper anti-pattern).
3. **No-spend** — payment/purchase/checkout actions are refused.
4. **No-login (public-only, v1)** — no credential submission; a login-attempt cap blocks retries.
5. **Immutable audit log** — every navigate + extract action recorded deterministically; the audit cannot be skipped.

**Connector-contract** (obligated by the `WebNavigationHostConnector` contract; **the mock enforces them** so they are
tested pre-graduation, and the curator's real driver must honor them):
6. **robots.txt compliance** — disallowed paths skipped.
7. **Respectful pacing** — per-domain `min_delay_ms` + `max_concurrency` (rate limit).

Hard ceilings (max caps) are spec constants; `guard_config` may only tighten within them.

## 6. Host connectors (typed contract + mock; curator implements the real backend)

- **`WebNavigationHostConnector`** — `navigate_and_extract(source, purpose, extraction_schema, guard_ctx) → { items[],
  pages_visited, audit[] }`, enforcing the fetch-time guards (6–7). **Mock** returns fixture pages/items and enforces the
  guards (off-allowlist → refuse; over-cap → stop; robots-disallowed → skip; pacing respected), so guard behavior is
  falsifiable pre-graduation. **Curator** wires **pgas-web's extracted guarded Playwright driver** as the real impl.
- **`PersistenceHostConnector`** — `upsert_lead(entity)`, `upsert_contact(entity)`, `query(filter)`, `dedupe(key)`;
  cross-session (accumulates across runs). **Mock** = in-memory/fixture store with dedupe. **Curator** implements the real
  DB (the CRM store).
- **`PdfReportHostConnector`** — `render_report(structured_report) → pdf_bytes` (SOTA formatting). **Mock** = deterministic
  stub returning a valid-shaped artifact. **Curator** implements the real SOTA renderer.

Each connector is a typed contract + mock + `capability_gaps` entry → the synthesized program is `scaffolds_with_gap`
until the curator implements the real backends; it is **fully drivable against the mocks** meanwhile.

## 7. Extraction & persistence

Per source, an LLM-reasoning stage extracts entities matching `extraction_schema`, each scored for relevance to
`purpose`. Across sources: aggregate → **dedupe** by the config key → **upsert** via the persistence connector. Because
persistence is cross-session, repeated runs accumulate; the report flags **new vs. existing** entities. The dedupe key +
schema are config, keeping the program domain-agnostic.

## 8. Report (SOTA PDF)

The pipeline produces **structured, report-ready data**: executive summary, per-source findings, leads & contacts tables
(new vs existing), relevance analysis against `purpose`, and a guard/audit summary (what was skipped/blocked and why —
proving respectful navigation). The `PdfReportHostConnector` renders the SOTA PDF; the rendered bytes are harvested as a
first-class `SessionArtifactRecord` via `artifactPolicy`. The foundry owns the report **data + contract + mock**; the
curator owns the real rendering.

## 9. New foundry capabilities (falsifier-first, like the document-finalization line)

1. **Guarded web-navigation connector** — the `WebNavigationHostConnector` contract + mock + the **agentic bounded
   follow-on** semantics + the browser **guard set** as spec reactions/preconditions. *(New; the foundry has never driven
   or modeled browser navigation.)*
2. **Cross-session persistence connector** — typed upsert/query/dedupe + mock; the program reads/writes a store that
   **survives across sessions** (distinct from within-session notebook/artifacts). *(New.)*
3. **PDF report export** — the `PdfReportHostConnector` contract + mock + structured-report-data assembly + artifact
   harvest. *(New export target vs the DOCX ladder.)*
4. **Config-driven `extraction_schema`** — the extraction stage's output contract is parameterized by a config schema.
   *(Extension of intake parameterization.)*

**Reused as-is:** per-source **fan-out** (legal-opinion DD pattern), **LLM-reasoning extraction**, intake
parameterization, `artifactPolicy`, audit, `capability_gaps` / `scaffolds_with_gap` classification.

## 10. pgas-web reuse (Approach A — extract as connector)

pgas-web is a PGAS browser agent pinned to engine 1.x and unfinished (Phase-3 scaffold), but its **guarded Playwright
driver (~25 verbs)**, its **deterministic guard logic** (allowlist, robots.txt, no-spend, audit, rate/login caps), and its
scenario-runner are strong donor material. We **do not** drag the 1.x scaffold forward. Instead: the foundry builds the
`WebNavigationHostConnector` **contract + mock + the spec-level guards**; at graduation the **curator extracts pgas-web's
driver + guard logic** into the connector's real, engine-agnostic implementation. The guard *contract* names the
obligations (allowlist, follow-on caps, robots.txt, pacing, no-spend, no-login, audit) so the curator's implementation is
held to them.

## 11. Testing / success bar

- **Falsifier-first** per foundry capability (§9): the guard falsifiers are load-bearing — e.g. an off-allowlist source
  is refused; a follow-on that exceeds `max_depth`/`max_pages` is stopped; a robots-disallowed path is skipped; a
  payment/login action is refused; the audit log records every action. Each proven against the **mock** connector.
- **Hermetic drive** (mocks): `intake → per-source navigate_and_extract (mock, guards enforced) → aggregate → dedupe →
  upsert (mock) → render report (mock)`; assert: extracted items match `extraction_schema`; dedupe/upsert correct across a
  simulated prior-session store; the report data contains the sections + the guard/audit summary; guards fire on the
  adversarial fixtures.
- **No reused-agent live drive pre-graduation** — the real browser/DB/PDF are curator-implemented; the live run happens in
  the graduated repo (as with document-finalization's env-bound live UAT).

## 12. Build & graduation

The foundry builds the **standalone new-repo program** + the three connectors (contracts + mocks) + wiring + the
deterministic spec guards, falsifier-first, verified hermetically. It graduates into its **own new repo**, where the
curator implements the real backends (browser driver from pgas-web, DB, SOTA PDF renderer), the frontend/backend, and —
later — the CRM built on the persistence store.

## 13. Deferred to v2 (assessed, YAGNI for v1)

- **Authed / social-login navigation** (v1 = public pages only; the safe, respectful default).
- **The CRM itself** (v1 delivers the persistence *foundation*, not the CRM UI/workflows).
- **PII / data-handling hardening** for stored contacts (a policy layer beyond the audit log).

## 14. Open risks

- **New-repo standalone synthesis path** — prior foundry programs were mostly existing-repo attach (document-finalization)
  or programmatic; a standalone new-repo synthesis of this shape (three connectors + browser guards + fan-out with bounded
  follow-on) will likely surface foundry gaps — closed falsifier-first, as with the document-finalization line.
- **Agentic bounded follow-on as a spec construct** — modeling a per-source bounded agentic navigation sub-loop (vs a
  single connector call) inside a fan-out stage is novel; the caps must be spec-enforced, not connector-advisory.
- **Guard completeness** — the guard set must be exhaustive enough that an adversarial model cannot find an unguarded
  action; the falsifier suite is the evidence, and any gap found is a new guard.
- **pgas-web engine gap at graduation** — the curator must reconcile pgas-web's 1.x driver with the graduated program's
  3.26 runtime when wiring the real connector.
