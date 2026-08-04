# Document Finalization Implementation Plan

> **For agentic workers:** Each task is dispatched as a falsifier-first Codex worker (`hermes-codex-run`) on simone-lab,
> exactly as the legal-opinion + audit-remediation lines ran: RED falsifier → GREEN minimal synthesizer edit → verify →
> PR → auto-merge on green → next task. Steps use checkbox (`- [ ]`) syntax. Design spec:
> `docs/superpowers/specs/2026-08-04-document-finalization-design.md`.

**Goal:** Have the pgas-new foundry synthesize `document-finalization` — a conversational hub-and-spoke PGAS program
(existing-repo attach to simoneos) where an uploaded document lives as world-state artifacts and the LLM finalizes it
through governed open-ended chat.

**Architecture:** Approach C — minimally extend the foundry to synthesize a **cyclic conversational hub** that *composes*
proven sub-machinery (confirmation loop, delegation, export ladder, toolkit-awareness) plus three genuinely-new
synthesis capabilities (ad-hoc hub tools, `skill_triage`, durable/resumable session). The document is stored as
artifacts; only a summary + section index is projected; sections are pulled via the engine `query` primitive.

**Tech Stack:** TypeScript/Node foundry (`src/foundry-program/`), `@simodelne/pgas-server` (bump to 3.26.0), vitest
falsifiers, `hermes-codex-run` (gpt-5.5) workers, qwen36-27b (no-regression) + codex driver (new-program live-drive).

## Global Constraints

_(Every task's requirements implicitly include this section — values copied verbatim from the spec.)_

- Engine floor: **`@simodelne/pgas-server@3.26.0`** (Task 0 bumps from 3.24.0; do not proceed to Task 1 until green).
- **Falsifier-first**: each foundry task adds a RED test on the pre-task main, then the minimal synthesizer edit to GREEN.
  Do not weaken existing tests; no golden refresh unless the generated output *legitimately* changed (say which + why).
- **Preserve the legal-opinion spotless drive** and all existing suites. Any task that would regress it → STOP + surface.
- Public engine imports only (no `dist-bundle`/private deep paths). `apply_patch`. Scratch under `.dd-report-exp/`.
- **No simoneos mutation from pgas-new** except the final graduation PR (Task 7, `curator_request`). No force-push,
  `--no-verify`, classifier bypass, or secret echo. One Codex worker at a time (host thread ceiling; staggered solo).
- New-program **live-drive uses the codex/gpt-5.5 driver**; the legal-opinion no-regression check stays on qwen.
- Existing-repo attach target: simoneos `.pgas/wiring.yml` (`research`, `document-ingest`, `review-service`,
  `web_search`→`libraries/search`/Tavily). `registration: curator_request`.
- Pattern references (model new falsifiers on these):
  `tests/integration/export-decision-only-autoadvance-falsifier.test.ts` (decision_only + route drive),
  `tests/unit/synthesizer-confirmation-loop.test.ts`, `tests/unit/export-stage-synthesis.test.ts`,
  `tests/unit/generated-handlers-loader.ts` (importing generated `handlers_ts`),
  `.dd-report-exp/toolkit-awareness/FINDINGS.md` (engine query/notebook/skill_triage facts + line refs).

---

### Task 0: Engine pin bump 3.24.0 → 3.26.0 (hard prerequisite gate)

**Files:**
- Modify: `src/pgas-new/version.ts` (`PGAS_SERVER_VERSION`), `package.json` (dep + foundry version note), `package-lock.json`
- Modify: the lockstep version tests (e.g. `tests/unit/version.test.ts` and any test asserting the pin) — search `3.24.0`
- Verify: legal-opinion spotless harness `.dd-report-exp/legal-opinion/scripts/live-drive-legal-opinion.ts`

**Interfaces:**
- Produces: repo builds/tests green on engine 3.26.0; `PGAS_SERVER_VERSION === '3.26.0'`.

- [ ] **Step 1 — RED:** update the version assertions to expect `3.26.0`; run the version test → FAIL (still 3.24.0).
- [ ] **Step 2 — GREEN:** `npm install @simodelne/pgas-server@3.26.0`; set `PGAS_SERVER_VERSION='3.26.0'`; update the
      lockstep tests. Re-run → PASS.
- [ ] **Step 3 — Verify suite:** `npm run typecheck`; `env -u NPM_TOKEN npm run test:unit`; `env -u NPM_TOKEN npm run test:static`.
      Any golden that changed *only* because an engine-emitted string changed → refresh + note. `foundry-end-to-end` may
      `Aborted` locally (host artifact) — if ONLY that, proceed.
- [ ] **Step 4 — No-regression live-drive:** run the legal-opinion no-steer drive on qwen; assert it still hits the
      spotless bar (complete/Completed, 93/93 sections, 0 gate failures / 0 400, defect-qualified). If it regresses →
      STOP + surface (engine 3.26 behavioral change to diagnose before any new work).
- [ ] **Step 5 — Codex-driver native-tool pre-check (gates Option b):** on engine 3.26.0, probe whether the codex driver
      (`PGAS_ENABLE_CODEX_DRIVER=1`) supports **native tool calls** for a unified-author agent — inspect the engine's
      codex-driver path (`create-server.mjs` codex-driver seam) and run a minimal 1-round drive of an existing tiny
      program under the codex driver, asserting it emits a valid native tool_call. Record: supported? round latency?
      If NOT supported → **surface immediately** (Option b is blocked; do not start Task 1's dependents on it) and
      present the fallbacks (different native-tool driver, or Option a programmatic synthesis).
- [ ] **Step 6 — Commit / PR:** `release`-style PR "chore: bump engine pin to 3.26.0"; auto-merge on green.

**Deliverable:** pgas-new on engine 3.26.0, legal-opinion still spotless, and a recorded verdict on codex-driver
native-tool support (the Option-b gate).

---

### Task 1: Cyclic hub mode synthesis

**Files:**
- Modify: `src/foundry-program/synthesizer.ts` + `src/foundry-program/synthesizer/topology.ts` +
  `.../mode-wiring.ts` (transition planning: allow a self-loop mode + branch-and-return, not only linear `proceed_to`)
- Modify: `src/foundry-program/stage-classifier.ts` (recognize a `hub`/`conversational` stage archetype from intake)
- Test: `tests/integration/hub-mode-autoadvance-falsifier.test.ts` (new; model on
  `export-decision-only-autoadvance-falsifier.test.ts`)

**Interfaces:**
- Consumes: an intake stage declared as `archetype: conversational_hub` (or `kind: hub`) with a default self-transition
  and named branch transitions (`amend` → sub-loop, `finalize` → export).
- Produces: a synthesized spec where the hub mode has a **self-transition** (stays in-mode across turns), a guarded
  branch to a sub-loop that **returns** to the hub, and a guarded branch to a terminal-advancing export; the hub's
  vocabulary carries its tool actions (Task 2 fills them).

- [ ] **Step 1 — RED:** hermetic route falsifier (createPgasServer + scripted author, no live provider). Synthesize
      `intake → hub(self-loop) → [amend_approval → return hub] → finalize_export → complete`. Assert: after a hub round
      that emits a non-terminal tool action, `modeAfterRound === 'hub'` (stays); after an `amend` action, mode goes to
      `amend_approval` then **returns to `hub`**; after `finalize`, mode advances through `finalize_export` to `complete`.
      RED today (foundry can't express a self-loop/return; it linearizes).
- [ ] **Step 2 — GREEN:** minimal synthesizer edit to plan hub self-transition + branch-return + guarded finalize edge.
      Re-run falsifier → GREEN.
- [ ] **Step 3 — Verify:** typecheck; `test:unit`; `test:static`; existing topology/confirmation/decision-only suites green.
- [ ] **Step 4 — Commit/PR:** "feat(foundry): synthesize cyclic conversational hub mode"; auto-merge on green.

**Deliverable:** the foundry can synthesize a hub that self-loops, branches to a sub-loop and returns, and exits to a
terminal-advancing export.

---

### Task 2: Ad-hoc hub tools — registered `web_search` + hub-triggered delegation-as-tool

**Files:**
- Modify: `src/foundry-program/synthesizer.ts` + `.../codegen/*` (fill the currently-empty generated `registerXxxTools()`;
  emit a registered tool with a provider-calling handler; advertise engine `query`/`notebook` in the hub vocabulary)
- Modify: delegation synthesis (`.../mode-wiring.ts` / delegation code) to allow **hub-triggered** delegation actions
  (a delegation invoked from inside the hub mode, result consumed back in the hub) — not only as a pipeline stage
- Test: `tests/integration/hub-tools-falsifier.test.ts` (new) + a generated-`handlers_ts` import check
  (model on `tests/unit/generated-handlers-loader.ts`)

**Interfaces:**
- Consumes: hub intake declaring `tools: [web_search(registered, provider), research(delegation), review(delegation)]`
  and `engine_tools: [query, notebook]`.
- Produces: generated `registration.ts` registers a `web_search` tool (handler calls the configured search provider);
  the hub's tool schema advertises `web_search`, the delegation actions, `query`, and `notebook`; a hub-triggered
  delegation dispatches a child and lands its result back in hub-visible state.

- [ ] **Step 1 — RED:** (a) unit: synthesized `registration.ts` registers `web_search` with a handler wired to a
      provider seam (assert the generated source contains the registration + is NOT the empty stub). (b) route: a
      scripted hub round emits a `web_search` tool call → the registered handler is invoked (stub provider returns a
      sentinel) → sentinel appears in hub-visible state; and a scripted `research` delegation from the hub dispatches a
      child and its result lands back in hub state. RED today (registerXxxTools is empty; delegation is stage-only).
- [ ] **Step 2 — GREEN:** implement generated tool registration + hub-triggered delegation wiring. GREEN.
- [ ] **Step 3 — Verify:** typecheck; `test:unit` (incl. the generated-`handlers_ts` import parity); `test:static`;
      delegation/generated-delegation-smoke suites green.
- [ ] **Step 4 — Commit/PR:** "feat(foundry): ad-hoc hub tools — registered web_search + hub-triggered delegation";
      auto-merge on green.

**Deliverable:** the hub advertises + dispatches `web_search` (registered→provider), `research`/`review` (delegation),
and the engine `query`/`notebook` tools, all ad-hoc within the conversation.

---

### Task 3: `skill_triage` synthesis + skill catalog

**Files:**
- Modify: `src/foundry-program/synthesizer.ts` (+ `.../mode-wiring.ts`, `.../registration-artifacts.ts`): emit
  `features: [skill_triage]`, a declared **skill catalog** (name + static body), and `activate_skill`/`decline_skills`
  wired into the hub vocabulary + the decision zone
- Test: `tests/integration/skill-triage-falsifier.test.ts` (new)

**Interfaces:**
- Consumes: hub intake declaring `skills: [{name, body}...]` (v1 starter catalog: clause-amendment,
  enforceability-review, risk-disclosure-checklist, compare-to-precedent).
- Produces: synthesized spec with `skill_triage` in `features`, the catalog rendered, and `activate_skill` /
  `decline_skills` available in the hub; activation injects the skill body; decline settles cleanly.

- [ ] **Step 1 — RED:** falsifier asserts (a) the generated spec has `skill_triage` in `features` and the declared
      catalog names/bodies; (b) a scripted hub round `activate_skill('clause-amendment')` results in that body being
      injected (engine `skill_triage_settled`), and `decline_skills` settles the decision zone with no body. RED today
      (foundry never emits `skill_triage`).
- [ ] **Step 2 — GREEN:** minimal synthesis of the feature + catalog + activate/decline wiring. GREEN.
- [ ] **Step 3 — Verify:** typecheck; `test:unit`; `test:static`; confirmation/decision-only suites green.
- [ ] **Step 4 — Commit/PR:** "feat(foundry): synthesize skill_triage + skill catalog"; auto-merge on green.

**Deliverable:** synthesized programs can declare a skill catalog and the LLM can activate/decline playbooks in-hub.

---

### Task 4: Selective section-artifact projection (configure `inline_world_query` + hub projection)

**Files:**
- Modify: `src/foundry-program/synthesizer.ts` + `.../projection.ts` + `.../registration-artifacts.ts`
  (declare `inline_world_query` feature + `allowedWorldQueryPrefixes` = section paths; set the hub projection to
  include summary + section index, **exclude** section text)
- Test: `tests/integration/hub-selective-projection-falsifier.test.ts` (new)

**Interfaces:**
- Consumes: hub intake declaring the document artifact shape (`work.document.sections.*.{id,heading,status,text}`,
  `work.document.summary`) and which paths are query-only.
- Produces: hub projection contains `work.document.summary` + `work.document.sections.*.{id,heading,status}` and
  **NOT** `...text`; `allowedWorldQueryPrefixes` includes `work.document.sections`; the engine `query` tool can read a
  section's text.

- [ ] **Step 1 — RED:** falsifier asserts the synthesized hub projection **omits** `sections.*.text` but includes the
      summary + index, `inline_world_query` is in features with `allowedWorldQueryPrefixes` covering the section paths,
      and a route `query` for a section id returns its text. RED today (no inline_world_query config for this shape;
      projection would include or omit inconsistently).
- [ ] **Step 2 — GREEN:** implement projection config + query policy for the document artifact shape. GREEN.
- [ ] **Step 3 — Verify:** typecheck; `test:unit`; `test:static`; scale-safe-projection suite green (bounded).
- [ ] **Step 4 — Commit/PR:** "feat(foundry): selective section-artifact projection + query policy"; auto-merge on green.

**Deliverable:** the document lives as artifacts; only summary + index are projected; section text is query-only.

---

### Task 5: `durable_channel` + checkpoint/resume

**Files:**
- Modify: `src/foundry-program/synthesizer.ts` (declare `durable_channel` for the conversation channel; wire
  checkpoint/resume as needed) — FIRST verify (read-only) how much is engine-automatic for a `BoundedSession` vs. must
  be synthesized; scope the edit accordingly
- Test: `tests/integration/hub-durable-resume-falsifier.test.ts` (new)

**Interfaces:**
- Produces: a synthesized hub session whose conversation channel is durable and can be checkpointed + resumed with
  artifacts + amendment state intact.

- [ ] **Step 1 — Diagnose (read-only):** confirm from the installed engine whether `session_resume`/checkpoint already
      cover the hub's needs or `durable_channel` must be declared; record the finding. Adjust the falsifier to the real gap.
- [ ] **Step 2 — RED:** falsifier drives a hub session, checkpoints, resumes, and asserts artifacts + amendment state +
      notebook survive the resume. RED where the gap is.
- [ ] **Step 3 — GREEN:** minimal synthesis (declare `durable_channel` / resume wiring). GREEN.
- [ ] **Step 4 — Verify:** typecheck; `test:unit`; `test:static`.
- [ ] **Step 5 — Commit/PR:** "feat(foundry): durable resumable hub session"; auto-merge on green.

**Deliverable:** a document-finalization session can be left and resumed with full state.

---

### Task 6: Build `document-finalization` by running the FOUNDRY itself under the codex driver (Option b — product path)

**Approach:** synthesis is done by **running pgas-new as the interactive foundry it is designed to be** — the 12-mode
foundry PGAS program (`intake_intelligence → repo_targeting → architecture_design → scaffold_plan → domain_synthesis →
branch_write → static_verify → smoke_verify → live_verify → rebase_verify → pr_graduation`, + `curator_request`) — with
its **own agent driven by the codex/gpt-5.5 driver**. We feed it the document-finalization requirements as the intake and
let the codex-driven foundry agent design + synthesize + verify + graduate the program, exercising the Tasks 1–5
capabilities during `domain_synthesis`/`branch_write`.

**Files:**
- Create: `.dd-report-exp/document-finalization/` — an intake brief (the design-spec requirements as the foundry's
  `intake_intelligence` input), the foundry-session runner (codex driver, existing-repo attach to simoneos), a starter
  uploaded-document fixture (contract) + seeded sections, and `DRIVE-REPORT.md`
- Uses: simoneos `.pgas/wiring.yml` as the `repo_targeting` target profile

**Interfaces:**
- Consumes: Tasks 1–5 capabilities (present in the foundry's synthesizer) + the codex-driver native-tool support proven
  in Task 0's pre-check.
- Produces: a foundry-agent-synthesized `document-finalization` program (existing-repo attach) that reaches
  `pr_graduation`, plus a live-verify of the generated program.

- [ ] **Step 1 — intake:** author the foundry intake brief capturing the spec: hub topology; tools
      (web_search/research/review/query/notebook/skill_triage); skill catalog; document artifact shape; per-amendment
      approval; finalize export; durable/resume; simoneos attach + manifest bindings.
- [ ] **Step 2 — run the foundry under the codex driver:** launch pgas-new's streaming session with
      `PGAS_ENABLE_CODEX_DRIVER=1` (gpt-5.5); the codex-driven foundry agent walks `intake_intelligence` →
      `repo_targeting` (simoneos, `.pgas/wiring.yml`) → `architecture_design` → `scaffold_plan` → `domain_synthesis`
      (emit the hub program using the Tasks 1–5 capabilities) → `branch_write` → `static_verify` → `smoke_verify`.
      Capture the session transcript.
- [ ] **Step 3 — live_verify (generated program, codex driver):** the foundry's `live_verify` (or a follow-on drive)
      runs the generated program under the codex driver: upload → ingest (sections + summary as artifacts) → hub: query a
      section, `web_search`, `research` delegation, `analyze`, `activate_skill` → `propose_amendment` → approve →
      finalize → amended DOCX. **Assert (independently measured):** sections live as artifacts NOT in the projected
      prompt; summary + index always projected; each tool callable ad-hoc; a skill activated + injected; per-amendment
      approval applied to the artifact; finalized DOCX contains the approved edit; checkpoint/resume works.
- [ ] **Step 4 — iterate gaps:** any foundry gap the design/synthesis/verify session exposes → new falsifier-first task
      (loop), same discipline. (Expect the foundry-agent path to surface intake/design-phase gaps the programmatic path
      would not — that is part of dogfooding the product surface.)
- [ ] **Step 5 — rebase_verify → pr_graduation:** the foundry agent completes the ladder to `pr_graduation`. Write
      `.dd-report-exp/document-finalization/DRIVE-REPORT.md` with the measured evidence + the session transcript ref.

**Deliverable:** `document-finalization` designed + synthesized + verified + graduated by the **codex-driven foundry agent
itself**, with an end-to-end live-verify proving the open-ended finalization flow with the document as artifacts.

**RISK (load-bearing — pre-checked in Task 0):** the codex driver must support **native tool calls** for the foundry's own
agent; a prior note (engine ≤3.24) recorded the codex-cli driver as unsuitable for the unified author driver (no native
tool calls) and slow (~40–58s/round). Task 0 adds a pre-check on engine **3.26.0**. If the codex driver still lacks
native-tool support, Option (b) is blocked → surface it; fallbacks are (i) drive the foundry session with a different
strong native-tool driver, or (ii) fall back to programmatic synthesis (Option a) for this build while filing the
codex-driver gap. Do not force Option (b) if the driver can't run the foundry agent.

---

### Task 7: Graduate PR into simoneos + handoff

**Files:**
- Graduation PR into simoneos via `curator_request` (the generated program + tests + wiring), following simoneos's
  consumer gates (QC integrity, architecture-boundary allowlist, e2e-runner conventions — per the contract-revision
  graduation pattern).

- [ ] **Step 1:** generate the graduation artifacts; open the simoneos PR (curator_request).
- [ ] **Step 2:** clear simoneos consumer gates (QC rotate/drift-check, architecture-boundary ALLOWED_EXTRA_FILES,
      omit ad-hoc live-provider test per convention).
- [ ] **Step 3 — Handoff:** notify the simoneos agent (tmux) to vet-via-Fable / wire backend+frontend (chat UI + upload +
      per-amendment approval UX + amended-DOCX download) / add e2e UAT — same handoff pattern as the legal-opinion program.

**Deliverable:** `document-finalization` graduated into simoneos, handed to the simoneos agent for integration + UAT.

---

## Self-Review

**Spec coverage:** §2 prereq → Task 0. §3 topology → Task 1. §4 tools (query/notebook reuse; web_search/delegation new) →
Task 2 + Task 4 (query config). §5 skill catalog → Task 3. §6 artifact/projection → Task 4. §7 amendment (reuse
confirmation loop — no new task needed; exercised in Task 6) + finalize (reuse export ladder — exercised in Task 6) +
resumability → Task 5. §8 manifest → Task 6. §9 foundry work → Tasks 1–5. §10 driver/testing → Task 6. §11 build sequence
→ Tasks 0–7. §12 deferred → explicitly out of scope. §13 risks → the round-budget risk is checked in Task 1 (self-loop vs
termination) and Task 5 (durable/resume); web_search signature in Task 2/6. **No gaps.**
_Note:_ per-amendment approval + finalize reuse proven machinery, so they get no standalone foundry task — they are
asserted in the Task 6 live-drive. If the hub↔confirmation-loop return-wiring needs new synthesis, it surfaces as a
Task-1/Task-6 gap and loops falsifier-first.

**Placeholder scan:** no TBD/TODO; each task carries a concrete falsifier contract, files, verification, and commit. The
exact synthesizer edits are intentionally discovered at GREEN (falsifier-first) — the RED assertion is the precise
contract, matching how every prior foundry capability was built.

**Type/name consistency:** artifact paths (`work.document.sections.*.{id,heading,status,text}`, `work.document.summary`)
are used identically in Tasks 4 and 6; tool names (`web_search`, `research`, `review`/`analyze_sections`, `query`,
`notebook`, `activate_skill`/`decline_skills`, `propose_amendment`) are consistent across Tasks 2, 3, 6.
