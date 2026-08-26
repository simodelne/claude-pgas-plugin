# RESOLVED WITHOUT NEW GRAMMAR — scoping an author-less capability dispatch to exactly-once

> **STATUS: CLOSED (simodelne/pgas#1086), 2026-08-26. No engine change shipped or needed.**
>
> This began as an additive grammar ask for `IntegrationHook.mode` / `when`. The owner
> directive is that grammar is added only after proving the behaviour cannot be expressed
> with what already ships. That audit was run, and it **found an existing route**, so the
> ask was withdrawn and the issue closed. The gap observations below (`G-2`/`G-2a`/`G-2b`)
> were all real and all reproduce — they were just not exhaustive.
>
> **The resolution.** `AfterMutation` is the only hook event the engine scopes
> (`runAfterMutationHooks` matches `instructionSet.mutations` against `hook.path`). The
> generated program **already owned** `<export>.render_pending`. So: move that
> `MSet <export>.render_pending = true` onto the one-shot loop-exit action, bind the
> capability hook `AfterMutation` to that exact path, and delete both the `OnTransition`
> reaction and the consumer-side dispatch filter.
>
> **Measured on the real synthesized confirmation-loop artifact** (not the hermetic
> fixture), with the generated export adapter wrapped to count dispatches — the engine
> does not log hook fires, and a second dispatch would silently overwrite the same
> `result_path`, so cardinality was otherwise unobservable:
>
> | | result |
> |---|---|
> | dispatches | **1** |
> | DOCX | complete (`section_count: 3`, bytes > 0) |
> | session | reaches `complete`, no export-stage author round |
> | consumer dispatch logic | **none** (filter + reaction deleted) |
>
> **Kill-proof:** reverting *only* the hook event back to `OnTransition` on that same
> artifact yields **4 dispatches** — so `G-2` reproduces on the real class, and `1` is a
> measurement rather than a constant.
>
> Net effect: strictly less code than the grammar ask would have produced. The engine is
> unchanged, one declarative mutation replaces a reaction *and* a consumer gate, and the
> approval aggregate stays engine-derived. Evidence lives in
> `tests/integration/export-decision-only-autoadvance-falsifier.test.ts` (`E-3` + the
> exactly-once assertion in the live drive) and
> `tests/integration/render-section-list-falsifier.test.ts` (`E-1`, `E-2`, `G-2`, `G-2a`,
> `G-2b`).
>
> The historical ask is preserved below unedited, because the gap observations remain the
> reason the render migration was blocked for three engine versions.

---

**Type:** engine grammar ask (additive) — WITHDRAWN
**Filed by:** pgas-new foundry, 2026-08-25
**Engine version reproduced against:** `@simodelne/pgas-server@6.0.0`
**Predecessor:** `docs/curator-requests/2026-08-24-declarative-render-dispatch-author-less-stage.md`
(**HALF-SHIPPED** — see below)
**Related:** pgas#992 (`capability: render` + engine-native ArtifactStore), pgas#1045
(`RenderSectionList`, shipped 5.7.1), pgas#1054 (`IntegrationHook.payload`, shipped 6.0.0)
**Evidence:** `tests/integration/render-section-list-falsifier.test.ts` — `P-1`, `G-2`, `G-2a`, `G-2b`

## What already shipped (thank you) — and what it unblocked

pgas#1054 added `IntegrationHook.payload` (`_shared-types.d.ts:236-246`,
*"Static, bounded JSON object dispatched instead of the internal hook envelope"*)
and the adapter forwards ONLY that payload for a non-`EffectAction` that owns one:

```js
// dist-bundle/create-server.mjs:31156-31157
const hasStaticHookPayload = !isEffect && Object.hasOwn(envelope, "payload");
const innerPayload = isEffect || hasStaticHookPayload ? envelope.payload : envelope;
```

That closes the **selector** half of the 2026-08-24 ask. **Reproduced, not inferred**
(`P-1`): an AUTHOR-LESS `decision_only` stage on a `capability: render` channel, with
no `EffectAction` anywhere in the program, now mints a first-class
`artifactType:"render"` docx whose bytes carry the approved item's authored prose.
Removing just the `payload:` line flips it straight back to the pre-6.0.0 failure
(`RenderProvider: request.format must be "docx"`, 0 artifacts, session Failed).

## The remaining gap: a hook can declare WHAT to dispatch, but not WHEN

`IntegrationHook` is `{ action, event, path?, result_path?, payload?, execution?,
timeout_ms?, progress_channel? }`. There is no mode, target-mode, or predicate scope,
and `runOnTransitionHooks` batches **every** declared `OnTransition` hook on **every**
mode change:

```js
// dist-bundle/create-server.mjs:7633-7645
async function runOnTransitionHooks(spec, world, options) {
  for (const lib of spec.integrations) {
    for (const hook of lib.hooks) {
      if (hook.event !== "OnTransition") continue;
      hookBatch.push({ hook, channel: lib.channel });   // no mode / predicate filter
    }
  }
  await runHookBatch(hookBatch, world, spec, options);
}
```

`renderCapability` mints a **fresh** `ArtifactRef` per dispatch (`artifactStore.put` →
`metadataStore.saveArtifact` with a new `artifactId`); there is no per-`artifact_id`
idempotency. So an unscoped hook does not "re-render the deliverable" — it mints N
separate deliverables.

### Observed (`G-2`, hermetic, engine 6.0.0)

A 4-transition program (`bootstrap → gather → review → render_export(decision_only) →
complete`) with ONE declared render hook and the deliverable collection seeded only in
`gather`:

| | observed |
|---|---|
| mode transitions | 4 |
| artifacts minted | **4** |
| artifacts carrying the approved prose | 3 |
| artifacts that are content-**INCOMPLETE** | **1** (the `bootstrap → gather` hop, rendered before the collection existed) |

The extras are not harmless duplicates: the pre-export hops persist partial
deliverables as first-class `artifactType:"render"` records. On the foundry's real
per-approved-item class the export mode sits behind a per-item confirmation loop, so
the count scales with loop iterations — dozens of partial documents, and no declared
answer to "which one is THE deliverable".

### Both candidate `AfterMutation` scopings are dead too

- **`G-2a`** — `event: AfterMutation, path: <derived bucket>` → **0 dispatches.**
  `runAfterMutationHooks` matches only `instructionSet.mutations`, and derived-path
  writes are not instruction-set mutations. The completion guard the foundry's
  confirmation-loop class actually uses is exactly such a derived path
  (`derived_paths[all_items_field_eq]`), so it cannot drive a hook at all.
- **`G-2b`** — `event: AfterMutation, path: <collection items path>` → **one dispatch
  per `MAppend`.** A deliverable is not per-item.
- (`AfterMutation` also fires inside `execute()` **before** `dispatchTerminal` writes
  the round's `result_path`, so the last stage's own output is not yet in the world.)

## Why there is no consumer-side route

The foundry suppresses exactly these extra fires today with a consumer-side
`<stage>.render_pending` gate inside its generated `createExportHookAdapter`
(`src/foundry-program/synthesizer.ts` `renderExportHookAdapter`). On a
`capability: render` channel the **engine** owns the handler — there is no consumer
adapter between `dispatchHook` and `renderCapability` — so that gate cannot exist. And
re-introducing a dispatch filter on the render path would be consumer-side program
logic on a governed path, which the layer contract forbids (the same reason we did not
reshape the hook envelope in consumer code for the 2026-08-24 ask).

Making the export stage a normal LLM mode with a `render_document` `EffectAction` works
today (that is `S-1` in the same falsifier) but reintroduces an author round for a
deterministic formatting step and would require loosening
`tests/integration/export-decision-only-autoadvance-falsifier.test.ts`, which asserts
the author is never called for the export stage. Loosening a shipped falsifier to land
a migration is the drift this repo forbids.

## Ask

Let a hook declare its scope. The minimal additive form, mirroring the existing
optional fields:

```ts
export interface IntegrationHook {
  action: ActionName;
  event: HookEvent;
  path?: Path;
  result_path?: Path;
  payload?: Readonly<Record<string, Value>>;
  /** NEW: for OnTransition, fire only when the transition's TARGET mode is this. */
  mode?: ModeName;
  /** NEW (alternative or complement): fire only when this predicate holds. */
  when?: RawPredicate;
  execution?: "inline" | "async_process";
  timeout_ms?: number;
  progress_channel?: string;
}
```

with `runOnTransitionHooks` receiving the target mode and skipping hooks whose declared
`mode` does not match, and `runHookBatch` skipping hooks whose `when` does not hold
against the current world.

Either field alone closes this. `mode` is the smaller, more obviously bounded change;
`when` is the more general one and reuses the existing `Predicate` grammar already used
by `derived_paths[].when`, `collection_finalizers[].when`, and DSM `transitions[].when`
— no new evaluation surface.

This is deliberately **generic**, not render-specific: it lets an author-less
`decision_only` stage drive any engine capability (`render`, `web_search`,
`document_extraction`, `audio_transcription`) **exactly once, at the declared point**,
with no LLM round and no consumer dispatch logic. It is a static, spec-authored
constant; it cannot fabricate content (the never-fabricate rule still binds every
visible value to a `{ from: path }` inside `render:`).

An equivalent alternative we would be equally happy with is the one already named in
the 2026-08-24 ask: a `render:`-tier `on_transition:` binding
(`{ mode, artifact_id, result_path }`) that the engine fires during the decision-only
drain.

## Falsifier for pgas-new adoption

`G-2` / `G-2a` / `G-2b` in `tests/integration/render-section-list-falsifier.test.ts`
currently assert the observations above. When this ask ships, `G-2` FAILS — which is
the trigger to:

1. emit `render:` + `capability: render` + the scoped hook from
   `src/foundry-program/synthesizer.ts`;
2. delete `renderDocxExportStageBody` / `renderHtmlExportStageBody` /
   `exportSectionHelpers` (`sectionsFromDomain`, `sectionForDomainValue`,
   `approvedContentSectionsFromDomain`) from
   `src/foundry-program/domain-synthesis.ts`;
3. re-point `assessExportEngagement` at the engine-native ArtifactStore instead of the
   base64-in-domain + `artifactPolicy` seam;
4. flip `EngineCapability.render` in `src/foundry-program/engine-primitive-registry.ts`
   from `adopt_backlog` to `emitted`.

## What this blocker is still costing us

Unchanged from the 2026-08-24 ask, and worth restating because it is the whole argument
for the declarative path. The still-emitted `exportSectionHelpers` shape-mapping TS
carries two governance defects that a declarative `render:` deletes for free (proven by
`K-2` and by the `derived_paths` bucket `S-1`/`K-1` read):

- **fabrication** (`src/foundry-program/domain-synthesis.ts:3966`): `sectionsFromDomain`
  falls back to a synthesized section
  `{ body: 'No accumulated domain state was available for export.' }` when nothing
  matches. A `RenderSectionList` over an empty collection renders **zero** sections —
  `K-2` observes exactly that, and observes the fabricating variant failing under
  sabotage.
- **consumer-side approval re-derivation**
  (`src/foundry-program/domain-synthesis.ts:4001`): `approvedContentSectionsFromDomain`
  re-derives "approved" in TS (`status !== 'accepted' && status !== 'approved'`).
  Declaratively that filter is the engine's own `derived_paths[items_where_field_eq]`
  bucket, upstream of render — consumer code VALIDATES, never DECIDES.

## Second-order note — RESOLVED by pgas#1055, correcting an earlier draft

An earlier draft of this note claimed the `bindConventionCapabilityDependencies`
entry-identity hazard was still forced on us. **That is now FALSE on 6.0.0.** pgas#1055
shipped, and `assertDeclarativePrompts` in the 6.0.0 bundle reads:

```js
for (const [modeName, mode] of entry.spec.modes) {
  if (mode.decisionOnly === true)
    continue;
  ...
}
```

So the registry no longer requires a prompt for a `decision_only` mode, the compiler's
`checkDecisionOnlyModes` no longer contradicts it, and the `withDecisionOnlyRegistryPrompts`
shim — together with the entry-rebuild that silently dropped capability bindings — is no
longer necessary. Removing that shim is pgas-new's own follow-up cleanup, not an engine ask.
No action requested here; recorded so the record is accurate.
