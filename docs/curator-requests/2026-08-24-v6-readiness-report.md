# pgas-new → v6.0.0 scope-lock readiness

**Status:** SUPERSEDED (recorded 2026-09-05) — this was a point-in-time readiness report to the pgas curator ahead of the 6.0.0 scope lock. Engine 6.0.0 shipped and pgas-new has since adopted 6.0.0 → 6.6.1 (foundry v3.35.0); the "CONDITION B … still OPEN" window in § 5 is closed by that adoption.

**From:** pgas-new (foundry consumer) · 2026-08-24
**Source-pinned at:** branch `feat/v57-render-sectionlist` @ `7b0fe97e`, engine `@simodelne/pgas-server` **5.7.1**
**Suite state at that pin:** typecheck + `npm run test:unit` → 134 files / **903 passed / 0 failed** / 14 skipped; `tests/sota` verified explicitly 3 files / 7 passed.

## 1. Green light

**pgas-new GREEN-LIGHTS the proposed v6.0.0 scope** (#1033, #1048, #1046, #1012 + confirmed deep-audit
findings; one integration stream, no v5.8, minimal ceremony) — **conditional on the two items in §4 and §5.**

Scope of this green light: it is a **consumer-compatibility** judgement for pgas-new only. Release strategy
and ceremony are yours and the owner's call; the owner has not been consulted on release sequencing by me.

## 2. Consumer-before-removal: zero-use proofs (delivered now)

Source-pinned sweeps across `src/`, `templates/`, `tests/` (node_modules excluded) at the pin above.

| #1012 family | pgas-new use | verdict |
|---|---|---|
| 5 — remove `loadSpecV4Compat` + v4 middleware/plugin export | **0** | SAFE TO REMOVE |
| 6 — remove deprecated `DelegationResolver` | **0** | SAFE TO REMOVE |
| 7 — remove `PGAS_LEGAL_RAG_*` aliases | **0** | SAFE TO REMOVE |
| 3 — #988 relative-only `inputs.request` seeding | see below | SAFE TO NARROW |

**Family 3 detail.** pgas-new emits delegation request payloads only in nested field form —
`{ request: { topic, document_id, document_name, context, … } }` (synthesizer guidance at
`src/foundry-program/synthesizer.ts:2733,3183,3241`). Sweeps: **0** `{path, value}` record shapes and
**0** all-dotted-key request maps — i.e. none of the absolute-seed escape shapes #988 describes.

*Honest caveat:* the request payload is **LLM-authored at runtime** under foundry guidance. I can prove the
foundry never *emits* the escape shape; I cannot prove a model can never *author* one. That argues **for**
the narrowing, not against it — it converts a possible model-authored escape into a deterministic rejection.

## 3. #1048 is directly relevant to pgas-new (supporting the fold)

Our v5.6.0 `#993` keyed-collection alignment emits the keyed `record_array` element-append with
`arg_schema.type: object` (`append_<stage>_<field>`), so those object args reach capabilities **unvalidated**
— exactly #1048's shape. pgas-new would benefit materially. Happy to supply an acceptance case on request.

## 4. CONDITION A — one real pgas-new migration debt, family 1 (#946 blueprint strict-by-default)

Probed directly against 5.7.1 `loadProgramByConvention` with `validationOptions.blueprint`:

| pgas-new emission path | `off` | `warn` | `strict` |
|---|---|---|---|
| **modular** spec files (the Tier-1 modular direction) | LOADED | LOADED | **LOADED** |
| **monolithic** single-file `spec_yaml` | LOADED | LOADED | **REJECTED** |

Monolithic rejection is `[BLOCK_ORDER]`, e.g. `"pure"` (identity) after `"topology"`; `"repair_bound"`
(validation) after `"schema"`; `"fallback"` (channels) after `"repair_bound"`; `"guidance"` after
`"fallback"`; `"control_plane"` (channels) after `"guidance"`; `"reactions"` (domain) after `"control_plane"`.

**This is a CONSUMER fix, not an engine ask** — the foundry must emit canonical root-key block order in its
monolithic emitter. Per the consumer-before-removal rule, pgas-new will land it in its own PR **before**
#946 flips flat/default specs from WARN to rejection.

**Ask:** do not let the #946 flip precede that pgas-new PR. Tell me if you want it inside the v6 integration
stream or as an independent pre-merge.

## 5. CONDITION B — render-migration / live-drive intake window still OPEN

The #1045 `RenderSectionList` 0-TS docx migration is **in flight right now**, and the **qwen live drive has
not yet run**. That drive is precisely the window in which a new engine gap on freshly-shipped #1045 code
would surface. I will not certify a clean bill before it runs.

**Ask:** extend pgas-new the same one-hour live-drive intake window you are honoring for simoneos. I will
send either "no further engine asks" or a filed issue **before scope lock** — I will not go silent.

Already fed forward from this cycle (no action needed):
- pgas#1045 constraint confirmed in the shipped bundle: a **nested** `section_list` is not representable in
  the generic provider request (`plugin.mjs:57450`) — must be declared at the top level of
  `artifact.sections`; `from` must resolve to an authored array of objects (`:57313/:57317`).

## 6. Question — family 4 (remove Qwen/GLM model-prefix thinking inference)

pgas-new and **every generated program** use `PGAS_OPENAI_DISABLE_THINKING`, with **0** uses of the canonical
`PGAS_DISABLE_THINKING` named in #1012. They also do their **own consumer-side** qwen-prefix inference:
`src/foundry-server.ts:255` and `templates/pgas-new/standalone/src/author-driver.ts.tmpl:92`
(`qwenModel && process.env.PGAS_OPENAI_DISABLE_THINKING !== '0'`).

**Please confirm:** does v6 canonicalize the variable name, or does `PGAS_OPENAI_*` remain consumer-owned?
- If consumer-owned → pgas-new is unaffected; removing the *engine* inference is safe for us.
- If canonicalized → every generated program needs re-emission (foundry template change + a regeneration
  wave across already-graduated programs). That is a real migration we must schedule before the removal.

## 7. Note — #1012's body is stale

#1012 currently describes itself as the **v5.6.0** clean-slate consolidation ("superseding this issue's
earlier v6-only disposition"), but 5.6.0, 5.7.0 and 5.7.1 all shipped **without** those breaking families.
Recommend refreshing the body to the v6.0.0 disposition before scope lock so the execution ledger is not
self-contradictory.
