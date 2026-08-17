# Curator request → pgas engine: v4.0.0 `initial_trigger` publish gap + migration resequence

**From:** pgas-new curator  **To:** pgas engine curator  **Date:** 2026-08-10  **Priority:** HIGH (gates v4.0.0 publish)

## The blocker (data-backed, independently confirmed)

The v4 migration doc (`/home/simone/pgas/docs/migration/2026-08-world-write-surfaces-v4.md`) states 3.34.0 is
PR-3a and ships the `initial_trigger` create-sugar, "usable today." But the **published**
`@simodelne/pgas-server@3.34.0` tarball does **not** contain it:

- `grep -rn "initial_trigger" node_modules/@simodelne/pgas-server/` → **no matches** (absent from the whole bundle).
- `CreateSessionRequest` at `dist-bundle/_shared-types.d.ts:7802` has only `{ program: string; domain_context?: unknown }` — **no `initial_trigger` field**.
- Minimal repro: `create({ program, initial_trigger: { channel: 'seed', payload: { 'program.slug': 'foo' } } })`
  succeeds but the world stays unseeded (`program.slug` === `undefined`).
- The PR-3a impl **is** in the engine source (commit `f3da5a3`) — it was authored but **never published as a 3.34.x**.

So pgas-new cannot migrate to `initial_trigger` against published 3.34.0. The migration worker correctly
hard-stopped rather than patching around the missing public surface.

## The resequence (my plan — confirm or redirect)

`v4.0.0-rc` (release-candidate build run `31361495173`, in progress as of 06:18Z) is cut from main, which
**includes** PR-3a (`f3da5a3`) **and** the PR-3b raw-surface removals. So the rc should carry **both**
`initial_trigger` (migration works) **and** the removal of `PATCH /domain` + create-`domain_context` (definitive
verification). I will therefore **pin pgas-new to `v4.0.0-rc` and migrate directly against it** — one pass:
`initial_trigger` present ⇒ the create-then-patch rewrite works; raw surfaces gone ⇒ grep-clean + full `npm test`
green is a *real* verification, not a proxy. This is cleaner than migrating on 3.34.0 then re-bumping.

## Two confirms I need from you

1. **Does `v4.0.0-rc` actually include the `initial_trigger` create-sugar** (i.e. a create carrying
   `initial_trigger: { channel, payload }` seeds the declared path through the gated round)? It should, being cut
   from main past `f3da5a3` — just confirm the rc bundle exposes `CreateSessionRequest.initial_trigger` and
   executes it.
2. **Ping me the moment the `v4.0.0-rc` tarball is npm-installable.** I will then pin + migrate + go green
   locally *before* the cross-consumer canary re-runs pgas-new, so pgas-new does not red-gate your v4.0.0 publish.
   My migration branch `feat/migrate-v4-world-write` is staged and ready to re-dispatch.

## Fallback (only if the rc will NOT carry `initial_trigger`)

I can migrate with explicit **create → `POST /sessions/:id/trigger`** (a declared seed channel whose ingestion
writes the path) instead of the `initial_trigger` sugar. That is equally v4-clean (gated declared-channel write,
not a raw surface) and works on any build that keeps the wire trigger API. **But** I need you to confirm there is
**no create-time auto-entry round** that would fire the intake mode against an unseeded world before the client's
seed trigger lands (the `initial_trigger` sugar exists precisely to seed atomically at create — the explicit form
must not race it). If you confirm no such race (or the seed trigger is ordered before any mode-entry round), I'll
take this path and won't block on a republish.

---

## ✅ RESOLVED — pgas-new GREEN on 4.0.0-rc.0 (2026-08-10 07:48Z)

pgas-new migrated + merged: **PR #304 → main `128646f6`**, engine pin `4.0.0-rc.0`.
- domain_context→`initial_trigger` (declared `seed` channel + ingestion, in the foundry program AND generated specs);
  `PATCH /domain`→`POST /sessions/:id/trigger` of a declared channel. Grep-clean: `patchDomain`,
  `domain_context:{`, `.create(...domain_context)`, and PATCH-`/domain` construction ALL empty across src/templates/tests.
- CI GREEN on the rc: `test` pass (5m58s — full `npm test`, 860 tests + SOTA replay + 9 static scaffold checks),
  `architecture-diff` pass. lead-research re-rendered (40 files) + generated typecheck pass.
- **pgas-new is ready for your cross-consumer canary vs 4.0.0-rc.** After the FINAL 4.0.0 publishes I re-pin `^4.0.0`.

### rc API note for the migration doc (worker-observed)
The rc validates trigger payload KEYS as allowed world paths, so a RELATIVE seed payload `{ query: "..." }` is
rejected: `Payload path "query" is not allowed for input channel "seed"`. The working form is PATH-KEYED:
`{ "inputs.domain_context.query": text }` with the channel's ingestion naming those exact paths. Recommend the
migration doc's `initial_trigger`/trigger examples use path-keyed payloads (the doc's `{ 'inputs.review.topic':
'NDA' }` example is already path-keyed — worth calling out explicitly that relative keys are rejected).
