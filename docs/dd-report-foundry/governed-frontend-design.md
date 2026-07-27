# Gap 10: Governed Frontend Synthesis Design + Phased Plan

Date: 2026-07-27

Scope: design only. This document maps the SimoneOS frontend contract and proposes an incremental plan for making the generated `governed-memo-mini` program user-facing. No foundry source changes are included here.

Classifier denial: not encountered.

## 1. Current Foundry State

Observed:

- The governed attach profile currently emits a backend-only SimoneOS program. The `simoneos-governed-attach` artifact plan includes `specs.yml`, `registration.ts`, `projection.ts`, colocated tests, and a curator request, but no frontend or frontend QC artifacts: `/home/simone/pgas-new/src/pgas-new/artifact-plan.ts:196` through `/home/simone/pgas-new/src/pgas-new/artifact-plan.ts:231`.
- The older generic existing-repo plan has root QC artifacts in its artifact list, including `qc/e2e-frontend/<slug>.scenario.yml`, `qc/facts/<slug>.facts.yml`, and `qc/e2e-coverage.yml`: `/home/simone/pgas-new/src/pgas-new/artifact-plan.ts:280` through `/home/simone/pgas-new/src/pgas-new/artifact-plan.ts:293`.
- Generic frontend emission is deliberately blocked. `existingRepoUserFacingArtifacts` emits only `projection.ts` and explicitly says not to emit `frontend.spec.yml` because generic UI trips SimoneOS's closed-world widget-catalog gate: `/home/simone/pgas-new/src/pgas-new/artifact-plan.ts:374` through `/home/simone/pgas-new/src/pgas-new/artifact-plan.ts:390`.
- The foundry capability registry marks `rich_frontend` as `refuses`, with evidence that only basic widget projection is emitted and no frontend spec is synthesized: `/home/simone/pgas-new/src/foundry-program/capability-registry.ts:97` through `/home/simone/pgas-new/src/foundry-program/capability-registry.ts:102`.
- The generated governed attach registration currently returns no `frontendSpecPath`; the generated spec-load test asserts that this remains true: `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:301` through `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:315`, and `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:498` through `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:504`.
- The current generated projection already emits `program_title`, `program_slug`, `mode`, `status_banner`, `phase_steps`, `workspace_checkpoints`, `workspace_metadata`, `memo_artifact`, and `workspace_artifact_items`: `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:365` through `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:375`, and `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:395` through `/home/simone/pgas-new/src/pgas-new/governed-attach-profile.ts:429`.

## 2. SimoneOS Frontend Contract Map

### 2.1 Closed-World Catalog

SimoneOS uses a closed widget and layout catalog. Every widget entry declares an id, bind contract, action contract, and component: `/home/simone/simoneos/frontend/src/catalog/contract.ts:1` through `/home/simone/simoneos/frontend/src/catalog/contract.ts:41`. `validateBinds` throws when required bind keys are missing or resolved values do not match scalar/object/array kind: `/home/simone/simoneos/frontend/src/catalog/contract.ts:48` through `/home/simone/simoneos/frontend/src/catalog/contract.ts:83`.

Available layouts, from `/home/simone/simoneos/frontend/src/catalog/layouts/index.ts:16` through `/home/simone/simoneos/frontend/src/catalog/layouts/index.ts:47`:

| Layout id | Slots |
| --- | --- |
| `single-panel` | `primary` |
| `split-panel` | `primary`, `secondary` |
| `tabbed` | `primary`, `secondary`, `side` |
| `progress-with-side` | `primary`, `secondary`, `context` |
| `workspace-3col` | `side`, `primary`, `secondary`, `focusMode` |

Unknown layouts are rejected by `getLayout`: `/home/simone/simoneos/frontend/src/catalog/layouts/index.ts:49` through `/home/simone/simoneos/frontend/src/catalog/layouts/index.ts:56`.

Available widget ids, from `/home/simone/simoneos/frontend/src/catalog/widgets/index.ts:91` through `/home/simone/simoneos/frontend/src/catalog/widgets/index.ts:110`:

| Widget id | Validator-required binds | Main practical shape |
| --- | --- | --- |
| `notice` | `message: string` | Optional `tone`, `elapsedSince`; action `dismiss`. |
| `confirmation` | none after #1046 | Practical prompt/detail/items/labels/canConfirm; actions `confirm`, `reject`, `secondary`. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/confirmation/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/confirmation/contract.ts:68`. |
| `chat-thread` | `messages: array` | Message objects `{id, role, author, content, timestamp}`; composer wired only when `channel_publish` action is present. Component shape at `/home/simone/simoneos/frontend/src/catalog/widgets/chat-thread/index.tsx:6` through `/home/simone/simoneos/frontend/src/catalog/widgets/chat-thread/index.tsx:31`. |
| `form` | `fields: array` | Field array plus labels/readiness; action `channel_publish`. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/form/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/form/contract.ts:23`. |
| `approval` | `prompt: string`, `items: array` | Bulk/per-item approve/reject. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/approval/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/approval/contract.ts:16`. |
| `selection` | `prompt: string`, `options: array` | Single/multiple selection. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/selection/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/selection/contract.ts:15`. |
| `file-upload` | none | Prompt/description/files/accept/multiple. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/file-upload/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/file-upload/contract.ts:24`. |
| `feedback` | `prompt: string` | Options/pending/submit label. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/feedback/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/feedback/contract.ts:12`. |
| `document-viewer` | `clauses: array` | Title/subtitle/language/view mode/selected clause. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/document-viewer/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/document-viewer/contract.ts:18`. |
| `progress-stepper` | `steps: array` | Steps `{id,label,description?,status}` where component expects status `done`, `current`, or `upcoming`: `/home/simone/simoneos/frontend/src/catalog/widgets/progress-stepper/index.tsx:4` through `/home/simone/simoneos/frontend/src/catalog/widgets/progress-stepper/index.tsx:15`. |
| `artifact-list` | none | Output cards/list; item ids drive download/copy. Component item shape at `/home/simone/simoneos/frontend/src/catalog/widgets/artifact-list/index.tsx:4` through `/home/simone/simoneos/frontend/src/catalog/widgets/artifact-list/index.tsx:19`. |
| `escalation-banner` | `question: string` | Agent escalation prompt. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/escalation-banner/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/escalation-banner/contract.ts:13`. |
| `delegation-event` | `childProgram: string`, `status: string` | Child-session status. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/delegation-event/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/delegation-event/contract.ts:17`. |
| `diff-view` | `tokens: array` | Token diff; optional summary/title. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/diff-view/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/diff-view/contract.ts:15`. |
| `focus-panel` | `focusObject: object` | Focus object must match the `FocusObject` shape: id/program/phase/kind/title/body/status/actions. Contract at `/home/simone/simoneos/frontend/src/catalog/widgets/focus-panel/contract.ts:3` through `/home/simone/simoneos/frontend/src/catalog/widgets/focus-panel/contract.ts:19`; type enum at `/home/simone/simoneos/frontend/src/types/focus-object.ts:1` through `/home/simone/simoneos/frontend/src/types/focus-object.ts:47`. |
| `workspace-sidebar` | none | Optional `phaseSteps`, `checkpoints`, `files`, save artifact options. Component shape at `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-sidebar/index.tsx:28` through `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-sidebar/index.tsx:65`. |
| `workspace-context` | none | Metadata, known tabs, session/domain/artifact/stats/history/research drawers. Component shape at `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-context/index.tsx:14` through `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-context/index.tsx:118`. |
| `completion-celebration` | none | Primary complete surface; optional title/summary/metadata/artifacts/actions. Component shape at `/home/simone/simoneos/frontend/src/catalog/widgets/completion-celebration/index.tsx:5` through `/home/simone/simoneos/frontend/src/catalog/widgets/completion-celebration/index.tsx:38`. |

Gate behavior:

- Unknown widget ids are rejected by `getWidget`: `/home/simone/simoneos/frontend/src/catalog/widgets/index.ts:112` through `/home/simone/simoneos/frontend/src/catalog/widgets/index.ts:120`.
- `validateFrontendSpec` rejects missing `program`, missing/invalid `modes`, unknown layout ids, non-array slots, missing required widget binds, unknown bind keys, and non-object bind blocks: `/home/simone/simoneos/frontend/src/runtime/spec-loader/validate.ts:10` through `/home/simone/simoneos/frontend/src/runtime/spec-loader/validate.ts:140`.
- The repo-wide frontend spec test expands every `programs/**/frontend.spec.yml`, validates the catalog contract, rejects unresolved YAML merge keys, requires a `complete` mode, requires active modes to use `workspace-3col` with `workspace-sidebar` first in `side` and `workspace-context` first in `secondary`, and requires complete mode to use `completion-celebration` plus a secondary `artifact-list` with `variant: literal:list` and a download action: `/home/simone/simoneos/frontend/src/runtime/__tests__/all-program-specs.test.ts:78` through `/home/simone/simoneos/frontend/src/runtime/__tests__/all-program-specs.test.ts:176`.

Important naming detail: the "completion" surface in the prompt is the catalog id `completion-celebration`, not `completion`.

### 2.2 `frontend.spec.yml` Shape

The frontend spec type allows:

- Top-level `program`, optional `display`, `modes`, and optional `global`: `/home/simone/simoneos/frontend/src/runtime/spec-loader/types.ts:46` through `/home/simone/simoneos/frontend/src/runtime/spec-loader/types.ts:58`.
- Each mode has a `layout`, optional `focus.enabled`, and arrays for `primary`, `secondary`, `context`, and `side`: `/home/simone/simoneos/frontend/src/runtime/spec-loader/types.ts:35` through `/home/simone/simoneos/frontend/src/runtime/spec-loader/types.ts:44`.
- Each widget binding is `{ widget, bind, actions }`; action triggers include `channel_publish`, `action`, `emit`, and upload/select-tab variants: `/home/simone/simoneos/frontend/src/runtime/spec-loader/types.ts:9` through `/home/simone/simoneos/frontend/src/runtime/spec-loader/types.ts:33`.

Binding paths are resolved by `BindResolver`:

- `schema.<path>` reads session domain state.
- `channels.<id>` reads the latest channel payload.
- `derived.<key>` reads the registered projection output.
- `$self.<name>` reads widget-local state passed through action dispatch.
- `literal:<value>` injects scalar literals.

See `/home/simone/simoneos/frontend/src/runtime/renderer/BindResolver.ts:1` through `/home/simone/simoneos/frontend/src/runtime/renderer/BindResolver.ts:20`, and `/home/simone/simoneos/frontend/src/runtime/renderer/BindResolver.ts:29` through `/home/simone/simoneos/frontend/src/runtime/renderer/BindResolver.ts:80`.

Example patterns:

- Due Diligence Report uses `workspace-3col` with a shared `workspace-sidebar` rail, `focus-panel`, `chat-thread`, and `workspace-context` drawer in intake and approval modes: `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:10` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:65`, and `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:174` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:221`. Its complete mode uses `completion-celebration` plus secondary `artifact-list`: `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:238` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:290`.
- Minutes Drafter uses the same workspace rails plus `file-upload`, `approval`, `document-viewer`, `confirmation`, and completion/download surfaces across modes: `/home/simone/simoneos/programs/minutes-drafter/frontend.spec.yml:8` through `/home/simone/simoneos/programs/minutes-drafter/frontend.spec.yml:432`.
- Legal Memo composes the `document-authoring` frontend pattern, parameterizing the drafting document viewer and complete-mode `completion-celebration`: `/home/simone/simoneos/programs/legal-memo/frontend.spec.yml:1` through `/home/simone/simoneos/programs/legal-memo/frontend.spec.yml:31`. The server expands frontend patterns before sending the spec to the SPA: `/home/simone/simoneos/server/src/spec-loader/compose-frontend-spec.ts:1` through `/home/simone/simoneos/server/src/spec-loader/compose-frontend-spec.ts:28`, and `/home/simone/simoneos/server/src/api/frontend-spec-expander.ts:1` through `/home/simone/simoneos/server/src/api/frontend-spec-expander.ts:24`.

### 2.3 Projection -> Widget Binding Contract

A user-facing program must register both a projection builder and a frontend spec path. Existing user-facing registrations do this with `projectionBuilder` and `frontendSpecPath`: Due Diligence Report at `/home/simone/simoneos/programs/simoneos/due-diligence-report/registration.ts:181` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/registration.ts:182`, Minutes Drafter at `/home/simone/simoneos/programs/minutes-drafter/registration.ts:58` through `/home/simone/simoneos/programs/minutes-drafter/registration.ts:59`, and Legal Memo at `/home/simone/simoneos/programs/legal-memo/registration.ts:71` through `/home/simone/simoneos/programs/legal-memo/registration.ts:72`.

The runtime hydrates `state.derived` from `/full` payloads: `/home/simone/simoneos/frontend/src/runtime/host/state.ts:100` through `/home/simone/simoneos/frontend/src/runtime/host/state.ts:129`. `ModeView` renders the current mode and only enters focus mode when the layout is `workspace-3col`, `focus.enabled` is true, `derived.focus_object` exists, and the primary slot contains `focus-panel`: `/home/simone/simoneos/frontend/src/runtime/renderer/ModeView.tsx:52` through `/home/simone/simoneos/frontend/src/runtime/renderer/ModeView.tsx:69`.

For the minimal governed memo surface, the projection must supply:

| Derived key | Needed by | Shape |
| --- | --- | --- |
| `phase_steps` | `workspace-sidebar.phaseSteps` and fallback progress | Array of `{id, label, status}`. Prefer widget status vocabulary `done/current/upcoming` because `workspace-sidebar` and `progress-stepper` use that vocabulary: `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-sidebar/index.tsx:28` through `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-sidebar/index.tsx:35`, `/home/simone/simoneos/frontend/src/catalog/widgets/progress-stepper/index.tsx:4` through `/home/simone/simoneos/frontend/src/catalog/widgets/progress-stepper/index.tsx:15`. Current generated projection uses `complete/current/pending`, which is a visual-contract mismatch. |
| `workspace_checkpoints` | `workspace-sidebar.checkpoints` | Array with at least `{label}`; current generated `{label, complete, status}` is render-safe because extra fields are ignored. |
| `workspace_metadata` | `workspace-context.metadata`; required by repo-wide active-mode test | Array `{label, value, tone?}`. Existing user-facing projections emit this, e.g. Due Diligence Report `/home/simone/simoneos/programs/simoneos/due-diligence-report/projection.ts:80` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/projection.ts:86`. |
| `workspace_context_tabs` | `workspace-context.tabs`; required by repo-wide active-mode test | Array of known tab ids or `{id,label}` using known ids `session`, `domain`, `artifacts`, `stats`, `debug`, `sources`, `history`. Unknown tab ids are dropped by `normalizeContextTabs`: `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-context/index.tsx:132` through `/home/simone/simoneos/frontend/src/catalog/widgets/workspace-context/index.tsx:162`. |
| `workspace_session_content` | `workspace-context.sessionContent` | Array `{label, value, meta?}`. |
| `workspace_domain_content` | `workspace-context.domainContent` | Array of key/value rows for domain drawer. |
| `workspace_artifact_items` | `workspace-context.artifactItems` | Array `{id, label, meta?}` for drawer inventory; this is not enough by itself for downloadable output cards. |
| `workspace_stat_items` | complete-mode metadata | Array `{label, value}`. Existing examples bind this into completion metadata. |
| `focus_object` | `focus-panel.focusObject` | Full `FocusObject`: `id`, `program`, `phase`, `kind`, `title`, `body`, `status`, `actions`; legal and minutes projections test this exact contract: `/home/simone/simoneos/programs/minutes-drafter/__tests__/projection.test.ts:60` through `/home/simone/simoneos/programs/minutes-drafter/__tests__/projection.test.ts:122`, and `/home/simone/simoneos/programs/legal-memo/__tests__/projection.test.ts:180` through `/home/simone/simoneos/programs/legal-memo/__tests__/projection.test.ts:189`. |
| `memo_sections` | optional complete-mode `workspace-context.artifactSections` | One shaped section for the memo body, e.g. `{id,title,text,status}`. |
| `final_artifacts` or `completion_artifacts` | `completion-celebration.artifacts` and `artifact-list.items` | Array of downloadable output descriptors. Use a stable renderer id such as `governed_memo_markdown`, not the LLM-selected `work.memo_artifact.id`. |
| `completion_title`, `completion_summary` | `completion-celebration.title` and `.summary` | Strings. |

Action dispatch has two important constraints:

- Chat composer actions should publish to a declared inbound channel, usually `user_messages`. Existing specs use `trigger: { type: channel_publish, channel: user_messages }` with `emit: send`: `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:40` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:47`.
- Download buttons should use `trigger: { type: action, name: download_session_artifact }` and `emit: download`; the widget supplies the artifact id to the client-side dispatcher. Existing complete modes do this at `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:262` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:264`, and `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:287` through `/home/simone/simoneos/programs/simoneos/due-diligence-report/frontend.spec.yml:290`.
- Do not emit approval controls unless the backend has a real approval path. `SessionView.invokeAction` special-cases action names starting with `approve_` into `user_confirmation`; all other names go to `__action:<name>`: `/home/simone/simoneos/frontend/src/pages/SessionView.tsx:349` through `/home/simone/simoneos/frontend/src/pages/SessionView.tsx:363`, and `/home/simone/simoneos/frontend/src/pages/SessionView.tsx:477` through `/home/simone/simoneos/frontend/src/pages/SessionView.tsx:478`. The generated `draft_memo` mode currently does not declare `user_confirmation`, so the minimal focus panel should be read-only or chat-steer only.

### 2.4 Artifact Renderer Registration

Downloads are resolved client-side. `download_session_artifact` calls `useSessionState.downloadArtifact`, which calls `renderArtifact(domain, artifactId)` and then prepares a same-origin browser download: `/home/simone/simoneos/frontend/src/runtime/host/useSessionState.ts:481` through `/home/simone/simoneos/frontend/src/runtime/host/useSessionState.ts:513`.

`renderArtifact` first checks the program renderer registry and then falls back to older hard-coded markdown renderers: `/home/simone/simoneos/frontend/src/runtime/host/artifact-renderer.ts:147` through `/home/simone/simoneos/frontend/src/runtime/host/artifact-renderer.ts:185`. Program renderers are registered with `registerArtifactRenderer`, which requires a non-empty artifact id and stores a builder function: `/home/simone/simoneos/frontend/src/runtime/host/artifact-renderer.ts:187` through `/home/simone/simoneos/frontend/src/runtime/host/artifact-renderer.ts:223`.

Existing registration styles:

- Due Diligence Report registers bespoke `dd_report_docx` by mapping domain state into DOCX input: `/home/simone/simoneos/frontend/src/runtime/docx-authoring/register-due-diligence-report.ts:28` through `/home/simone/simoneos/frontend/src/runtime/docx-authoring/register-due-diligence-report.ts:77`. Its tests clear the registry, register the renderer, assert input shaping, and call `renderArtifact`: `/home/simone/simoneos/frontend/src/runtime/docx-authoring/__tests__/register-due-diligence-report.test.ts:15` through `/home/simone/simoneos/frontend/src/runtime/docx-authoring/__tests__/register-due-diligence-report.test.ts:72`.
- Legal Memo uses the parametric document-authoring shaper and registers DOCX, HTML, and Markdown ids: `/home/simone/simoneos/frontend/src/runtime/docx-authoring/register-legal-memo.ts:80` through `/home/simone/simoneos/frontend/src/runtime/docx-authoring/register-legal-memo.ts:98`.
- The shaper's markdown helper registers an artifact id and returns `text/markdown;charset=utf-8`: `/home/simone/simoneos/frontend/src/runtime/docx-authoring/shaper.ts:1182` through `/home/simone/simoneos/frontend/src/runtime/docx-authoring/shaper.ts:1200`.
- Renderer modules are bootstrapped by central side-effect imports in `frontend/src/main.tsx`: `/home/simone/simoneos/frontend/src/main.tsx:10` through `/home/simone/simoneos/frontend/src/main.tsx:35`.

For `governed-memo-mini`, the smallest artifact target is a bespoke Markdown renderer registered as `governed_memo_markdown`. It should read `work.memo_artifact.title` and `work.memo_artifact.body` from the domain map and return `{ filename, content, mimeType: 'text/markdown;charset=utf-8' }`. This is central frontend runtime work because it touches `frontend/src/runtime/docx-authoring/` and `frontend/src/main.tsx`, so the foundry should put it in the curator request rather than writing it directly.

### 2.5 QC Frontend Coupling

Once a program is user-facing, it must satisfy both runtime frontend wiring and QC pairing:

- Central backend registration: `server/src/registrations/index.ts` imports and registers every program: `/home/simone/simoneos/server/src/registrations/index.ts:1` through `/home/simone/simoneos/server/src/registrations/index.ts:84`.
- Central spec-load roster: `scripts/specs-loadcheck.ts` imports and instantiates every registered program: `/home/simone/simoneos/scripts/specs-loadcheck.ts:1` through `/home/simone/simoneos/scripts/specs-loadcheck.ts:80`.
- V2 frontend roster: `frontend/src/runtime/cutover/v2-programs.ts` is the single render-adjacent roster and must include every spec-driven program: `/home/simone/simoneos/frontend/src/runtime/cutover/v2-programs.ts:1` through `/home/simone/simoneos/frontend/src/runtime/cutover/v2-programs.ts:37`.
- Display name registry: `frontend/src/lib/programNames.ts` is the canonical map used by frontend surfaces: `/home/simone/simoneos/frontend/src/lib/programNames.ts:1` through `/home/simone/simoneos/frontend/src/lib/programNames.ts:49`.
- Coverage matrix: `qc/e2e-coverage.yml` lists user-facing programs and requires an e2e-frontend scenario plus facts: `/home/simone/simoneos/qc/e2e-coverage.yml:36` through `/home/simone/simoneos/qc/e2e-coverage.yml:54`.
- V2 scenario lint: any V2-roster program must have `qc/e2e-frontend/<program>.scenario.yml`, unless exempted: `/home/simone/simoneos/qc/lint-e2e-frontend.ts:1` through `/home/simone/simoneos/qc/lint-e2e-frontend.ts:15`, and `/home/simone/simoneos/qc/lint-e2e-frontend.ts:101` through `/home/simone/simoneos/qc/lint-e2e-frontend.ts:132`.
- Facts pairing lint: once `qc/facts/<program>.facts.yml` exists for a user-facing program, the e2e overlay must exist and must extend that exact facts file: `/home/simone/simoneos/qc/lint-archetype-frontend-pairing.ts:10` through `/home/simone/simoneos/qc/lint-archetype-frontend-pairing.ts:28`, and `/home/simone/simoneos/qc/lint-archetype-frontend-pairing.ts:119` through `/home/simone/simoneos/qc/lint-archetype-frontend-pairing.ts:200`.
- Coverage matrix lint rejects declared cells with missing scenario files, orphan scenario files, user-facing programs without an e2e block, and missing facts files: `/home/simone/simoneos/qc/lint-coverage-matrix.ts:1` through `/home/simone/simoneos/qc/lint-coverage-matrix.ts:33`, and `/home/simone/simoneos/qc/lint-coverage-matrix.ts:115` through `/home/simone/simoneos/qc/lint-coverage-matrix.ts:157`.
- Facts and coverage files are integrity-protected. `qc/e2e-coverage.yml`, `qc/USER_FACING_PROGRAMS.txt`, and `qc/facts` are protected, and rotation writes the manifest and audit log: `/home/simone/simoneos/qc/integrity.ts:32` through `/home/simone/simoneos/qc/integrity.ts:76`, and `/home/simone/simoneos/qc/integrity.ts:147` through `/home/simone/simoneos/qc/integrity.ts:160`.

Program-local vs central split:

| Artifact | Scope | Foundry behavior |
| --- | --- | --- |
| `programs/<slug>/frontend.spec.yml` | Program-local | Emit in user-facing governed frontend mode only. |
| `programs/<slug>/registration.ts` `frontendSpecPath` | Program-local | Emit only when `frontend.spec.yml` is present. Backend-only profile keeps it absent. |
| `programs/<slug>/projection.ts` and `__tests__/projection.test.ts` | Program-local | Emit projection keys backing every `derived.*` bind. |
| `programs/<slug>/__tests__/frontend-spec.test.ts` or equivalent | Program-local | Emit targeted validation and derived-bind coverage. |
| `qc/facts/<slug>.facts.yml` | Program-scoped QC, central tree | Deterministically generate only as part of a complete user-facing QC bundle. Because `qc/facts` is protected, curator/integrity rotation is required in SimoneOS. |
| `qc/e2e-frontend/<slug>.scenario.yml` | Program-scoped QC, central tree | Generate a narrow memo-mini scenario; do not attempt generic scenario synthesis yet. Pair it with facts. |
| `qc/e2e-coverage.yml` | Central | Curator patch-request. Must be updated with facts path and frontend cell. |
| `qc/USER_FACING_PROGRAMS.txt` | Central | Curator patch-request if the program is user-facing. |
| `frontend/src/runtime/cutover/v2-programs.ts` | Central | Curator patch-request. |
| `frontend/src/lib/programNames.ts` | Central | Curator patch-request. |
| `frontend/src/runtime/docx-authoring/register-governed-memo-mini.ts`, test, and `frontend/src/main.tsx` import | Central frontend runtime | Curator patch-request. |
| `server/src/registrations/index.ts` and `scripts/specs-loadcheck.ts` | Central backend/QC | Curator patch-request, as in Gap 1. |

Backend-only mode must not emit a half-set. If `frontend.spec.yml` is absent, also omit `frontendSpecPath`, V2 roster, facts, scenario, coverage, display-name, and renderer registration requests.

## 3. Minimal Frontend Target

Goal: make `governed-memo-mini` user-facing with the smallest valid SimoneOS surface, not the full Due Diligence Report UI.

User-visible shape:

- `intake`: `workspace-3col`, left `workspace-sidebar`, primary read-only `focus-panel` describing the memo intake state plus `chat-thread` composer bound to `user_messages`, secondary `workspace-context`.
- `draft_memo`: same workspace rails. Primary `focus-panel` shows the current memo artifact when available, otherwise a drafting placeholder; `chat-thread` remains available for steering. No approval buttons in this increment because the backend has no approval loop.
- `complete`: `workspace-3col`, side rail, primary `completion-celebration`, secondary `workspace-context` in drawer mode plus `artifact-list` with `variant: literal:list` and a `download_session_artifact` action.

Concrete derived additions for this target:

- `focus_object`: for intake use kind `schema_field`; for draft/complete use kind `section` or `completion`; status one of `ready_for_review`, `revising`, `approved`, etc.; actions should be `[]` until the backend has confirmation wiring.
- `workspace_context_tabs`: use only known ids, e.g. `[{ id: 'session', label: 'Session' }, { id: 'artifacts', label: 'Artifacts' }, { id: 'stats', label: 'Stats' }]`.
- `workspace_session_content`, `workspace_domain_content`, `workspace_stat_items`.
- `memo_sections`: one record `{ id: 'memo', title, text: body, status }` for context drawer display.
- `final_artifacts` and `completion_artifacts`: one stable artifact descriptor:

```yaml
id: governed_memo_markdown
extension: .md
title: Governed memo - Markdown
subtitle: Plain text memo source
status: ready
```

Minimal frontend spec skeleton:

```yaml
program: governed-memo-mini
display:
  title: Governed Memo Mini

modes:
  intake:
    layout: workspace-3col
    focus: { enabled: true }
    side: &workspace_side
      - widget: workspace-sidebar
        bind:
          phaseSteps: derived.phase_steps
          phaseTitle: literal:Memo workflow
          checkpoints: derived.workspace_checkpoints
    primary:
      - widget: focus-panel
        bind:
          focusObject: derived.focus_object
      - widget: chat-thread
        bind: &chat_bind
          messages: channels.user_messages
          composerPlaceholder: literal:Describe the facts, issue, audience, and conclusion you need...
        actions: &chat_actions
          - label: Send
            trigger: { type: channel_publish, channel: user_messages }
            emit: send
    secondary: &workspace_context
      - widget: workspace-context
        bind:
          metadata: derived.workspace_metadata
          tabs: derived.workspace_context_tabs
          sessionContent: derived.workspace_session_content
          domainContent: derived.workspace_domain_content
          artifactItems: derived.workspace_artifact_items
          statItems: derived.workspace_stat_items

  draft_memo:
    layout: workspace-3col
    focus: { enabled: true }
    side: *workspace_side
    primary:
      - widget: focus-panel
        bind:
          focusObject: derived.focus_object
      - widget: chat-thread
        bind: *chat_bind
        actions: *chat_actions
    secondary: *workspace_context

  complete:
    layout: workspace-3col
    side: *workspace_side
    primary:
      - widget: completion-celebration
        bind:
          eyebrow: literal:Session complete
          title: derived.completion_title
          summary: derived.completion_summary
          metadata: derived.workspace_stat_items
          artifacts: derived.completion_artifacts
          primaryLabel: literal:Continue
          secondaryLabel: literal:
          auditLabel: literal:View audit trail
        actions:
          - label: Download
            trigger: { type: action, name: download_session_artifact }
            emit: download
    secondary:
      - widget: workspace-context
        bind:
          metadata: derived.workspace_metadata
          tabs: derived.workspace_context_tabs
          sessionContent: derived.workspace_session_content
          artifactItems: derived.workspace_artifact_items
          artifactSections: derived.memo_sections
          statItems: derived.workspace_stat_items
          drawerMode: literal:true
      - widget: artifact-list
        bind:
          title: literal:Memo outputs
          items: derived.completion_artifacts
          emptyLabel: literal:Memo output is not ready yet.
          variant: literal:list
        actions:
          - label: Download
            trigger: { type: action, name: download_session_artifact }
            emit: download
```

Implementation note: the actual generated YAML should avoid an empty `secondaryLabel` if the renderer treats `literal:` as an empty string inconsistently. Omitting optional labels is catalog-valid; existing complete-mode specs include them, but the minimal target does not need "Save as template".

## 4. Phased Implementation Plan

Each phase should start with a failing, narrow falsifier. The first consumer-visible user-facing bundle should remain complete: no generated `frontend.spec.yml` should be enabled in artifact plans without its required projection keys and central curator request entries.

### F1 - Catalog-Conformant Frontend Spec Renderer

Purpose: teach the foundry to render a fixed, catalog-valid `frontend.spec.yml` for the governed memo profile, but keep backend-only generation as the default until F2/F4 are ready.

Falsifier:

- Foundry unit test renders the governed memo frontend spec into a scratch path and validates it with SimoneOS's `expandFrontendSpec` plus `validateFrontendSpec`.
- A generated binding-inventory test lists every `derived.*` path referenced by the spec and compares it to the planned projection contract. This should fail before the renderer exists.
- The spec must satisfy the repo-wide structural rules from `all-program-specs.test.ts`: active modes use `workspace-3col` rails, complete mode uses `completion-celebration` first in primary and secondary `artifact-list` with `variant: literal:list` and `emit: download`.

Foundry code area:

- `src/pgas-new/governed-attach-profile.ts`: add `renderSimoneOsGovernedAttachFrontendSpec`.
- Existing generated spec-load tests: update only for user-facing mode; backend-only assertions still expect `frontendSpecPath` undefined.
- Artifact plan remains backend-only unless an explicit user-facing governed frontend option is selected.

Effort: small to medium. The work is mostly YAML rendering plus tests, but the spec must follow current SimoneOS structural tests, not only the low-level catalog validator.

Dependencies: none beyond the contract map above.

Program-local vs curator split: F1 is foundry-local only. No SimoneOS central edit yet.

### F2 - Projection Additions Backing the Widgets

Purpose: extend the generated projection so every widget bind resolves to a stable, type-compatible value.

Falsifier:

- Generated `projection.test.ts` asserts the full minimal frontend contract: `focus_object`, `workspace_context_tabs`, `workspace_session_content`, `workspace_domain_content`, `workspace_stat_items`, `memo_sections`, `completion_title`, `completion_summary`, `final_artifacts`, and `completion_artifacts`.
- A spec/projection consistency test parses the generated `frontend.spec.yml`, extracts all `derived.*` binds, builds a representative derived map for `intake`, `draft_memo`, and `complete`, and fails if any bound derived key is absent.
- A status vocabulary assertion fails if `phase_steps[*].status` is not one of `done/current/upcoming`.

Foundry code area:

- `src/pgas-new/governed-attach-profile.ts`: projection renderer and projection test renderer.
- User-facing registration branch: set `frontendSpecPath: 'programs/<slug>'` only when emitting `frontend.spec.yml`.

Effort: medium. It is small code volume, but the derived shapes must exactly match the catalog props.

Dependencies: F1.

Program-local vs curator split: projection, frontend spec, and program-local tests are generated. Central backend registration remains curator-owned as in Gap 1.

### F3 - Markdown Artifact Renderer Registration

Purpose: make the `completion-celebration` and `artifact-list` download buttons resolve to real Markdown content.

Falsifier:

- Central SimoneOS test clears the artifact registry, registers `governed_memo_markdown`, calls `renderArtifact` with a domain containing `work.memo_artifact.title/body`, and asserts filename, markdown MIME type, and body text.
- Negative test asserts `renderArtifact` returns `null` when `work.memo_artifact.body` is absent, so the UI shows a "download unavailable" toast instead of a broken file.

Foundry code area:

- Curator request generator in `src/pgas-new/governed-attach-profile.ts`: add exact central edit instructions for the renderer file, test, and `main.tsx` side-effect import.
- The generated projection should use stable output id `governed_memo_markdown` regardless of the LLM-supplied `work.memo_artifact.id`.

Effort: small to medium.

Dependencies: F2's stable artifact ids.

Program-local vs curator split:

- Program-local: output descriptor in projection.
- Central/curator: `frontend/src/runtime/docx-authoring/register-governed-memo-mini.ts`, its test, and `frontend/src/main.tsx` import.

### F4 - Complete Frontend QC Pairing Bundle

Purpose: when the foundry emits a user-facing program, emit or request every paired QC artifact together. Do not generate facts without scenario, scenario without coverage, or V2 roster without scenario.

Falsifier:

- Scratch SimoneOS with the generated program plus curator patch runs:
  - `npx tsx qc/lint-e2e-frontend.ts`
  - `npx tsx qc/lint-archetype-frontend-pairing.ts`
  - `npx tsx qc/lint-coverage-matrix.ts`
  - `npx tsx qc/e2e-frontend/loader.ts` indirectly through a targeted scenario load or runner dry path if available.
- Facts overlay test fails unless `qc/e2e-frontend/governed-memo-mini.scenario.yml` extends `../facts/governed-memo-mini.facts.yml` and both declare `program: governed-memo-mini`.
- Coverage lint fails unless `qc/e2e-coverage.yml` has `programs.governed-memo-mini.facts` and `programs.governed-memo-mini.e2e-frontend.channels: [frontend]`.

Foundry code area:

- Artifact plan: add a complete user-facing frontend QC artifact group only under the governed frontend option.
- Curator request renderer: include central entries for:
  - `qc/e2e-coverage.yml`
  - `qc/USER_FACING_PROGRAMS.txt`
  - `frontend/src/runtime/cutover/v2-programs.ts`
  - `frontend/src/lib/programNames.ts`
  - renderer registration files from F3
  - central backend registration and specs-loadcheck entries.

Scenario target:

- Facts: deterministic memo facts such as client, issue, audience, governing assumption, and required conclusion.
- Scenario: kickoff prompt provides all facts in one message; `user_responses` can include `confirmation: approve`, `notice: approve`, and a fallback `form` response only if the engine emits such widgets. Avoid `llm_responder` in deterministic UAT because the runner rejects it when `E2E_DETERMINISTIC_UAT=1`: `/home/simone/simoneos/qc/e2e-frontend/runner.ts:447` through `/home/simone/simoneos/qc/e2e-frontend/runner.ts:450`.
- Expected modes: `intake`, `draft_memo`, `complete`.
- Expected artifact: `domain_path: work.memo_artifact.body`, with keywords from the facts.

Effort: medium. The files are straightforward, but green results depend on the generated program's LLM behavior being stable enough to reach `complete` without live-drive in this task.

Dependencies: F1 through F3.

Program-local vs curator split:

- Foundry can generate the facts and scenario content deterministically.
- Coverage matrix, user-facing roster, V2 roster, display name, central registration, and integrity rotation are curator-owned.

### F5 - Honest Capability Registry Flip

Purpose: update `rich_frontend` from blanket refusal to a narrow synthesized capability only after the generated governed memo frontend passes the falsifiers.

Falsifier:

- A capability-registry test fails unless `rich_frontend` says exactly what is now synthesized: "minimal governed memo workspace frontend" or similar.
- A negative capability test still refuses rich surfaces not supported by Gap 10, such as editable document viewers, generic approval widgets, alternatives comparison, rich per-item confirmation loops, arbitrary custom tabs, and native DOCX track-change UI.

Foundry code area:

- `src/foundry-program/capability-registry.ts`.
- Any intake/classifier code that currently safe-stops on `rich_frontend` should distinguish the narrow governed memo frontend from richer frontend requirements.

Effort: small, but it should be last because it changes the foundry's public claim.

Dependencies: F1 through F4 green in scratch after curator patch.

Program-local vs curator split: foundry-only.

## 5. Hard Blockers and Impedance Mismatches

Observed blockers:

- Current foundry frontend synthesis is intentionally refused and omitted. This is not an accidental missing file; it is an explicit fail-closed design in both the artifact plan and capability registry.
- Current generated projection is close but not widget-ready. It lacks `focus_object`, `workspace_context_tabs`, `workspace_session_content`, `workspace_domain_content`, `workspace_stat_items`, `memo_sections`, `final_artifacts`, `completion_artifacts`, `completion_title`, and `completion_summary`.
- Current generated `phase_steps` uses status values `complete/current/pending`; widget code expects `done/current/upcoming`. It probably does not crash, but it is not a clean widget contract.
- Current `work.memo_artifact.id` is LLM-supplied. Artifact renderer registration needs a stable artifact id. The projection should expose `governed_memo_markdown` as the downloadable output id and let the renderer read the actual memo body from domain state.
- `workspace-context` accepts only known tab ids. Generic stage names cannot become arbitrary tab ids without central widget changes; for this increment use `session`, `artifacts`, and `stats`.
- Artifact renderer registration is central. There is no observed auto-discovery path from `programs/<slug>` into `frontend/src/main.tsx`.
- Frontend QC is coupled across protected central files. Adding a user-facing program requires facts, scenario, coverage, user-facing roster, V2 roster, display name, central registration, specs-loadcheck, and integrity rotation.
- The e2e-frontend runner classifies active user-response widgets from terminal payloads and selected derived prompts. It recognizes `form`, `confirmation`, `selection`, `file_upload`, `notice`, and `idle`, not catalog widgets such as `focus-panel` or `artifact-list`: `/home/simone/simoneos/qc/e2e-frontend/loader.ts:134` through `/home/simone/simoneos/qc/e2e-frontend/loader.ts:149`, and `/home/simone/simoneos/qc/e2e-frontend/helpers.ts:715` through `/home/simone/simoneos/qc/e2e-frontend/helpers.ts:835`. A deterministic scenario generator must target engine prompts, not visual widgets.
- The generated backend has no approval loop in `draft_memo`. Emitting confirm/reject UI would be misleading until the backend mode declares `user_confirmation` and an approval action path.

Inferred mismatches:

- A generic stage-archetype-to-widget compiler is not enough. The catalog is expressible only if the foundry maps stages into a small, known layout grammar and emits the exact projection shapers the widgets expect.
- The closed-world catalog is not a hard wall for `governed-memo-mini`; it is a hard wall for arbitrary UI synthesis. The smallest unlock is a narrow governed memo frontend archetype, not a general React/UI generator.
- Fully deterministic `qc/e2e-frontend` scenario synthesis is not generally solved. For `governed-memo-mini`, the flow is simple enough to generate a static scenario. For richer workflows, scenario authoring likely needs program-specific prompt/response knowledge and at least one manual UAT pass before the foundry can safely stamp it as required.

Smallest unblocks:

- Add one governed memo frontend archetype with fixed `workspace-3col` rails and known widget ids.
- Add a projection-binding inventory test so the foundry cannot generate a spec whose `derived.*` paths are absent.
- Use stable artifact ids in projection output; do not depend on LLM-selected artifact ids.
- Keep renderer registration and roster changes in curator request text until SimoneOS has an auto-registration surface.
- Keep `rich_frontend` refusal for all non-minimal surfaces until each has its own falsifier.

## 6. Verdict

Governed frontend synthesis is achievable incrementally under the curator-request boundary.

The closed-world catalog is not a hard wall for the minimal governed memo target. It is expressible from a constrained frontend archetype: workspace rails, focus object, chat thread, completion surface, and artifact list. It remains a hard wall for unconstrained generic UI generation because the catalog rejects unknown widgets/binds and the repo-wide tests enforce the V2 workspace shape.

Recommended implementation shape: five foundry PRs plus one curator integration patch in SimoneOS. If the team wants the first consumer-visible generated program to be fully green in SimoneOS scratch, F1 and F2 should land together or F1 should stay foundry-local until F2. Expected effort is roughly one week of focused work: 2-3 days for spec/projection synthesis and tests, 1 day for renderer request/test shaping, 1-2 days for QC bundle and scratch verification, and a short final PR for the capability-registry claim.
