# Render Grammar: Repeat-Node Over An Authored Collection

**Status: RESOLVED — SHIPPED in `@simodelne/pgas-server@5.7.1`** (2026-08-24).
Filed as [`simodelne/pgas#1045`](https://github.com/simodelne/pgas/issues/1045);
the engine shipped `RenderSectionList` exactly as asked.

## Resolution (2026-08-24, verified against 5.7.1)

The shipped grammar matches the ask:

```ts
interface RenderSectionList { kind: "section_list"; from: RenderValueRef; template: RenderSection }
type RenderNode = RenderSection | RenderSectionList | RenderClause | RenderTable | RenderSchedule | RenderParagraph
RenderArtifact.sections: readonly (RenderSection | RenderSectionList)[]
```

with the anti-fabrication semantics we asked for, all three verified hermetically in
`tests/integration/render-section-list-falsifier.test.ts` on engine 5.7.1:

- **S-1** — a program-owned approved collection (the engine's own
  `derived_paths[items_where_field_eq]` bucket) drives a top-level `section_list`
  through `buildProviderRenderRequest` → the generic consumer `RenderProvider` →
  engine `ArtifactStore`, producing ONE docx section per approved item with that
  item's authored heading + prose verbatim, and the non-approved item ABSENT. Zero
  shape-mapping TS.
- **K-1 (kill, observed)** — rebinding `from` to another world path makes the
  approved prose vanish from `word/document.xml`. Sabotage run confirmed the
  assertion kills.
- **K-2 (kill, observed)** — an empty approved bucket renders ZERO sections and
  fabricates no placeholder. Sabotage run (a fabricated extra section) confirmed the
  assertion kills.

Engine constraints found while adopting it (all respected by the falsifier):
a `section_list` must be declared at the TOP level of `artifact.sections` (a nested
one throws *"nested section_list is not representable in the generic provider
request"*); `from` must resolve to an authored array of objects; refs inside
`template` are item-relative.

**The emission migration did NOT unblock with this.** A second, narrower gap remained:
the foundry's export stage is an author-less `decision_only` mode, and there was no way
for such a stage to dispatch the `capability: render` `{artifact_id}` selector. Filed
separately as
`docs/curator-requests/2026-08-24-declarative-render-dispatch-author-less-stage.md`.

**Update (2026-08-25, engine 6.0.0):** that second gap is now HALF-closed — pgas#1054
shipped a static `IntegrationHook.payload`, and an author-less `decision_only` stage
DOES now mint a first-class `artifactType:"render"` docx (`G-1` was honestly inverted
into the positive `P-1`). Emission is still blocked, on a THIRD and narrower gap: a
hook can declare WHAT to dispatch but not WHEN, so an unscoped `OnTransition` hook
mints one artifact per transition (`G-2`). Filed as
`docs/curator-requests/2026-08-25-integration-hook-transition-scoping.md`. Until that
ships the foundry keeps emitting `renderDocxExportStageBody` /
`approvedContentSectionsFromDomain`, and `EngineCapability.render` stays
`adopt_backlog`.

**Update (2026-08-26, recorded 2026-09-05):** the "THIRD gap" above did NOT need an engine
change — simodelne/pgas#1086 was CLOSED (not-planned) after an exhaustive existing-grammar
audit found the route: bind the hook `AfterMutation` to the one-shot `<stage>.render_pending`
write (see `2026-08-25-integration-hook-transition-scoping.md`). No engine blocker remains;
the remaining work is foundry-side emission only, which is why `EngineCapability.render`
is still `adopt_backlog`. The 2026-08-25 paragraph above is superseded.

---

## Original request (2026-08-23, against 5.6.0)

Status at filing: confirmed against `@simodelne/pgas-server@5.6.0`. Filed as
[`simodelne/pgas#1045`](https://github.com/simodelne/pgas/issues/1045) (additive →
v5.7.0 bucket). Confirmed that session as the SINGLE blocker to the #992 0-TS docx
migration: the render *mechanism* is hermetically proven
(`tests/integration/render-capability-falsifier.test.ts`), but the foundry's docx
deliverable is the dynamic per-approved-item class, which the current grammar cannot
express — so the emission migration stays blocked until this repeat-node ships.

## Observation

The `render:` / `RenderProfile` grammar (`pgas#901`) is a closed node union:

```
RenderNode = RenderSection | RenderClause | RenderTable | RenderSchedule | RenderParagraph
```

Anchors in `node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts`:

- `RenderParagraph.text: RequiredValue` (a single `RenderValueRef = { from: path }`, `RenderValueRef` at `:5658`) — `:5675-5679`
- `RenderClause.body: RequiredValue`, `RenderClause.children?: readonly RenderClause[]` — `:5685-5693` (children is a **fixed authored array**, not a collection iterator)
- `RenderTable.columns: readonly RenderTableColumn[]`, `RenderTable.rows: RenderValueRef` — `:5712-5724`
- `RenderSchedule.blocks: readonly RenderNode[]` — `:5731-5737` (**fixed authored array**)
- `RenderSection.nodes: readonly RenderNode[]` — `:5743-5749` (**fixed authored array**)
- `RenderNode` union — `:5751`

The **only** node whose content iterates a runtime collection is `RenderTable.rows`
(`:5723`): a single path resolving to an authored array, which the renderer iterates
row-by-row into the table's fixed columns. Every other structural array
(`RenderSection.nodes`, `RenderClause.children`, `RenderSchedule.blocks`) is a
**statically authored** list — its length is fixed at spec-authoring time, not
derived from world state.

## Why this blocks the per-clause deliverable class

The DD-report / legal-opinion deliverable class produces **one multi-paragraph
prose section per approved collection item** — the foundry's
`approvedContentSectionsFromDomain` (`src/foundry-program/domain-synthesis.ts`)
emits N sections, one per approved item, where N is only known at runtime. There
is no render node that repeats a `RenderSection` (or `RenderClause`) template over
an authored collection. The nearest available shape is `RenderTable.rows`, but a
table flattens each item to a single row of fixed scalar columns — it **loses the
multi-paragraph / nested-clause structure** that this deliverable class requires.

Consequently, the variable-length authored-section list for the per-clause class
**cannot be expressed declaratively** in the current `render:` grammar. It is the
single remaining blocker to full `render:` adoption (and thus to migrating the
docx/html shape-mapping stage-body TS onto `capability: render` + engine-native
`ArtifactStore`) for that deliverable class.

## Ask

Add a **repeat-node over an authored collection** to the `RenderNode` union, e.g.:

```
RenderSectionList {
  kind: "section_list";
  from: RenderValueRef;      // a path resolving to an authored array of item objects
  template: RenderSection;   // instantiated once per element; item-relative RenderValueRefs
                             // resolve against the current element
}
```

Semantics to mirror the existing anti-fabrication contract:

- The renderer iterates the authored `from` array; it never materializes, infers,
  or scaffolds elements (identical to the `RenderTable.rows` guarantee at `:5716-5723`).
- `RenderValueRef`s inside `template` resolve **element-relative** so each instance
  reads the current item's authored fields.
- Empty `from` array → zero sections (no placeholder / no scaffold).

## Falsifier for pgas-new adoption

A generated per-clause program declares a `render:` profile whose deliverable body
is a single `RenderSectionList { from: <approved-items collection>, template: <section> }`,
drives to `complete` with M approved items, and the rendered docx/html contains
exactly M multi-paragraph sections — one per approved item, each carrying that
item's authored prose — with **no** consumer-emitted `approvedContentSectionsFromDomain`
stage-body TS. A run with zero approved items renders zero sections (no scaffold).

## Not a consumer stopgap

This is a genuine engine grammar gap. Flattening variable-length authored sections
into a `RenderTable`, or re-introducing a consumer TS section-materializer, would
both violate the layer contract (authoring = LLM; formatting = pure render; no
script-authored deliverable content). Until the repeat-node primitive exists, the
foundry keeps emitting the `approvedContentSectionsFromDomain` shape-mapping stage
body for this class, and `EngineCapability.render` (`#992`) stays **ADOPT-BACKLOG
(PARTIAL)** — the PDF-report `RenderProfile` is emitted but the per-clause class
cannot migrate to declarative `render:`.

> **Post-resolution note (2026-08-24, updated 2026-08-25):** the primitive shipped, and
> the falsifier above was built and is green — but the foundry still emits
> `approvedContentSectionsFromDomain`. The author-less DISPATCH gap
> (`docs/curator-requests/2026-08-24-declarative-render-dispatch-author-less-stage.md`)
> is now HALF-closed by pgas#1054 in 6.0.0; what blocks emission today is the residual
> hook-SCOPE gap
> (`docs/curator-requests/2026-08-25-integration-hook-transition-scoping.md`).
> `EngineCapability.render` therefore remains `adopt_backlog` for a DIFFERENT, narrower
> reason than the one described above.
> **Superseded 2026-08-26 (recorded 2026-09-05):** pgas#1086 CLOSED with no engine change —
> the scope gap is resolved with the existing `AfterMutation` hook event. Nothing upstream
> blocks emission any more.

Cross-linked from the `EngineCapability.render` awareness entry in
`src/foundry-program/engine-primitive-registry.ts` and the
`capability: render` row in `docs/ENGINE-DECLARATION-CATALOG.md`.
