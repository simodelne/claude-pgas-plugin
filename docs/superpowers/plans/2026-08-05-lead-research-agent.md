# lead-research-agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the pgas-new foundry to synthesize a config-driven, guarded web/social lead-research PGAS program —
`lead-research-agent` — that fans out over configured sources, navigates each under deterministic anti-rogue guards with
bounded follow-on, extracts purpose-relevant leads against a config-driven schema, dedupes + persists them cross-session,
and produces a SOTA PDF report; all host I/O behind typed connectors + mocks so it is fully drivable pre-graduation.

**Architecture:** Every task is a **falsifier-first capability vertical** in the foundry (not in a generated repo):
add/adjust a synthesizer emitter → prove it with a hermetic route-level falsifier (a kill test that MUST go red if the
wire is broken) → register the capability in the registry → prove the whole program hermetically at the end. The generated
program does all host I/O (browser, DB, PDF) through three typed host connectors, each shipped with a **mock** the foundry
emits; the falsifiers drive against those mocks. The three connectors' real backends are the **curator's** job
post-graduation — the foundry ships contract + mock + wiring + `capability_gaps` only.

**Tech Stack:** TypeScript/Node; `@simodelne/pgas-server@3.26.0` (engine, read-only, public exports only); Vitest
(`tests/integration/*-falsifier.test.ts` hermetic route harness + `generated-live-drive.ts` for optional live proof);
qwen36-27b on vLLM (`http://localhost:8000/v1`) for any live drive. Foundry version bumps 3.25.0 → 3.26.0.

## Global Constraints

- **Engine boundary:** import only public `@simodelne/pgas-server` exports; `@simodelne/pgas-server/testing.js` is
  test-only; generated runtime code imports only approved runtime subpaths. If a server surface is missing, file a
  curator/upstream request — do not patch around internals.
- **Foundry-builds-program-only:** the foundry emits the PGAS program + typed connector contracts + mocks + wiring +
  deterministic spec/connector guards. It does **not** implement real browsers, databases, PDF renderers, frontend, or the
  CRM. Those are the curator's, post-graduation.
- **Guards are deterministic, never LLM:** every guard is enforced by (a) the generated tool vocabulary (dangerous actions
  are simply not exposed), (b) the connector + its mock (parameter-bound checks), or (c) a stage handler that always
  persists the audit. An adversarial model must be unable to bypass any guard. The falsifier suite is the evidence; any
  gap found becomes a new guard.
- **No secrets in code/logs; no simoneos mutation; no force-push; no `--no-verify`; no classifier bypass** (a classifier
  denial is a hard stop — surface, do not retry with `dangerouslyDisableSandbox`).
- **Public v1 only:** no authed/social-login navigation, no real CRM, no PII-handling layer (deferred to v2 per spec §13).
- **Every PR** that leaves `docs/PGAS-NEW-ARCHITECTURE.md` differing from the latest `v*` release tag MUST carry a
  `## Architectural changes` body section (the arch-diff CI gate reads the PR body live).
- Scratch/experiment artifacts live under `.dd-report-exp/lead-research/`. Preserve every merged behavior — the
  legal-opinion spotless drive and the document-finalization line must still pass.

## File Structure

**Foundry source (modified/created):**
- `src/foundry-program/capability-registry.ts` — add 4 capability entries + text/structural detectors (§ Concern 1 of map).
- `src/foundry-program/stage-classifier.ts` — add `web-navigation` recognition + `export_kind: 'export_pdf'` +
  connector-gap marks (mirror `explicitDelegationIntegrationGap`, `stage-classifier.ts:233`).
- `src/foundry-program/synthesizer.ts` — feature union for the new program shape; guard/tool-vocabulary emission;
  fan-out-with-bounded-follow-on; connector `capability_gaps` collection (`synthesizeProgramSpecFromDomain`, `:190`).
- `src/foundry-program/domain-synthesis.ts` — three connector stage-body emitters + the PDF report-data assembler + the
  extraction-schema-parameterized contract (mirror `renderRepoIntegrationStageBody` `:2220` and `renderDocxExportStageBody`
  `:2319`).
- `src/foundry-program/synthesizer/registration-artifacts.ts` — PDF `artifactPolicy` injection (mirror `:5`).
- `templates/pgas-new/consumer/` — new `.tmpl` files: `web-navigation-connector.ts.tmpl` + `web-navigation-mock.ts.tmpl`,
  `persistence-connector.ts.tmpl` + `persistence-mock.ts.tmpl`, `pdf-report-connector.ts.tmpl` +
  `pdf-report-mock.ts.tmpl`, `report-data.ts.tmpl` (pure-compute report assembler).
- `src/pgas-new/version.ts` — bump `PGAS_SERVER_VERSION` only if an engine bump is required (currently 3.26.0 — **no bump
  expected**); `package.json` foundry version 3.25.0 → 3.26.0 at release.

**Falsifier tests (created), all under `tests/integration/`:**
- `web-navigation-guard-falsifier.test.ts` — the anti-rogue kill-test suite (G-1..G-7).
- `web-navigation-mock.test.ts` — connector/mock contract conformance.
- `cross-session-persistence-falsifier.test.ts` — dedupe/upsert across a simulated prior-session store.
- `pdf-report-export-falsifier.test.ts` — report-data assembly + artifact harvest (mirror `export-render-falsifier`).
- `extraction-schema-parameterization.test.ts` — a custom `extraction_schema` shapes the extraction stage's contract.
- `lead-research-hermetic-smoke.test.ts` — full end-to-end drive against all three mocks.

**Domain-intake + graduation (created):**
- `.dd-report-exp/lead-research/lead-research-agent-domain.json` — the domain-intake JSON.
- `.dd-report-exp/lead-research/resynthesize-lead-research.ts` — deterministic re-synthesis script (mirror the
  doc-finalization `resynthesize-document-finalization.ts`).
- `.dd-report-exp/lead-research/graduation/GRADUATION-HANDOFF.md` — curator handoff (connectors to implement, guard
  obligations, pgas-web extraction pointer).

---

## Task 1: Config-driven intake + `extraction_schema` parameterization

Foundational: unblocks the domain JSON. Prove that a config-supplied `extraction_schema` deterministically shapes the
extraction stage's output contract, so the program is domain-agnostic (spec §3, §9-cap-4). Capability
`config_driven_extraction_schema` → `synthesizes` (no host dependency).

**Files:**
- Create: `tests/integration/extraction-schema-parameterization.test.ts`
- Modify: `src/foundry-program/capability-registry.ts` (add entry + detector)
- Modify: `src/foundry-program/domain-synthesis.ts` (extraction-stage contract reads `extraction_schema` from the stage's
  `domain_spec.produces`)
- Modify: `src/foundry-program/synthesizer.ts:190` (`synthesizeProgramSpecFromDomain` — thread `extraction_schema` from the
  stage into the reasoning contract)

**Interfaces:**
- Consumes: `synthesizeProgramSpecFromDomain(domain, options)` (`synthesizer.ts:190`), `StageDomainSpec { reads, produces,
  rules, invariants }` (`synthesizer.ts:6173`), `classifyStagesForDomain` (`stage-classifier.ts:91`).
- Produces: an llm-reasoning `extract_leads` stage whose `result_json` field set is exactly the config
  `extraction_schema` keys; a capability key `config_driven_extraction_schema`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/extraction-schema-parameterization.test.ts
import { describe, it, expect } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

const EXTRACTION_SCHEMA = {
  name: 'string', role: 'string', company: 'string',
  email: 'string', profile_url: 'string', notes: 'string', relevance_score: 'number',
};

function domainWithSchema(schema: Record<string, string>) {
  return {
    'program.slug': 'lead-research-agent',
    'program.name': 'Lead Research Agent',
    'intake.purpose': 'Find purpose-relevant leads and contacts across configured sources.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'extract_leads',
        domain_spec: {
          reads: ['work.source.pages'],
          // extraction_schema is the config-driven output contract:
          produces: { result_json: { leads: [schema] } },
          rules: ['Extract only entities relevant to intake.purpose; score each 0..1.'],
          invariants: ['Every emitted lead has every extraction_schema key.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'extract_leads' }, { from: 'extract_leads', to: 'complete' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'extract_leads.ready' }),
  };
}

describe('config-driven extraction_schema', () => {
  it('shapes the extract stage output contract to exactly the configured schema keys', () => {
    const spec = synthesizeProgramSpecFromDomain(domainWithSchema(EXTRACTION_SCHEMA));
    const stageJson = JSON.stringify(spec);
    // Every configured key appears in the synthesized extract-stage contract.
    for (const key of Object.keys(EXTRACTION_SCHEMA)) {
      expect(stageJson).toContain(key);
    }
  });

  it('a different schema yields a different contract (config, not hardwired)', () => {
    const altSchema = { handle: 'string', platform: 'string', followers: 'number' };
    const spec = synthesizeProgramSpecFromDomain(domainWithSchema(altSchema));
    const stageJson = JSON.stringify(spec);
    for (const key of Object.keys(altSchema)) expect(stageJson).toContain(key);
    // A key unique to the default schema must NOT leak in.
    expect(stageJson).not.toContain('relevance_score');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run tests/integration/extraction-schema-parameterization.test.ts`
Expected: FAIL — the extract stage contract does not yet carry the config schema keys (or the second test leaks
`relevance_score`).

- [ ] **Step 3: Thread `extraction_schema` into the reasoning contract**

In `domain-synthesis.ts`, where an llm-reasoning stage's contract is synthesized from `domain_spec.produces`
(the `promptForStage` / reasoning-contract path, `domain-synthesis.ts:941`), ensure the `produces` object is passed through
verbatim into the emitted reasoning contract's output schema (it likely already is for generic stages — the failure will
tell you whether a normalization step is dropping nested array-of-object schemas). Add a normalization branch that treats
`produces.result_json.<field>` whose value is an **array of one object** as a repeated-record schema and preserves every
inner key. Mirror how `StageDomainSpec.produces` is consumed for existing stages; do not special-case the field name
`leads` — key it off the array-of-object shape so it stays domain-agnostic.

- [ ] **Step 4: Add the capability entry + detector**

In `capability-registry.ts`, add to `FOUNDRY_CAPABILITY_REGISTRY` (`:47`):

```ts
{
  capability: 'config_driven_extraction_schema',
  status: 'synthesizes',
  evidence: capabilityEvidence([
    'extract stage output contract is generated from intake extraction_schema config, not hardwired',
    'proven by extraction-schema-parameterization.test.ts (two distinct schemas → two distinct contracts)',
  ]),
  since_version: '3.26.0',
},
```

Add a structural detector (mirror `detectDelegationCapabilities`, `capability-registry.ts:334`) that returns this demand
when any stage's `domain_spec.produces` contains an array-of-object schema; wire it into `detectRequestedCapabilities`
(`:444`).

- [ ] **Step 5: Run the test — expect PASS**

Run: `npx vitest run tests/integration/extraction-schema-parameterization.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Regression + commit**

Run: `npm run typecheck && npx vitest run tests/integration/`
Expected: green (no regression in existing falsifiers).

```bash
git add src/foundry-program/capability-registry.ts src/foundry-program/domain-synthesis.ts \
  src/foundry-program/synthesizer.ts tests/integration/extraction-schema-parameterization.test.ts
git commit -m "feat(foundry): config-driven extraction_schema shapes extract-stage contract"
```

---

## Task 2: `WebNavigationHostConnector` contract + mock

Emit the typed guarded-navigation connector + a mock that returns fixture pages/items, and register the capability as
`scaffolds_with_gap` (host connector; curator wires pgas-web's driver). Guards themselves are Task 3 — here we establish
the contract + mock + fixtures the guard falsifiers will drive.

**Files:**
- Create: `templates/pgas-new/consumer/web-navigation-connector.ts.tmpl`
- Create: `templates/pgas-new/consumer/web-navigation-mock.ts.tmpl`
- Create: `tests/integration/web-navigation-mock.test.ts`
- Modify: `src/foundry-program/capability-registry.ts` (entry `web_navigation_guarded` → `scaffolds_with_gap`)
- Modify: `src/foundry-program/stage-classifier.ts` (recognize a `web-navigation` external-adapter stage + emit
  `integration_gap`, mirror `explicitDelegationIntegrationGap` `:233`)
- Modify: `src/foundry-program/domain-synthesis.ts` (emit the connector stage body — mirror `renderRepoIntegrationStageBody`
  `:2220`, importing `../connectors/web-navigation.js`)

**Interfaces:**
- Produces (the connector contract the curator must implement, and the mock satisfies):

```ts
// templates/pgas-new/consumer/web-navigation-connector.ts.tmpl (emitted to src/programs/<slug>/connectors/web-navigation.ts)
export interface GuardContext {
  readonly allowed_domains: readonly string[];     // registrable domains the run may touch
  readonly max_depth: number;                       // follow-on link depth ceiling
  readonly max_pages: number;                       // pages fetched per source ceiling
  readonly max_follow_links: number;                // links followed per page ceiling
  readonly min_delay_ms: number;                    // per-domain pacing floor
  readonly max_concurrency: number;                 // concurrent fetches ceiling
}
export interface NavAuditEntry {
  readonly action: 'fetch' | 'follow' | 'extract' | 'skip' | 'refuse';
  readonly url: string;
  readonly reason?: string;                         // populated for skip/refuse
  readonly at_depth: number;
}
export interface ExtractedItem { readonly [key: string]: unknown } // shaped by config extraction_schema
export interface NavigateAndExtractResult {
  readonly items: readonly ExtractedItem[];
  readonly pages_visited: number;
  readonly audit: readonly NavAuditEntry[];
}
export interface WebNavigationHostConnector {
  navigate_and_extract(
    source: string,
    purpose: string,
    extraction_schema: Record<string, string>,
    guard: GuardContext,
  ): Promise<NavigateAndExtractResult>;
}
```

- Consumes: `classifyStagesForDomain` (`stage-classifier.ts:91`), `CapabilityGap { capability, stage, connector_slug,
  message }` (`synthesizer-store.ts:17`).

- [ ] **Step 1: Write the mock + a failing conformance test**

Author `web-navigation-mock.ts.tmpl` (a fixture-backed `WebNavigationHostConnector` — see Task 3 for the guard logic it
must contain; here it just returns fixture items for an in-allowlist source). Then:

```ts
// tests/integration/web-navigation-mock.test.ts
import { describe, it, expect } from 'vitest';
import { MockWebNavigationConnector } from '../fixtures/web-navigation-mock.js'; // rendered from the .tmpl

const GUARD = { allowed_domains: ['example.com'], max_depth: 1, max_pages: 3,
  max_follow_links: 2, min_delay_ms: 0, max_concurrency: 1 };
const SCHEMA = { name: 'string', email: 'string', relevance_score: 'number' };

describe('WebNavigationHostConnector mock', () => {
  it('returns items shaped by extraction_schema and an audit for every action', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/team', 'find engineers', SCHEMA, GUARD);
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) for (const k of Object.keys(SCHEMA)) expect(item).toHaveProperty(k);
    expect(r.audit.length).toBeGreaterThan(0);
    expect(r.pages_visited).toBeLessThanOrEqual(GUARD.max_pages);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (mock/fixture not yet rendered)

Run: `npx vitest run tests/integration/web-navigation-mock.test.ts`
Expected: FAIL — module not found / shape mismatch.

- [ ] **Step 3: Render the mock fixture + implement the mock body**

Render `web-navigation-mock.ts.tmpl` to `tests/fixtures/web-navigation-mock.js` (via the test-util that renders consumer
templates — mirror how `extract-docx.ts.tmpl` is exercised). Implement the mock to serve a small in-memory site map for
`example.com` and emit one `ExtractedItem` per configured schema with fixture values, plus a `fetch`/`extract` audit entry.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/integration/web-navigation-mock.test.ts` → PASS.

- [ ] **Step 5: Classifier + capability + gap wiring**

In `stage-classifier.ts`, recognize a stage marked `{ archetype: 'external-adapter', integration: 'web_navigation' }` (or
purpose/term-detected `navigate`/`scrape`/`crawl`) and emit `integration_gap: true`, `integration_name: 'web_navigation'`,
`connector_slug: 'web-navigation'` (mirror `explicitDelegationIntegrationGap`, `:233`). In `synthesizer.ts`, collect that
into `artifact.capability_gaps` as `{ capability: 'web_navigation_guarded', stage, connector_slug: 'web-navigation',
message: 'guarded browser navigation is host-side; implement WebNavigationHostConnector (pgas-web driver)' }`. In
`capability-registry.ts` add:

```ts
{
  capability: 'web_navigation_guarded',
  status: 'scaffolds_with_gap',
  evidence: capabilityEvidence(['typed WebNavigationHostConnector + guard-enforcing mock; real driver is host-side (pgas-web)']),
  since_version: '3.26.0',
  gap_note: 'browser navigation permanently host-side; foundry ships contract + mock + spec/connector guards only',
},
```
Add a text detector (`navigate|crawl|scrape|browse|website|social`) → this capability.

- [ ] **Step 6: Emit the connector stage body**

In `domain-synthesis.ts`, add a `renderWebNavigationStageBody(stage, descriptor)` mirroring `renderRepoIntegrationStageBody`
(`:2220`): it imports the typed connector from `../connectors/web-navigation.js`, reads `source`, `purpose`,
`extraction_schema`, and the assembled `GuardContext` from `input.domain`, calls `navigate_and_extract`, and writes
`{ items, pages_visited, audit }` to `result_json`. The body is foundry-emitted deterministic (NOT LLM-emitted); assert the
mock-generator is not called for this stage (mirror the export-stage no-LLM assertion).

- [ ] **Step 7: Regression + commit**

Run: `npm run typecheck && npx vitest run tests/integration/`

```bash
git add templates/pgas-new/consumer/web-navigation-connector.ts.tmpl \
  templates/pgas-new/consumer/web-navigation-mock.ts.tmpl \
  tests/integration/web-navigation-mock.test.ts src/foundry-program/capability-registry.ts \
  src/foundry-program/stage-classifier.ts src/foundry-program/domain-synthesis.ts
git commit -m "feat(foundry): WebNavigationHostConnector contract + guard-ready mock + scaffolds_with_gap"
```

---

## Task 3: Deterministic anti-rogue guard set (the load-bearing task)

Make the guards structural and falsifiable. This is the spec's safety core (§5) and the pgas-rag rogue-scraper lesson made
concrete. Guards are enforced by three mechanisms, none of which is the LLM:

1. **Tool-vocabulary (structural, spec-level):** the generated program exposes exactly one web action —
   `navigate_and_extract` through the connector. There is **no** payment/checkout/login/credential tool in the vocabulary,
   so an adversarial model has nothing to call. This enforces **no-spend** and **no-login**.
2. **Connector-parameter (config-bound, mock-enforced):** the mock (and the curator's real driver, by contract) enforces
   **domain allowlist**, **follow-on caps** (`max_depth`/`max_pages`/`max_follow_links`), **robots.txt**, and **pacing**
   from the `GuardContext`. Off-list → `refuse` audit + no fetch; over-cap → `skip` audit + stop; robots-disallowed →
   `skip`; pacing respected.
3. **Stage-persisted audit (spec-level):** the navigation stage handler ALWAYS writes the connector's `audit[]` to durable
   state via `result_path`; it is a deterministic handler write, not an LLM decision, so **audit cannot be skipped**.

**Files:**
- Create: `tests/integration/web-navigation-guard-falsifier.test.ts` (G-1..G-7 kill tests)
- Modify: `templates/pgas-new/consumer/web-navigation-mock.ts.tmpl` (implement all guard checks in the mock)
- Modify: `src/foundry-program/synthesizer.ts` (assert the emitted spec's action/tool vocabulary excludes
  spend/login actions for this program shape; assemble `GuardContext` from `guard_config` into the nav stage's input domain)

**Interfaces:**
- Consumes: `GuardContext`, `NavAuditEntry` (Task 2); `synthesizeProgramSpecFromDomain` (`:190`).
- Produces: a mock that enforces all seven guards; a synthesized spec whose tool vocabulary provably lacks spend/login.

- [ ] **Step 1: Write the G-1..G-7 kill-test suite (failing)**

```ts
// tests/integration/web-navigation-guard-falsifier.test.ts
import { describe, it, expect } from 'vitest';
import { MockWebNavigationConnector } from '../fixtures/web-navigation-mock.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { leadResearchDomain } from '../fixtures/lead-research-domain.js'; // small fixture domain

const SCHEMA = { name: 'string', email: 'string', relevance_score: 'number' };
const base = { allowed_domains: ['example.com'], max_depth: 1, max_pages: 2,
  max_follow_links: 1, min_delay_ms: 10, max_concurrency: 1 };

describe('web-navigation anti-rogue guards (kill tests)', () => {
  it('G-1 domain allowlist: off-list source is refused, never fetched', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://evil.test/x', 'p', SCHEMA, base);
    expect(r.items).toHaveLength(0);
    expect(r.pages_visited).toBe(0);
    expect(r.audit.some(a => a.action === 'refuse' && a.url.includes('evil.test'))).toBe(true);
  });

  it('G-2 follow-on depth cap: no audit entry exceeds max_depth', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/deep', 'p', SCHEMA, { ...base, max_depth: 1 });
    expect(Math.max(...r.audit.map(a => a.at_depth))).toBeLessThanOrEqual(1);
  });

  it('G-3 page cap: pages_visited never exceeds max_pages (anti-sprawl)', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/many', 'p', SCHEMA, { ...base, max_pages: 2 });
    expect(r.pages_visited).toBeLessThanOrEqual(2);
  });

  it('G-4 follow-links cap: links followed per page never exceeds max_follow_links', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/hub', 'p', SCHEMA, { ...base, max_follow_links: 1 });
    const follows = r.audit.filter(a => a.action === 'follow');
    expect(follows.length).toBeLessThanOrEqual(1);
  });

  it('G-5 robots.txt: a robots-disallowed path is skipped with reason', async () => {
    const c = new MockWebNavigationConnector();
    const r = await c.navigate_and_extract('https://example.com/private', 'p', SCHEMA, base); // fixture robots disallows /private
    expect(r.audit.some(a => a.action === 'skip' && /robots/i.test(a.reason ?? ''))).toBe(true);
  });

  it('G-6 pacing: respects min_delay_ms between same-domain fetches', async () => {
    const c = new MockWebNavigationConnector();
    const spy: number[] = [];
    c.onFetch = (t: number) => spy.push(t);        // mock records simulated fetch clock ticks
    await c.navigate_and_extract('https://example.com/many', 'p', SCHEMA, { ...base, max_pages: 2, min_delay_ms: 100 });
    if (spy.length >= 2) expect(spy[1] - spy[0]).toBeGreaterThanOrEqual(100);
  });

  it('G-7 no-spend / no-login: synthesized tool vocabulary exposes no payment or login action', () => {
    const spec = synthesizeProgramSpecFromDomain(leadResearchDomain());
    const wire = JSON.stringify(spec).toLowerCase();
    for (const forbidden of ['checkout', 'payment', 'purchase', 'add_to_cart', 'login', 'sign_in', 'credential', 'password']) {
      expect(wire).not.toContain(`"${forbidden}"`); // no action/tool NAMED for a forbidden capability
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL** on the guards not yet implemented

Run: `npx vitest run tests/integration/web-navigation-guard-falsifier.test.ts`
Expected: FAIL (G-1..G-6 mock guards missing; G-7 passes only once vocabulary is confirmed clean).

- [ ] **Step 3: Implement all guard checks in the mock**

In `web-navigation-mock.ts.tmpl`, implement, in order, before any fetch: (a) registrable-domain allowlist check
→ `refuse` audit + early return when off-list; (b) a fixture `robots.txt` map (`/private` disallowed) → `skip` audit;
(c) a page counter that stops at `max_pages`; (d) a per-page follow counter capped at `max_follow_links`; (e) a depth
guard that never enqueues beyond `max_depth`; (f) a simulated monotonic clock that advances by `min_delay_ms` between
same-domain fetches and invokes `onFetch(tick)`. Every branch emits the correct `NavAuditEntry`. Keep the real-driver
contract identical so the curator's pgas-web wiring inherits these obligations.

- [ ] **Step 4: Confirm the tool vocabulary is structurally clean (G-7)**

In `synthesizer.ts`, ensure the lead-research program shape emits only the intended actions/tools (intake, per-source
navigate_and_extract, extract, aggregate, dedupe/persist, render-report, complete). Add an assertion path (or confirm the
existing tool-registry assembly, `synthesizer.ts:376` feature union + tools emission) never introduces a spend/login tool.
If any generic emitter could inject one, gate it off for this program shape. G-7 is the structural no-spend/no-login proof.

- [ ] **Step 5: Run — expect PASS** (G-1..G-7)

Run: `npx vitest run tests/integration/web-navigation-guard-falsifier.test.ts` → all green.

- [ ] **Step 6: Regression + commit**

Run: `npm run typecheck && npx vitest run tests/integration/`

```bash
git add tests/integration/web-navigation-guard-falsifier.test.ts \
  templates/pgas-new/consumer/web-navigation-mock.ts.tmpl src/foundry-program/synthesizer.ts
git commit -m "feat(foundry): deterministic anti-rogue web-navigation guards (G-1..G-7 kill tests)"
```

---

## Task 4: Fan-out per source with bounded agentic follow-on

Reuse the legal-opinion/DD per-item fan-out to iterate over `sources`, and make each per-source branch a **bounded**
guarded navigation (the follow-on caps from Task 3 flow through). Prove the fan-out visits every configured source and that
per-source bounding holds under fan-out (anti-sprawl end-to-end).

**Files:**
- Modify: `src/foundry-program/synthesizer.ts` (fan-out over `sources` — mirror the `DelegationDocumentFanOutDescriptor`
  path, `synthesizer-store.ts:9`; here the fanned item is a *source*, and each branch calls the nav connector with the
  per-source `GuardContext`)
- Modify: `src/foundry-program/domain-synthesis.ts` (per-source nav stage body reads the current fanned source)
- Create: `tests/integration/lead-research-fanout.test.ts`

**Interfaces:**
- Consumes: `DelegationDocumentFanOutDescriptor { source, current_document, result_path, completion_guard, index_path }`
  (`synthesizer-store.ts:9`) — reused with `source = 'work.config.sources'`, `current_document = 'work.current_source'`.
- Produces: a synthesized spec whose fan-out iterates the sources list and aggregates per-source
  `{ items, pages_visited, audit }` into `work.aggregate.per_source[]`.

- [ ] **Step 1: Write the failing fan-out test**

```ts
// tests/integration/lead-research-fanout.test.ts
import { describe, it, expect } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { leadResearchDomain } from '../fixtures/lead-research-domain.js';

describe('per-source fan-out', () => {
  it('synthesizes a fan-out that iterates the configured sources and aggregates per-source results', () => {
    const spec = synthesizeProgramSpecFromDomain(leadResearchDomain(/* sources: 3 */));
    const wire = JSON.stringify(spec);
    // fan-out descriptor targets the sources list and a current-source cursor
    expect(wire).toContain('work.config.sources');
    expect(wire).toContain('current_source');
    // aggregation path present
    expect(wire).toContain('per_source');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/integration/lead-research-fanout.test.ts` → FAIL.

- [ ] **Step 3: Wire fan-out over sources**

In `synthesizer.ts`, at the delegation/fan-out normalization (`:220`), support a fan-out whose iterated collection is a
config list (`work.config.sources`) rather than uploaded documents, emitting an `AfterRound` iterate reaction with a
`current_source` cursor and an `index_path`, and aggregating each branch's nav result under `work.aggregate.per_source`.
Mirror `DelegationDocumentFanOutDescriptor` (`synthesizer-store.ts:9`); do not fork a new descriptor type if the existing
one generalizes — just bind `source` to the config list. The per-source branch invokes the Task 2 nav stage with the
Task 3 `GuardContext`, so the bounds are per source.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/integration/lead-research-fanout.test.ts` → PASS.

- [ ] **Step 5: End-to-end bounding under fan-out (extend the guard falsifier)**

Add G-8 to `web-navigation-guard-falsifier.test.ts`: drive the fixture domain with 3 sources through the hermetic route
(reuse the Task 7 harness once available, or a minimal 2-source mock aggregation here) and assert
`sum(per_source.pages_visited) <= sources.length * max_pages` — bounding composes across the fan-out.

- [ ] **Step 6: Regression + commit**

Run: `npm run typecheck && npx vitest run tests/integration/`

```bash
git add src/foundry-program/synthesizer.ts src/foundry-program/domain-synthesis.ts \
  tests/integration/lead-research-fanout.test.ts tests/integration/web-navigation-guard-falsifier.test.ts
git commit -m "feat(foundry): per-source fan-out with bounded follow-on (anti-sprawl composes)"
```

---

## Task 5: `PersistenceHostConnector` contract + mock (cross-session dedupe/upsert)

Emit the typed cross-session persistence connector + a mock in-memory store with dedupe, and register
`cross_session_persistence` → `scaffolds_with_gap`. Prove upsert/dedupe correctness across a simulated prior-session store
(the CRM foundation).

**Files:**
- Create: `templates/pgas-new/consumer/persistence-connector.ts.tmpl`
- Create: `templates/pgas-new/consumer/persistence-mock.ts.tmpl`
- Create: `tests/integration/cross-session-persistence-falsifier.test.ts`
- Modify: `src/foundry-program/capability-registry.ts`, `stage-classifier.ts`, `domain-synthesis.ts` (mirror Task 2)

**Interfaces:**
- Produces:

```ts
// persistence-connector.ts.tmpl → src/programs/<slug>/connectors/persistence.ts
export interface LeadRecord { readonly [key: string]: unknown } // shaped by extraction_schema; dedupe_key must be present
export interface UpsertResult { readonly inserted: number; readonly updated: number; readonly ids: readonly string[] }
export interface PersistenceHostConnector {
  upsert_lead(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  upsert_contact(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  query(filter: Record<string, unknown>): Promise<readonly LeadRecord[]>;
  dedupe(records: readonly LeadRecord[], dedupe_key: string): Promise<readonly LeadRecord[]>;
}
```

- Consumes: `CapabilityGap` (`synthesizer-store.ts:17`), classifier gap path (Task 2 mirror).

- [ ] **Step 1: Write the failing dedupe/upsert falsifier**

```ts
// tests/integration/cross-session-persistence-falsifier.test.ts
import { describe, it, expect } from 'vitest';
import { MockPersistenceConnector } from '../fixtures/persistence-mock.js';

const KEY = 'email';
const s1 = [{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'b@x.com' }];

describe('PersistenceHostConnector mock (cross-session)', () => {
  it('P-1 upsert inserts new records', async () => {
    const c = new MockPersistenceConnector();
    const r = await c.upsert_lead(s1, KEY);
    expect(r.inserted).toBe(2);
    expect(r.updated).toBe(0);
  });

  it('P-2 cross-session dedupe: re-running with an overlapping record updates, not duplicates', async () => {
    const c = new MockPersistenceConnector();
    await c.upsert_lead(s1, KEY);                                  // "prior session"
    const r = await c.upsert_lead([{ name: 'A2', email: 'a@x.com' }, { name: 'C', email: 'c@x.com' }], KEY);
    expect(r.inserted).toBe(1);                                    // only C is new
    expect(r.updated).toBe(1);                                    // a@x.com updated in place
    const all = await c.query({});
    expect(all.length).toBe(3);                                    // A(updated), B, C — no dup for a@x.com
  });

  it('P-3 dedupe() within a batch collapses same-key rows before upsert', async () => {
    const c = new MockPersistenceConnector();
    const deduped = await c.dedupe([{ email: 'z@x.com' }, { email: 'z@x.com' }], KEY);
    expect(deduped.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (mock not rendered)

Run: `npx vitest run tests/integration/cross-session-persistence-falsifier.test.ts` → FAIL.

- [ ] **Step 3: Implement the mock store**

Render `persistence-mock.ts.tmpl` → `tests/fixtures/persistence-mock.js`: a `Map` keyed by `dedupe_key`; `upsert_*`
inserts-or-updates by key and reports `{ inserted, updated, ids }`; `query` filters; `dedupe` collapses same-key rows
keeping the last. The store persists for the connector instance's lifetime (simulating cross-session).

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/integration/cross-session-persistence-falsifier.test.ts` → PASS.

- [ ] **Step 5: Classifier + capability + gap + connector stage body** (mirror Task 2 Steps 5–6)

Add capability entry `cross_session_persistence` → `scaffolds_with_gap` (gap: "cross-session store is host-side; implement
PersistenceHostConnector (the CRM store)"); text detector (`persist|database|store|crm|across sessions|leads?`); classifier
gap mark (`connector_slug: 'persistence'`); `renderPersistenceStageBody` in `domain-synthesis.ts` that dedupes then upserts
and writes `{ inserted, updated, new_vs_existing }` to `result_json`.

- [ ] **Step 6: Regression + commit**

Run: `npm run typecheck && npx vitest run tests/integration/`

```bash
git add templates/pgas-new/consumer/persistence-connector.ts.tmpl \
  templates/pgas-new/consumer/persistence-mock.ts.tmpl \
  tests/integration/cross-session-persistence-falsifier.test.ts \
  src/foundry-program/capability-registry.ts src/foundry-program/stage-classifier.ts \
  src/foundry-program/domain-synthesis.ts
git commit -m "feat(foundry): PersistenceHostConnector contract + cross-session dedupe/upsert mock"
```

---

## Task 6: `PdfReportHostConnector` + report-data assembler + artifact harvest

Foundry owns the report **data assembly** (pure-compute, deterministic) and the connector **contract + mock**; the SOTA PDF
rendering is host-side. Register `export_pdf_report` → `scaffolds_with_gap`. Prove the report data carries every required
section (incl. the guard/audit summary that proves respectful navigation) and that the rendered bytes are harvested as a
first-class `SessionArtifactRecord`.

**Files:**
- Create: `templates/pgas-new/consumer/report-data.ts.tmpl` (pure-compute assembler: state → structured report)
- Create: `templates/pgas-new/consumer/pdf-report-connector.ts.tmpl`
- Create: `templates/pgas-new/consumer/pdf-report-mock.ts.tmpl`
- Create: `tests/integration/pdf-report-export-falsifier.test.ts` (mirror `export-render-falsifier.test.ts`)
- Modify: `src/foundry-program/capability-registry.ts`, `stage-classifier.ts` (add `export_kind: 'export_pdf'`),
  `domain-synthesis.ts` (`renderPdfReportStageBody` mirroring `renderDocxExportStageBody` `:2319`),
  `src/foundry-program/synthesizer/registration-artifacts.ts` (PDF `artifactPolicy`, mirror `:5`)

**Interfaces:**
- Produces:

```ts
// pdf-report-connector.ts.tmpl → src/programs/<slug>/connectors/pdf-report.ts
export interface StructuredReport {
  readonly title: string;
  readonly purpose: string;
  readonly executive_summary: string;
  readonly per_source: ReadonlyArray<{ source: string; found: number; pages_visited: number }>;
  readonly leads: readonly Record<string, unknown>[];       // new_vs_existing flagged
  readonly guard_audit_summary: ReadonlyArray<{ action: string; url: string; reason?: string }>;
}
export interface PdfReportHostConnector { render_report(report: StructuredReport): Promise<Uint8Array> }
```

- Consumes: `renderDocxExportStageBody` (`domain-synthesis.ts:2319`) as the emitter template; `renderRegistrationSource`
  (`registration-artifacts.ts:5`) for `artifactPolicy`.

- [ ] **Step 1: Write the failing report-data + artifact falsifier**

```ts
// tests/integration/pdf-report-export-falsifier.test.ts  (mirror export-render-falsifier F-1..F-3)
import { describe, it, expect } from 'vitest';
import { assembleStructuredReport } from '../fixtures/report-data.js';       // rendered from report-data.ts.tmpl
import { MockPdfReportConnector } from '../fixtures/pdf-report-mock.js';

const state = {
  config: { purpose: 'find AI engineers', title: 'Lead Report' },
  aggregate: { per_source: [{ source: 'https://example.com', found: 2, pages_visited: 2 }] },
  persist: { new_vs_existing: [{ email: 'a@x.com', status: 'new' }] },
  audit: [{ action: 'refuse', url: 'https://evil.test', reason: 'off-allowlist' }],
};

describe('PDF report export', () => {
  it('R-1 assembler is pure-compute and includes every required section incl. guard/audit summary', () => {
    const report = assembleStructuredReport(state);
    expect(report.executive_summary.length).toBeGreaterThan(0);
    expect(report.per_source.length).toBe(1);
    expect(report.leads.length).toBe(1);
    expect(report.guard_audit_summary.some(a => a.action === 'refuse')).toBe(true); // proves respectful nav is reported
  });

  it('R-2 kill test: a run nonce in state reaches the rendered artifact (state-injected, not template default)', async () => {
    const nonce = 'PDF-SENTINEL-' + Math.random().toString(36).slice(2);
    const report = assembleStructuredReport({ ...state, config: { ...state.config, title: nonce } });
    const bytes = await new MockPdfReportConnector().render_report(report);
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toContain(nonce);              // mock embeds title verbatim; proves data flowed through
    expect(text).not.toContain('LEAD REPORT DEFAULT'); // hard-coded default absent
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/integration/pdf-report-export-falsifier.test.ts` → FAIL.

- [ ] **Step 3: Implement the assembler + mock**

`report-data.ts.tmpl`: pure function `assembleStructuredReport(domain): StructuredReport` reading
`aggregate.per_source`, `persist.new_vs_existing`, `audit`, and `config` — no LLM, no network. `pdf-report-mock.ts.tmpl`:
`render_report` returns deterministic bytes that embed `report.title` + section headers verbatim (a valid-shaped stub, not
a real PDF) so the kill test can prove data flow. Default title constant is `'LEAD REPORT DEFAULT'`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/integration/pdf-report-export-falsifier.test.ts` → PASS.

- [ ] **Step 5: Emit the export stage body + artifactPolicy + capability**

In `stage-classifier.ts` add `export_kind: 'export_pdf'` recognition. In `domain-synthesis.ts` add
`renderPdfReportStageBody` mirroring `renderDocxExportStageBody` (`:2319`): imports the assembler + connector, reads
`input.domain`, calls `render_report`, writes `{ pdf_base64, pdf_bytes, sha256, section_count }` to `result_json`
(foundry-emitted deterministic body, no LLM). In `registration-artifacts.ts`, inject an `artifactPolicy` with a
`dataExtractor` reading `<stage>.output.pdf_base64` → `SessionArtifactRecord` type `'pdf_report'` (mirror `:278` docx
policy). Add capability entry `export_pdf_report` → `scaffolds_with_gap` (gap: "SOTA PDF rendering is host-side; foundry
ships report-data assembler + PdfReportHostConnector contract + mock"); text detector (`\bpdf\b|report`) → this capability.

- [ ] **Step 6: Regression + commit**

Run: `npm run typecheck && npx vitest run tests/integration/`

```bash
git add templates/pgas-new/consumer/report-data.ts.tmpl \
  templates/pgas-new/consumer/pdf-report-connector.ts.tmpl \
  templates/pgas-new/consumer/pdf-report-mock.ts.tmpl \
  tests/integration/pdf-report-export-falsifier.test.ts src/foundry-program/capability-registry.ts \
  src/foundry-program/stage-classifier.ts src/foundry-program/domain-synthesis.ts \
  src/foundry-program/synthesizer/registration-artifacts.ts
git commit -m "feat(foundry): PDF report-data assembler + PdfReportHostConnector + artifact harvest"
```

---

## Task 7: Domain-intake JSON + resynthesis script + full hermetic smoke

Assemble the real `lead-research-agent-domain.json`, render the program, and drive it end-to-end against all three mocks:
`intake → fan-out per source → guarded navigate_and_extract (mock) → extract (schema) → aggregate → dedupe → upsert (mock)
→ assemble report → render PDF (mock) → complete`. This is the integration proof the whole program synthesizes and runs.

**Files:**
- Create: `.dd-report-exp/lead-research/lead-research-agent-domain.json`
- Create: `.dd-report-exp/lead-research/resynthesize-lead-research.ts` (mirror
  `resynthesize-document-finalization.ts`)
- Create: `tests/integration/lead-research-hermetic-smoke.test.ts`
- Create: `tests/fixtures/lead-research-domain.js` (the small fixture domain the earlier tasks import)

**Interfaces:**
- Consumes: `synthesizeProgramSpecFromDomain` (`:190`), `assertSynthesizableCapabilities` (`capability-registry.ts:530`),
  the hermetic route harness (`tests/integration/foundry-test-utils.ts`), all three mocks.
- Produces: a rendered `lead-research-agent` program that reaches `complete` against mocks; a capability assessment showing
  3 `scaffolds_with_gap` + `config_driven_extraction_schema` `synthesizes` and **zero** `refuses`.

- [ ] **Step 1: Author the domain-intake JSON**

Write `lead-research-agent-domain.json` with the full stage chain (mirror `.dd-report-exp/reduced-dd-report-domain.json`
shape): `intake` (bootstrap, reads config: sources/purpose/extraction_schema/guard_config) → fan-out
`navigate_source` (external-adapter, `integration: web_navigation`, per-source, bounded) → `extract_leads`
(llm-reasoning, `produces.result_json.leads = [extraction_schema]`) → `aggregate` (pure-compute) → `persist`
(external-adapter, `integration: persistence`) → `render_report` (`export_kind: export_pdf`) → `complete`. Include
`guard_config` defaults in the config block and the audit collection path.

- [ ] **Step 2: Write the failing capability-assessment + render assertion**

```ts
// part of lead-research-hermetic-smoke.test.ts
import { describe, it, expect } from 'vitest';
import domain from '../../.dd-report-exp/lead-research/lead-research-agent-domain.json' assert { type: 'json' };
import { assertSynthesizableCapabilities } from '../../src/foundry-program/capability-registry.js';

it('assesses as scaffolds_with_gap (3 connectors) with zero refuses', () => {
  const a = assertSynthesizableCapabilities({
    purpose: domain['intake.purpose'] as string,
    stages: JSON.parse(domain['intake.stages_json'] as string),
    extraText: JSON.stringify(domain),
  });
  expect(a.refuses).toHaveLength(0);
  const gapped = a.scaffolds_with_gap.map(d => d.capability);
  expect(gapped).toEqual(expect.arrayContaining(
    ['web_navigation_guarded', 'cross_session_persistence', 'export_pdf_report']));
});
```

- [ ] **Step 3: Run — expect FAIL / iterate the domain JSON**

Run: `npx vitest run tests/integration/lead-research-hermetic-smoke.test.ts`
Expected: FAIL until the domain JSON + detectors line up; iterate the JSON (not the detectors) where possible.

- [ ] **Step 4: Write the end-to-end hermetic drive**

Add to the smoke test: render the program to a temp dir via the resynthesis path, boot it on the route harness
(`foundry-test-utils.ts`) with all three connectors bound to their **mocks**, drive with a fixture author-response script
(or the deterministic scaffold-drive utility) through every mode, and assert final `status === 'complete'`,
`work.aggregate.per_source.length === sources.length`, `work.persist.new_vs_existing` populated, and a harvested
`SessionArtifactRecord` of type `'pdf_report'` whose bytes contain the report title. Assert the audit collection is
non-empty and includes at least one guard action.

- [ ] **Step 5: Author the resynthesis script + run it**

`resynthesize-lead-research.ts`: load the domain JSON → `synthesizeProgramSpecFromDomain` → render scaffold to
`.dd-report-exp/lead-research/generated/`. Run: `npx tsx .dd-report-exp/lead-research/resynthesize-lead-research.ts` and
confirm the scaffold renders + typechecks.

- [ ] **Step 6: Run the full smoke — expect PASS**

Run: `npx vitest run tests/integration/lead-research-hermetic-smoke.test.ts` → PASS (reaches `complete`).

- [ ] **Step 7: Full regression + commit**

Run: `npm test` (unit + static + integration).

```bash
git add .dd-report-exp/lead-research/ tests/integration/lead-research-hermetic-smoke.test.ts \
  tests/fixtures/lead-research-domain.js
git commit -m "test(foundry): lead-research-agent domain JSON + full hermetic smoke (complete via mocks)"
```

---

## Task 8: Graduation package + release

Stage the curator handoff and cut the foundry release. No simoneos mutation — the handoff is a package the curator picks up.

**Files:**
- Create: `.dd-report-exp/lead-research/graduation/GRADUATION-HANDOFF.md`
- Modify: `package.json` (foundry version 3.25.0 → 3.26.0), `CHANGELOG.md`
- Modify (only if a new capability necessitated it): `docs/PGAS-NEW-ARCHITECTURE.md`

**Interfaces:**
- Consumes: the rendered program + hermetic smoke evidence from Task 7.
- Produces: a graduation package + a tagged foundry release.

- [ ] **Step 1: Write `GRADUATION-HANDOFF.md`**

Document: the three connectors the curator must implement (`WebNavigationHostConnector` — wire pgas-web's guarded
Playwright driver + guard logic, honoring the G-1..G-7 obligations verbatim; `PersistenceHostConnector` — the real
DB/CRM store; `PdfReportHostConnector` — the SOTA renderer); the exact guard contract each real impl must satisfy; the
config-parameter surface; and the v2 deferrals (auth/social-login, CRM, PII hardening). Point at
`src/pgas-web/` (the extraction-source driver) explicitly.

- [ ] **Step 2: CHANGELOG + version bump**

Add a `3.26.0` CHANGELOG entry (new capabilities: `config_driven_extraction_schema` synthesizes; `web_navigation_guarded`,
`cross_session_persistence`, `export_pdf_report` scaffold_with_gap). Bump `package.json` to `3.26.0`.

- [ ] **Step 3: Arch-doc reconciliation**

If any task changed `docs/PGAS-NEW-ARCHITECTURE.md`, ensure the release PR body carries the `## Architectural changes`
section (arch-diff gate). If the arch doc is unchanged, no section is needed.

- [ ] **Step 4: Final full gate + commit + tag**

Run: `npm test && npm run typecheck`

```bash
git add package.json CHANGELOG.md .dd-report-exp/lead-research/graduation/GRADUATION-HANDOFF.md
git commit -m "release: v3.26.0 — lead-research-agent foundry capabilities + curator handoff"
git tag v3.26.0
```

Open the release PR; merge on green; publish the tag/release.

---

## Self-Review

**1. Spec coverage** (spec §§1–14 → tasks):
- §3 config params (sources/purpose/extraction_schema/guard_config) → Task 1 (extraction_schema) + Task 7 (full config
  block in domain JSON) + Task 3 (guard_config → GuardContext). ✓
- §4 fan-out pipeline → Task 4. ✓
- §5 seven deterministic guards → Task 3 (G-1..G-7) + Task 4 (G-8 composition). ✓
- §6 three connectors + mocks + scaffolds_with_gap → Tasks 2, 5, 6. ✓
- §7 extraction + dedupe/persist → Task 1 + Task 5. ✓
- §8 SOTA PDF report + artifact → Task 6. ✓
- §9 four new capabilities → Tasks 1 (cap4), 2/3 (cap1), 5 (cap2), 6 (cap3). ✓
- §10 pgas-web reuse → Task 8 handoff (contract obligations in Task 3). ✓
- §11 falsifier-first + hermetic drive → every task + Task 7. ✓
- §12 build & graduation → Task 8. ✓
- §13 v2 deferrals → carried in Task 8 handoff; not implemented (correct). ✓
- §14 risks → mitigated by falsifier-first ordering; the "bounded agentic follow-on as a spec construct" risk is Task 4's
  focus. ✓

**2. Placeholder scan:** No TBD/TODO. Where synthesizer internals must be read rather than reproduced (the 10K-LOC
`synthesizer.ts` emitters), tasks name the exact function + `path:line` to mirror and the change to make — this is precise
mirror-instruction, not a placeholder. Real code is given for every connector interface, capability entry, domain-JSON
shape, and falsifier assertion.

**3. Type consistency:** `GuardContext` / `NavAuditEntry` / `NavigateAndExtractResult` / `ExtractedItem` (Task 2) are reused
verbatim by Tasks 3, 4, 7. `LeadRecord` / `UpsertResult` (Task 5) reused by Task 7. `StructuredReport` (Task 6) reused by
Task 7. `capability-registry.ts` keys (`config_driven_extraction_schema`, `web_navigation_guarded`,
`cross_session_persistence`, `export_pdf_report`) are consistent across their defining task and the Task 7 assessment.
`assembleStructuredReport`, `MockWebNavigationConnector`, `MockPersistenceConnector`, `MockPdfReportConnector`,
`leadResearchDomain()` are named identically at every use. ✓

**Note for the implementer:** where a task says "mirror function X at `path:line`", read that function first — the map that
produced these anchors flagged a few emitter internals (fan-out normalization, connector-gap emission) as
pattern-inferred; verify the precedent before emitting, and let the falsifier be the arbiter.
