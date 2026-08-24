# v5.7.0 behaviour change: parent's recorded delegation request is no longer retro-enriched

**Type:** confirmation request — **RESOLVED / CONFIRMED INTENDED** by the engine curator 2026-08-24
**Filed by:** pgas-new foundry, 2026-08-24
**Engine versions:** 5.6.0 (old behaviour) → 5.7.0 / 5.7.1 (new behaviour)
**Related:** pgas#1044 (copy-on-write `setNestedPath`)

## Summary

pgas#1044's copy-on-write fix removed an **accidental aliasing side effect** that pgas-new's
`delegation-slice-runtime-falsifier` had been asserting on. The engine's functional behaviour is
intact and, in our reading, now *more* correct. We have re-pinned the test to the new semantics and
are recording it here so the change is on the record and you can correct us if it was unintended.

## Evidence

Version bisect of the unchanged foundry test
`tests/integration/delegation-slice-runtime-falsifier.test.ts`:

| engine | result | `parentRequestTopic` | `seededTopic` (child round-0 projection) |
|---|---|---|---|
| 5.6.0 | PASS | `PGAS770_DOC1_SENTINEL …` (enriched) | `PGAS770_DOC1_SENTINEL …` |
| 5.7.0 | FAIL | — | — |
| 5.7.1 | FAIL | `raw-doc1-slug` (author-declared) | `PGAS770_DOC1_SENTINEL …` |

`enrichInput` is **byte-identical** across 5.6.0 and 5.7.1 (`dist-bundle/plugin.mjs`); the sole delta
is inside `setNestedPath`:

```js
// 5.6.0 — mutates the shared nested object in place
if (!isRecord2(current[seg])) { current[seg] = {}; }
current = current[seg];

// 5.7.1 — copy-on-write per segment (#1044)
const existing = current[seg];
const next = isRecord2(existing) ? { ...existing } : {};
current[seg] = next;
current = next;
```

## Mechanism

`enrichInput` shallow-copies the root (`const enriched = { ...input }`), so pre-5.7.0
`enriched.request === input.request`. `setNestedPath(enriched, 'request.topic', value)` therefore
mutated the **author's own payload object** in place. pgas-new's generated programs commit that same
object to parent domain state at dispatch time via `MSet <base>.request` with `from_arg: 'request'`,
so an **already-committed domain value was retroactively rewritten** by a later engine-side overlay.

Under COW the overlay is confined to the copy the dispatch path actually sends
(`buildDelegationEvent(child, enrichedInput, …)`), so:

- the **child** still receives the enriched request (verified: `seededTopic` is the enriched sentinel);
- the **parent's committed record** now holds the author-declared payload and is not retro-mutated.

## Our reading

(b) is the correct semantic: committed domain state should not mutate behind the program's back, and
that is exactly the defect class #1044 addressed. No foundry feature depended on the parent record
being enriched (`assessDelegationEngagement` does not read it).

## Curator ruling (2026-08-24) — CONFIRMED INTENDED

> Confirmed: this is the intended #1044 contract. `inputEnrichment` owns a **detached CHILD
> dispatch/seed payload**: it overlays parent-world values onto a copy and must never mutate the
> author argument or write back into parent World. The exact engine regression test pins this: the
> child gets `request.topic='Parent Topic'`, while the original frozen request remains
> `{topic:'Author Topic', retained:'yes'}` and frozen. Your re-pinned two-sided assertion is correct;
> keep the falsifier unquarantined. If parent state must mirror the enriched child request, that
> requires an explicit authored/settlement mutation, never an aliasing side effect. This is an
> intentional v5.7 behavior correction, not a defect.

**Consequence for the foundry:** our re-pinned two-sided assertion stands. If a generated program
ever needs the parent to mirror the enriched child request, it must do so through an explicit
authored mutation — never by relying on the overlay.

## What we asked (answered above)

1. Is the new parent-record semantic **intended**? We have pinned it as such.
2. If instead the parent's record is meant to reflect the *dispatched* (enriched) payload, this is an
   observability regression in 5.7.0 and we will re-quarantine and await a fix rather than keep the
   new expectation.

No action needed if (1). We did not change engine behaviour or add any consumer-side workaround.
