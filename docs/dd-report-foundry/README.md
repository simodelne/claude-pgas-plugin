# DD-report-class foundry hardening — roadmap & evidence (2026-07)

This directory is the durable record of a foundry-hardening effort aimed at one question:
**can the `pgas-new` foundry synthesize a DD-report-class program — the class of program that
was hand-authored in SimoneOS because the foundry couldn't produce it?**

The work was driven empirically: build a reduced DD-report-class program *through the foundry*,
measure exactly where it fell short, fix each gap falsifier-first, and re-measure end-to-end.

## What was established

- The foundry now **synthesizes a complete, usable governed SimoneOS program — backend *and*
  frontend** — that graduates via a fully-specified, scratch-proven **curator-request** patch (the
  foundry never edits SimoneOS central files; a curator applies a small, mechanical, proven patch).
  Proven for the minimal `governed-memo-mini` target.
- The foundry **synthesizes a reduced DD-report-class program to `complete` + a clean DOCX,
  zero hand-patches** (confirmation-loop tail and export-redaction compose end-to-end).
- The **one remaining runtime gap for *trustworthy* per-document delegated DD is an engine
  limitation**, not a foundry one — filed upstream as **simodelne/pgas#770**.

## The documents

| File | What it is |
|---|---|
| [`foundry-gap-analysis.md`](foundry-gap-analysis.md) | The prioritized gap map (13 gaps, evidence-cited, foundry-vs-model separated) that scoped the whole effort. |
| [`governed-attach-design.md`](governed-attach-design.md) | Design + phased plan for governed SimoneOS attach (the curator-request boundary; the governed-artifact delta; phases P1–P7). |
| [`governed-frontend-design.md`](governed-frontend-design.md) | Design + phased plan for governed frontend synthesis (the closed-world widget catalog; projection→widget binding; phases F1–F5). |
| [`capstone-verdict.md`](capstone-verdict.md) | The end-to-end zero-patch capstone: reached `complete`+DOCX with 0 patches, and pinned the two runtime composition gaps the unit tests missed. |
| [`engine-gap-delegation-enrichment.md`](engine-gap-delegation-enrichment.md) | The data-driven diagnosis behind **pgas#770**: per-dispatch `inputEnrichment` isn't delivered into the child's round-0 request domain (`toDelegatedText` drops nested `request.*`). |

## Merged this effort (`pgas-new`, 11 PRs, all falsifier-locked + CI-green)

**Correctness track:** confirmation-loop tail re-arm (#231) · document-slice isolation (#232) ·
dynamic document fan-out (#233) · scale-safe projection (#234).

**Governed backend attach (Gap 1):** spec profile / stage→pattern translation (#235) · native
registration + curator patch-request (#236) · projection + colocated tests + backend acceptance (#237).

**Governed frontend (Gap 10):** frontend.spec + projection backing (#238) · Markdown renderer +
QC pairing bundle (#239) · honest `rich_frontend` registry flip (#240).

**Capstone-found runtime gaps:** export corpus-leak redaction (#241, fixed) · delegation slice
runtime delivery (engine-blocked → **pgas#770**).

## Open follow-ups (roadmap)

- **pgas#770** (engine): deliver per-dispatch `inputEnrichment` into the child round-0 request
  domain. When fixed, **re-run the Gap-6 capstone** to confirm per-document slice delivery
  end-to-end (the current DD is parent-drafted-from-corpus, not delegated-per-document).
- **P7** — DD-report-class scale-up (XL): eRoom, fan-out wiring, approval gates, DOCX frontend,
  nested program path, manifest extensions. Depends on P6/frontend + the engine fix above.
- Parallel-batch fan-out (currently sequential; possibly engine-bound); strict/continue delegation;
  a standing **composition-gate** (the recurring lesson: isolation-proven ≠ composition-proven).

> Point-in-time note: some documents reference paths under `.dd-report-exp/` — the gitignored
> scratch working directory used for the experiment (generated programs, live-drive logs, session
> logs). Those artifacts are not committed; the analysis/design/verdict content is what's durable.
