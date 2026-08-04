# Document Finalization — Design Spec

**Date:** 2026-08-04
**Status:** Approved design, pre-implementation
**Owner:** pgas-new foundry (build); simoneos (host/integration)
**Approach:** C — minimally extend the foundry to synthesize a cyclic conversational hub that *composes* proven sub-machinery.

## 1. Purpose

`document-finalization` is a **conversational, open-ended PGAS program** synthesized by the pgas-new foundry as an
**existing-repo attachment to simoneos**. A user uploads a document (contract, prospectus, minutes, etc.). The program
ingests it into governed world-state artifacts, then hosts an **open-ended chat** in which the user asks questions and
requests changes, and the LLM queries sections, analyzes them, researches, searches the web, injects finalization
playbooks, and proposes per-section amendments for approval — until the user finalizes and the amended DOCX is
re-exported.

It is deliberately **not** a linear pipeline. Its purpose is to *finalize a document in an open fashion*, so its shape is
a **hub-and-spoke** conversation, not a fixed process. Its defining property — and the reason it is worth building — is
that **the document lives in world-state artifacts, not in the LLM context**: only a bounded summary + section index is
ever projected, and the LLM pulls specific section text on demand via the engine's native query primitive. It is the
canonical showcase of PGAS's selective-projection, artifact, query, notebook, and skill-injection rails.

## 2. Prerequisite (Step 0): engine pin 3.24.0 → 3.26.0

pgas-new is pinned to `@simodelne/pgas-server@3.24.0`; simoneos runs `^3.26.0` and its `web_search` tool + toolkit
surfaces assume it. Step 0 bumps pgas-new's `PGAS_SERVER_VERSION` (`src/pgas-new/version.ts`) + `package.json` + the
lockstep version tests, then **re-verifies the legal-opinion spotless drive on 3.26.0** (no regression) and the full
suite before any new work. This is a hard gate: no document-finalization synthesis until 3.26.0 is green.

## 3. Topology (cyclic hub-and-spoke — the new foundry shape)

```
start ─▶ ingest ─▶ HUB ⟲───────────────────────────────┐
                     │   ├─(amend intent)──▶ amend_approval ─(return)─▶ HUB
                     │   └─(finalize)──────▶ finalize_export ─────────▶ complete
```

- **`start`** — capture the upload request; deterministic advance to `ingest`.
- **`ingest`** — delegation to simoneos `document-ingest`. The uploaded document becomes `{ sections[], summary }`
  stored as world-state artifacts. Deterministic advance to `HUB`.
- **`HUB`** — the persistent conversational mode. The LLM lives here with the full tool array (§4). **Self-loops** by
  default (each user turn stays in `HUB`). It leaves only when the LLM (a) proposes an amendment → branch to
  `amend_approval`, or (b) the user finalizes → `finalize_export`.
- **`amend_approval`** — per-amendment confirmation sub-loop (§6). **Returns to `HUB`** after each decision.
- **`finalize_export`** — `decision_only` pure-compute mode (no LLM round — the export-robustness pattern proven in the
  legal-opinion export); re-renders the amended DOCX; deterministic advance to `complete`.
- **`complete`** — terminal.

This is the genuinely-new synthesis shape: a **cyclic hub with self-loop + branch-and-return**, versus the foundry's
current linear `proceed_to` chains.

## 4. Tool / primitive inventory (all available ad-hoc in the HUB)

| Capability | Mechanism | Backing | New foundry synthesis? |
|---|---|---|---|
| **query state** | engine `inline_world_query` primitive → model-facing `query` tool ("Read a single declared world-state value NOW") | `allowedWorldQueryPrefixes` scoped to section-artifact paths | **No** — reuse toolkit-awareness (#257) |
| **notebook** | engine `enableNotebook` primitive (`record_note`/`read_note`/`pin_note`/…) | durable analysis notes | **No** — reuse toolkit-awareness (#257) |
| **skill injection** | engine `skill_triage` feature → `activate_skill` / `decline_skills`, rendered skill catalog | catalog of finalization playbooks (§5) | **Yes** — synthesize `skill_triage` |
| **web_search** | registered ToolRegistry tool | simoneos `libraries/search` → **Tavily** (`SEARCH_PROVIDER=tavily`) | **Yes** — fill `registerXxxTools()` |
| **legal_research** | delegation-as-tool (hub-triggered) | simoneos `research` agent | **Yes** — hub-triggered delegation |
| **analyze_sections** | delegation-as-tool (hub-triggered) | simoneos `review-service` agent | **Yes** — hub-triggered delegation |
| **propose_amendment** | governed write action | → `amend_approval` loop | reuse confirmation loop |
| **session controls / resume** | `runtime_control` + `durable_channel` + checkpoint/resume | resumable session (§7) | partial — see §7 |

`query` and `notebook` are **configured, not invented** (they are engine primitives the toolkit-awareness work already
synthesizes). The genuinely-new tool synthesis is the ad-hoc **registered `web_search`** and **hub-triggered
delegation-as-tool** (research/review invoked mid-conversation, not as pipeline stages).

## 5. Skill catalog (governed instruction injection)

Using `skill_triage`, the program declares a **catalog of finalization playbooks** the LLM activates on demand, keeping
the base hub prompt lean (injection-not-context, applied to instructions). v1 starter catalog (authored in the domain
intake; each skill = name + static instruction body):

- **clause-amendment** — how to propose a clean, minimal redline for a clause.
- **enforceability-review** — what to check for enforceability / capacity / governing law.
- **risk-disclosure-checklist** — prospectus/contract disclosure and risk-flagging checklist.
- **compare-to-precedent** — how to compare a section against a supplied precedent / standard form.

The catalog is program-authored and extensible. On each relevant user ask the model `activate_skill`s the matching
playbook or `decline_skills` ("no skill needed"), settled via the `skill_triage_settled` decision zone.

## 6. Artifact + selective-projection model (the PGAS core value)

- **Ingest output** → `{ sections[] (id, heading, text, status), summary }` stored as world-state **artifacts**
  (`artifactPolicy` / `SessionArtifactRecord`).
- **Always projected** in the HUB: `summary` + a **bounded section index** (ids / headings / status). Constant-size.
- **Never projected**: section full `text`. The LLM uses the engine `query` tool to pull specific sections on demand,
  governed by `allowedWorldQueryPrefixes` scoped to the section paths (e.g. `work.document.sections.*.text`).
- *The document lives in the artifact, not the context.* This is the program's reason to exist.

## 7. Amendment / approval + finalize + resumability

**Amendment (per-amendment approval).** In the HUB, on a change request, the LLM calls
`propose_amendment(section_id, new_text, rationale)` → branch to `amend_approval`. That mode presents the **one** proposed
edit (diff vs current section text) via `awaits_user_decision`. **Approve** → commit `new_text` to the section artifact +
log + status update. **Reject** → discard. Either way **return to HUB**. Reuses the proven confirmation-loop machinery,
bounded projection (only the active proposed amendment).

**Finalize.** User says "finalize" in the HUB → `finalize_export` (`decision_only`, no LLM round). Re-renders the
**amended DOCX** — original sections with approved edits applied, in document order — via the export ladder
(`renderDocxExportStageBody` + `artifactPolicy` harvest at terminal). → `complete`. The amended DOCX is the first-class
output artifact.

**Resumability.** A finalization session is long-lived and open-ended, so it is **durable + resumable**: `durable_channel`
for the conversation channel + engine checkpoint/resume, so the user can leave and later resume with the artifacts +
notebook + amendment state intact. `session_resume` (in `runtime_control`) already exists; the design adds
`durable_channel` and verifies at build time how much resumability the foundry must synthesize vs. the engine provides
automatically for a `BoundedSession`.

## 8. Manifest wiring (existing-repo attach to simoneos)

simoneos `.pgas/wiring.yml` already exposes the delegable agents. Bindings for document-finalization:

- `delegation_document_ingest` ← `document-ingest` (ingest phase)
- `delegation_research_agent` ← `research` (hub-triggered legal_research)
- `delegation_review` ← `review-service` (hub-triggered analyze_sections)
- `web_search` tool ← simoneos `libraries/search` (Tavily), registered in the generated `registration.ts` mirroring the
  pattern already used by simoneos's integrated `legal-opinion-drafter` / `bahrain-law-research` programs (exact
  registration signature to be matched at build time).
- `registration: curator_request` (simoneos convention).

## 9. Foundry work (Approach C — new capabilities, falsifier-first)

Genuinely-new synthesis (each closed falsifier-first, like the legal-opinion line):

1. **Cyclic hub mode** — self-loop + branch-to-sub-loop-and-return (vs linear `proceed_to`). *Falsifier:* a synthesized
   hub stays in-mode across turns, dispatches a tool, and returns; amend branches out and back; finalize exits.
2. **Ad-hoc LLM-callable tools in a mode** — registered `web_search` → provider handler; **hub-triggered
   delegation-as-tool** (research/review invoked from the hub, not as pipeline stages); engine `query`/`notebook`
   advertised in the hub vocabulary + tool schema. *Falsifier:* hub tool schema includes them; a scripted hub round
   calls `web_search` and `query`; a hub round dispatches a research delegation and consumes its result.
3. **`skill_triage` synthesis** — `features: [skill_triage]` + skill catalog + `activate_skill`/`decline_skills` wired
   into the hub + the decision zone. *Falsifier:* synthesized spec advertises the catalog; a scripted round activates a
   skill and its body is injected; `decline_skills` settles cleanly.
4. **Selective section-artifact projection** — configure `inline_world_query` with `allowedWorldQueryPrefixes` = section
   paths; hub projection includes summary + section index, **excludes** section text. *Falsifier:* hub projection omits
   section text; the `query` tool returns it.
5. **`durable_channel` + checkpoint/resume** — verify/synthesize durable conversation channel + resume. *Falsifier:* a
   session checkpoints and resumes with artifacts + amendment state intact.

**Reused as-is (no new synthesis):** `inline_world_query` + `enableNotebook` (toolkit-awareness #257), confirmation loop
(per-amendment approval), delegation (research/ingest/review, proven in legal-opinion), export ladder (finalize,
decision_only), `artifactPolicy`, `awaits_user_decision`, `attachment`/`documents` (upload).

## 10. Driver & testing

- **Driver:** the live-drive uses the **codex / gpt-5.5 driver** (not qwen). An open-ended hub with many ad-hoc tools
  demands strong tool-selection; qwen's protocol variance (the known `GKStructural` model-floor) would hurt disproportionately
  here. Caveat: the codex driver is slower (~40–58s/round), so verification drives are shorter / scripted. The
  legal-opinion no-regression check stays on qwen.
- **Falsifier-first** per foundry capability in §9.
- **Live-drive** (existing-repo attach render): upload → ingest (sections + summary as artifacts) → hub conversation
  (query a section, `web_search`, `research` delegation, `analyze`, `activate_skill`) → `propose_amendment` → approve →
  finalize → amended DOCX. **Assert:** sections live as artifacts (NOT in the projected context); summary + index always
  projected; each tool callable ad-hoc; a skill activates and injects; per-amendment approval applied to the artifact;
  finalized DOCX contains the approved edit; session checkpoints/resumes.
- **No-regression:** legal-opinion spotless still holds on engine 3.26.0.

## 11. Build sequence

0. Engine bump 3.24.0 → 3.26.0; verify legal-opinion spotless + full suite.
1. Foundry: cyclic hub mode (falsifier-first).
2. Foundry: ad-hoc tools in hub — registered `web_search` + hub-triggered delegation-as-tool.
3. Foundry: `skill_triage` synthesis + skill catalog.
4. Foundry: selective section-artifact projection (configure `inline_world_query` + hub projection).
5. Foundry: `durable_channel` + checkpoint/resume (verify vs synthesize).
6. Synthesize `document-finalization` (existing-repo attach to simoneos); codex-driver live-drive; iterate gaps.
7. Graduate PR into simoneos (`curator_request`); hand to the simoneos agent for backend/frontend/UAT.

## 12. Deferred to v2 (assessed, YAGNI for v1)

- **`deferred_delegation`** — async research/analyze that runs while the conversation continues (non-blocking chat).
- **`mcp_connector`** — expose external MCP tool ecosystems in the hub (only if simoneos wires MCP servers).
- **`ephemeral_state`** — transient scratch for search/query results that should not persist in the durable notebook.

**Excluded (with reason):** `enum_router` / `command_grammar` (hub uses NL + LLM tool-choice, not command routing);
`agent_network` (simple parent→child delegation suffices); `scheduled_program` (interactive, not cron).

## 13. Open risks

- **Tool-selection variance in an unknown-ask hub** — mitigated by the codex driver + toolkit-awareness guidance +
  skill-triage; may still expose a model-floor consideration to surface honestly.
- **`web_search` registration signature** must match simoneos's existing integrated programs — verify at build time
  against `programs/simoneos/{legal-opinion-drafter,bahrain-law-research}`.
- **Resumability scope** — confirm how much checkpoint/resume the foundry must synthesize vs. is engine-automatic for a
  `BoundedSession`; adjust §9.5 accordingly.
- **Cyclic hub + BoundedSession round budget** — an open-ended conversation must not exhaust the round budget; verify the
  hub's self-loop is compatible with the session's `termination` policy (may need an unbounded/interactive session mode).
