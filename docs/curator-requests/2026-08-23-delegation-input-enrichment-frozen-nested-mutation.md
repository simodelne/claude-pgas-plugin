# Delegation `inputEnrichment` Mutates A Frozen Nested Payload Object

Status: RESOLVED — SHIPPED in `@simodelne/pgas-server@5.7.0` (simodelne/pgas#1044 CLOSED completed 2026-08-24; closing comment: "Shipped and registry-verified in v5.7.0: delegation input enrichment is copy-on-write across frozen nested author payloads", tag `fcbeb1eb`). Recorded 2026-09-05.
Resolution: `enrichInput`/`setNestedPath` no longer mutate the frozen nested payload; the sibling record `2026-08-24-delegation-request-record-no-longer-retro-enriched.md` documents the behavioral consequence.

Originally observed against `@simodelne/pgas-server@5.6.0`. Filed as
[`simodelne/pgas#1044`](https://github.com/simodelne/pgas/issues/1044) (write-side
sibling of the v5.6.0 `readMapPath()` copy-on-write task).

## Observation

An ad-hoc / worker delegation whose author supplies a `request` object **and**
whose `delegationPolicy.inputEnrichment` targets a field *under* that object
(e.g. `request.topic`) crashes on dispatch:

```
Cannot assign to read only property 'topic' of object '[object Object]'
```

Reproduces deterministically via `tests/integration/hub-tools-falsifier.test.ts`
(`routes registered web_search and hub-triggered delegation results back into
hub-visible state`): the scripted author calls `research` with
`{ request: { topic: CHILD_SENTINEL } }` while the child's `payload_map` declares
`{'request.topic': 'inputs.initial_user_text'}` → the foundry emits
`inputEnrichment: [{ source: 'inputs.initial_user_text', target: 'request.topic' }]`.

## Root cause (engine, not foundry)

There are two delegation-enrichment code paths in
`node_modules/@simodelne/pgas-server/dist-bundle/plugin.mjs`, and they disagree:

- **Fan-out / seed path — CORRECT (copy-on-write).**
  `buildEnrichedDelegationPayloadObject` (`:26761`) → `setNestedPathValue`
  (`:26747`) rebuilds every intermediate segment with `next = { ...existing }`
  before writing, so it never mutates a pre-existing nested object in place. The
  lead-research fan-out delegation (`payload_map: {'request.source': ...}`) is
  unaffected.

- **Ad-hoc/worker input path — BUGGY (in-place mutation).**
  `enrichInput` (`:15857`, called at `:15980` with `input = effect.payload ?? {}`)
  → `setNestedPath` (`:5560`):

  ```js
  let current = obj;                 // obj = { ...effect.payload }  (shallow)
  for (const seg of segments.slice(0, -1)) {
    if (!isRecord2(current[seg])) current[seg] = {};   // only creates when ABSENT
    current = current[seg];                            // else descends into the
  }                                                    // EXISTING (frozen) object
  current[last] = value;             // ← throws when current is frozen
  ```

  When `effect.payload.request` already exists (the author provided it) it is a
  frozen object under v5.6.0 world-write immutability. `setNestedPath` descends
  into that frozen `request` and assigns `.topic` in place → `TypeError`.

Empirically confirmed: driving the same delegation with an **empty** payload
(`toolCall('research', {})`) makes `enriched.request` absent, so `setNestedPath`
creates a fresh object and the enrichment succeeds. Any author-provided nested
object on an enriched path crashes.

## Ask

Make `setNestedPath` (the helper used by `enrichInput`) copy-on-write at each
intermediate segment, exactly like the sibling `setNestedPathValue` already does:

```js
for (let i = 0; i < segments.length - 1; i++) {
  const seg = segments[i];
  const existing = isRecord2(current[seg]) ? current[seg] : undefined;
  current[seg] = existing ? { ...existing } : {};     // clone, never descend-in-place
  current = current[seg];
}
current[segments[last]] = value;
```

This unifies the two enrichment paths on the (already-correct) copy-on-write
semantics and lets a worker/ad-hoc delegation accept an author-provided `request`
object while `inputEnrichment` overlays selected parent-state fields onto it —
the intended v5.3.1 `DelegationInputEnrichment` behavior (`pgas#986`).

## Impact until fixed

Generated conversational-hub programs with ad-hoc worker delegations whose
`payload_map` forwards parent state into `request.*` (or any nested author-owned
object) crash at delegation dispatch on v5.6.0. This is distinct from the
v5.6.0 keyed-`record_array` loader alignment (this PR's main change); it is not
fixable in `pgas-new` without patching engine internals, so it is filed here per
the engine-boundary rule rather than worked around in generated code.
