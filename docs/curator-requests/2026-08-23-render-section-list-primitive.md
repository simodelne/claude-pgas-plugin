# Render Grammar: Repeat-Node Over An Authored Collection

Status: confirmed against `@simodelne/pgas-server@5.6.0`.

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

Cross-linked from the `EngineCapability.render` awareness entry in
`src/foundry-program/engine-primitive-registry.ts` and the
`capability: render` row in `docs/ENGINE-DECLARATION-CATALOG.md`.
