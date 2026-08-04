# Task 0 Report - engine pin 3.26.0

## Bump summary

- Installed `@simodelne/pgas-server@3.26.0` with `npm install @simodelne/pgas-server@3.26.0`.
- Updated `PGAS_SERVER_VERSION` in `src/pgas-new/version.ts` to `3.26.0`.
- Updated lockstep assertions in `tests/unit/version.test.ts`, `tests/unit/template-renderer.test.ts`, and `tests/unit/cli.test.ts`.
- Updated engine-version text in `docs/PGAS-NEW-ARCHITECTURE.md`.
- No golden files were refreshed. The only behavioral test adjustment was `tests/integration/foundry-tool-call-protocol.test.ts`, which now drives the design interview far enough to observe Q3-Q6 tools because engine 3.26 constrains the per-round tool surface to currently legal actions.

Intentional remaining `3.24.0` strings:

- root package self-version in `package.json` / `package-lock.json`
- foundry's own version note in `docs/PGAS-NEW-ARCHITECTURE.md`
- feature history `since_version: '3.24.0'` in `src/foundry-program/capability-registry.ts`
- package self-version assertion in `tests/plugin-manifest.test.sh`
- Task/spec prose describing this bump from `3.24.0`

## Verification tails

`npm run typecheck`

```text
> pgas-new@3.24.0 typecheck
> tsc --noEmit
```

`env -u NPM_TOKEN npm run test:unit`

```text
[export-render-falsifier] F-2 PASS {"docx_bytes":52191,"section_count":1,"sha256":"020bf5eea7fb079d5cffc3069c68ec57eab376b4841117fffd5db27f7a0529c9","nonce_in_docxml":true,"default_absent":true}
[export-render-falsifier] F-3 PASS {"record":{"artifactId":"6ab658b302076b52b4f6663667c25dc2c9290cda","sourceSessionId":"export-render-falsifier-1785829641567","ownerSessionId":null,"sourceProgram":"export-render-falsifier","artifactType":"docx_export","title":"Exported DOCX","summary":"Deterministically rendered DOCX artifact (base64 in domain state).","payloadRef":"export_document.output","qualitySignals":{"status":"Completed","rounds":2,"fallbackCount":0},"producedAt":1785829641613},"artifacts_raw_kind":"object","final_status":"Completed"}
[export-render-falsifier] F-5 PASS {"escaped":true,"emoji_survived":true,"literal_tag_preserved":true}
[export-render-falsifier] F-6 PASS {"refused":["export_docx_trackchange"]}
[export-render-falsifier] F-7 PASS {"export_docx_plain":"synthesizes","export_docx_trackchange":"refuses"}

 Test Files  110 passed | 4 skipped (114)
      Tests  739 passed | 14 skipped (753)
   Start at  07:44:41
   Duration  192.45s (transform 3.32s, setup 0ms, import 62.95s, tests 110.42s, environment 17ms)
```

`env -u NPM_TOKEN npm run test:static`

```text
> pgas-new@3.24.0 test:static
> bash tests/pgas-new-static.test.sh

=== pgas-new-static.test.sh ===
[1/6] render standalone scaffold
  PASS: rendered specs.yml
  PASS: rendered REPL index
  PASS: rendered REPL renderer
  PASS: rendered live provider test
[2/6] generated scaffold has no banned imports
  PASS: no banned imports
[3/6] generated specs.yml parses
  PASS: specs.yml parses as YAML
[4/6] package typecheck
  PASS: typecheck passed
[5/6] unit/static tests
[pgas:auth] initial admin seeded: email=admin@test (pgas#499)
  PASS: Vitest suite passed
[6/6] optional generated scaffold install/test
  SKIP: NPM_TOKEN not explicitly set; generated scaffold package install/test not run

=== Result: 8 pass, 0 fail ===
```

## Legal-opinion no-regression

Command:

```text
PGAS_PROVIDER=openai PGAS_OPENAI_BASE_URL=http://localhost:8000/v1 PGAS_OPENAI_MODEL=qwen36-27b PGAS_ROUND_TIMEOUT_MS=600000 node --import tsx .dd-report-exp/legal-opinion/scripts/live-drive-legal-opinion.ts
```

Driver summary:

```json
{
  "ok": true,
  "status": "Completed",
  "final_mode": "complete",
  "rounds": 109,
  "triggers": 100,
  "provider_hits": 118,
  "provider_exchange_count": 118,
  "failed_gates": [],
  "export_section_count": 93,
  "export_docx_bytes": 58388,
  "export_sha256": "32e08473ff70987a709bfcf8eaf6a1677d16bc2f0a946027f906cd7c1b9912dd",
  "docx_path": "/home/simone/pgas-new/.dd-report-exp/legal-opinion/raw/legal-opinion-live-drive.docx"
}
```

Independent measurement from world JSON and parent session log:

```json
{
  "worldPath": ".dd-report-exp/legal-opinion/raw/legal-opinion-live-drive.world.json",
  "logPath": ".dd-report-exp/legal-opinion/logs/legal-opinion/legal-opinion-drafter-1785829902006/session-log.ndjson",
  "finalMode": "complete",
  "completed": true,
  "items": 93,
  "accepted": 93,
  "nonEmptySections": 93,
  "exportSectionCount": 93,
  "failedGates": 0,
  "provider400": 0,
  "fallbackCount": 0,
  "fallbackActions": 0,
  "triggerFailed": 0,
  "models": ["qwen36-27b"],
  "defectTerms": [
    "capacity defect",
    "authority defect",
    "unauthorized",
    "unperfected",
    "subject to amendment",
    "subject to ratification",
    "subject to perfection",
    "qualified"
  ]
}
```

Verdict: PASS. The 3.26.0 bump did not regress the spotless legal-opinion bar.

## Codex-driver native-tool pre-check

Engine seam inspected:

- `node_modules/@simodelne/pgas-server/dist-bundle/create-server.mjs`: `createPgasServer` warns when `drivers.unified.capabilities.nativeToolCalling === false` while `authorMode` is `unified`.
- `node_modules/@simodelne/pgas-server/dist-bundle/plugin.mjs`: `CODEX_CLI_DEFAULT` declares `nativeToolCalling: false`, `toolSchemaDialect: "none"`, and `toolCallParserLocation: "middleware"`.
- `plugin.mjs` builds a text prelude named `UNIFIED TOOL-CALL COMPLETION CONTRACT`, serializes `{ messages, tools }` into the prompt, invokes `codex exec --json --sandbox read-only ... -`, then parses the final text response with `parseCodexUnifiedCompletion`.

Minimal live drive:

- Program: generated SOTA `fee-calculator` fixture.
- Driver: public `createCodexCliUnifiedComplete()` from `@simodelne/pgas-server/plugin.js`; `_runner` only wrapped the real `codex exec` call to record the raw final message.
- Codex CLI: `codex-cli 0.142.3`, `codex login status` reported `Logged in using ChatGPT`.
- Round latency: `15.362s` trigger latency; `15.253s` Codex call latency.
- Mode after one round: `calculate_fee`; status after one round: `Running`.

Raw final message:

```json
{"content":null,"tool_calls":[{"type":"function","function":{"name":"begin_work","arguments":{"message":"Captured initial request and starting fee calculation workflow."}}}]}
```

Assertion:

- The raw final message is a text JSON envelope, not a provider-native tool-call response.
- The envelope parsed into one `tool_calls` item named `begin_work`.
- Native tool calls are NOT supported by the codex driver on engine 3.26.0.

Verdict: NO. Option b, meaning running the foundry agent under the codex driver as a native-tool path, is not viable on 3.26.0. The available codex path is emulated text JSON parsed in middleware.
