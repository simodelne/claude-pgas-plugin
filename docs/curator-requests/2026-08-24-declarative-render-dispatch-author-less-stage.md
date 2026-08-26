# Declarative render dispatch from an AUTHOR-LESS stage (`decision_only` / integration hook)

**Status:** **HALF-SHIPPED in 6.0.0 — pgas#1054 landed the `IntegrationHook.payload`
field asked for below, and it WORKS (reproduced hermetically: an author-less
`decision_only` stage now mints a first-class `artifactType:"render"` docx — `P-1` in
`tests/integration/render-section-list-falsifier.test.ts`). The `render:`-tier
`on_transition:` ALTERNATIVE named at the end of the Ask did NOT ship, and without some
form of hook SCOPE the payload alone is not sufficient: an `OnTransition` hook fires on
EVERY mode change, so the same declaration mints one artifact per transition, including
content-incomplete ones. The residual half is refiled as
`docs/curator-requests/2026-08-25-integration-hook-transition-scoping.md`, which carries
the current reproduction. Emission stays blocked; `EngineCapability.render` stays
`adopt_backlog`.**

**Type:** engine grammar ask (additive)
**Filed by:** pgas-new foundry, 2026-08-24
**Engine version confirmed against:** `@simodelne/pgas-server@5.7.1` (observations below
are pre-6.0.0 and are retained as the historical record)
**Related:** pgas#992 (`capability: render` + engine-native ArtifactStore), pgas#1045
(`RenderSectionList`, **shipped in 5.7.1** — see
`docs/curator-requests/2026-08-23-render-section-list-primitive.md`)
**Evidence:** `tests/integration/render-section-list-falsifier.test.ts` — `G-1`

## Summary

pgas#1045 closed the **grammar** half of the 0-TS docx migration: a top-level
`RenderSectionList` now expresses the foundry's per-approved-item deliverable class
declaratively (proven hermetically end-to-end — `S-1`/`K-1`/`K-2` in the falsifier
above). The migration is now blocked on a **second, narrower gap**: there is no way
for an **author-less** stage to dispatch a `capability: render` artifact selector.

Concretely: a generated program's export stage is a `decision_only` mode. That is a
deliberate, load-bearing foundry property (pgas-new #253,
`tests/integration/export-decision-only-autoadvance-falsifier.test.ts` asserts the
author is **never** called for the export stage) — rendering a deliverable is a
deterministic formatting step, not an LLM decision, so it must not consume an LLM
round or inherit an LLM failure mode.

A `decision_only` mode may declare no vocabulary and no channels, so it can emit no
`EffectAction`. Its only outbound seam is an `OnTransition` **integration hook** — and
a hook's payload is engine-built and not declarable.

## Observation (reproduced, not inferred)

`G-1` in `tests/integration/render-section-list-falsifier.test.ts` declares exactly the
foundry's shape: a `decision_only` export mode plus

```yaml
integrations:
  render_hooks:
    channel: render_out           # Out + Sync, capability: render
    hooks:
      - action: render_document
        event: OnTransition
        result_path: export
```

Observed on 5.7.1:

```
capability.render.error  RenderProvider: request.format must be "docx"
artifacts written: 0
session status: Failed
```

The capability binding **does** route the hook to the render capability handler — that
part works. The failure is purely the payload shape:

- `plugin.mjs` `dispatchHook` builds the envelope as
  `adapter.dispatch({ action: hook.action, event: hook.event, domain })`.
- `createServerOutputAdapter.dispatch` passes the WHOLE envelope as the handler's inner
  payload for a non-`EffectAction` (`const innerPayload = isEffect ? envelope.payload : envelope`).
- `renderCapability` fires the declarative projection only when
  `Reflect.ownKeys(payload)` includes `artifact_id` **and every key** is in
  `{ artifact_id, sessionId, userId, domain }`. `action` and `event` are not, so
  `exactSelector` is false, `buildProviderRenderRequest` never runs, and the raw hook
  envelope is handed to the consumer `RenderProvider`, which correctly refuses it.
- `unwrapOpaqueRequest` does not help: it only unwraps a nested `payload` key, and the
  hook envelope has none.

`IntegrationHook` (`_shared-types.d.ts`) is
`{ action, event, path?, result_path?, execution?, timeout_ms?, progress_channel? }` —
there is no `payload`.

## Why there is no consumer-side route

Every alternative is either a stopgap or a regression, so we took none of them:

1. **Make the export stage a normal LLM mode with a `render_document` action.** Works
   today (that is `S-1`), but it reintroduces an author round for a deterministic
   formatting step and would require loosening
   `export-decision-only-autoadvance-falsifier.test.ts`, which asserts the author is
   never called. Loosening a falsifier to make a migration land is exactly the drift
   this repo forbids.
2. **Have the consumer channel adapter reshape the hook envelope into `{artifact_id}`.**
   That is program logic in consumer code, on the render path — the stopgap the layer
   contract forbids.
3. **Call the engine's render projection from a consumer stage body.** Not possible:
   `buildProviderRenderRequest` / `buildArtifactIR` / the render backends are not on the
   sealed public surface (`plugin.d.ts` exports only the `RenderProvider` and
   `DeclarativeRenderRequest` **types**).
4. **`artifact_bundle` / `artifactPolicy` / reactions / `composite:`.** None of these
   dispatch an engine capability; `artifactPolicy` only harvests bytes a consumer already
   put into domain state — the base64-in-domain seam #992 exists to retire.

## Ask

Let an author-less declarative dispatch supply the capability's payload. The minimal
additive form, mirroring the existing `result_path` field:

```ts
export interface IntegrationHook {
  action: ActionName;
  event: HookEvent;
  path?: Path;
  result_path?: Path;
  /** NEW: a declared, static payload for the dispatched action. */
  payload?: Value;
  execution?: "inline" | "async_process";
  timeout_ms?: number;
  progress_channel?: string;
}
```

with `dispatchHook` dispatching `{ ...hook.payload, action, event, domain }` (or
`{ payload: hook.payload, action, event, domain }`, which `unwrapOpaqueRequest` already
unwraps) so the render capability's exact-selector test sees `{ artifact_id }`.

This is deliberately **generic**, not render-specific: the same shape lets a
`decision_only` stage drive any engine capability (`web_search`,
`document_extraction`, `audio_transcription`) without an LLM round. It is a static,
spec-authored constant — it cannot fabricate content (the never-fabricate rule still
binds every visible value to a `{ from: path }` inside `render:`).

An equivalent alternative we would be equally happy with: a `render:`-tier
`on_transition:` binding (`{ mode, artifact_id, result_path }`) that the engine fires
during the decision-only drain.

## Falsifier for pgas-new adoption

> **RESOLVED (2026-08-25).** `G-1` did flip on 6.0.0 and has been honestly INVERTED into
> `P-1`, a positive assertion that the static-payload dispatch works. The four steps
> below are unchanged as the adoption plan, but they are now gated on the residual
> scope ask (`2026-08-25-integration-hook-transition-scoping.md`), pinned by `G-2`.

`G-1` in `tests/integration/render-section-list-falsifier.test.ts` asserted the FAILURE
above. When this ask ships, `G-1` FAILS — which is the trigger to:

1. emit `render:` + `capability: render` + the hook payload from
   `src/foundry-program/synthesizer.ts`;
2. delete `renderDocxExportStageBody` / `renderHtmlExportStageBody` /
   `exportSectionHelpers` (`sectionsFromDomain`, `sectionForDomainValue`,
   `approvedContentSectionsFromDomain`) from
   `src/foundry-program/domain-synthesis.ts`;
3. re-point `assessExportEngagement` at the engine-native ArtifactStore instead of the
   base64-in-domain + `artifactPolicy` seam;
4. flip `EngineCapability.render` in `src/foundry-program/engine-primitive-registry.ts`
   from `adopt_backlog` to `emitted`.

## What this blocker is currently costing us

The still-emitted `exportSectionHelpers` shape-mapping TS carries two governance
defects that the declarative `render:` path removes for free (proven by `K-2`):

- **fabrication:** `sectionsFromDomain` falls back to a synthesized section
  `{ body: 'No accumulated domain state was available for export.' }` when nothing
  matches. A `RenderSectionList` over an empty collection renders **zero** sections.
- **consumer-side approval filtering:** `approvedContentSectionsFromDomain` re-derives
  "approved" in TS (`status === 'accepted' | 'approved'`). Declaratively the filter is
  the engine's own `derived_paths[items_where_field_eq]` bucket, upstream of render.

## Related interaction worth a look (not part of the ask)

`bindConventionCapabilityDependencies` resolves the convention capability recipe from a
WeakMap keyed by **entry identity**. Any consumer that rebuilds the entry object
(`{ ...loadProgramByConvention(...).entry, spec }`) silently loses its capability
bindings and fails at session-create with *"render capability declared but no
RenderProvider registered"* — observed while writing `G-1`.

pgas-new has to do exactly that spread today, because the spec compiler **forbids** a
prompt on a `decision_only` mode
(`checkDecisionOnlyModes`: *"must not declare a prompt"*) while the program registry
**requires** a prompt for every mode (`assertDeclarativePrompts`). The foundry works
around it with `withDecisionOnlyRegistryPrompts`
(`src/pgas-new/template-renderer.ts`, `src/pgas-new/generated-live-drive.ts`,
`src/foundry-program/synthesizer.ts`). Reconciling those two checks would remove the
shim and the identity hazard together.
