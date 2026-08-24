import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import {
  deriveKeyedCollectionScript,
  driveGeneratedProgramLive,
  type GeneratedLiveDriveKeyedCollectionScript,
} from '../../src/pgas-new/generated-live-drive.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import {
  KEYED_COLLECTION_APPEND_ACTION,
  KEYED_COLLECTION_DISTINCT_IDS,
  KEYED_COLLECTION_INITIAL_TEXT,
  KEYED_COLLECTION_KEY,
  KEYED_COLLECTION_NAME,
  KEYED_COLLECTION_PATH,
  KEYED_COLLECTION_SLUG,
  KEYED_COLLECTION_STAGE,
  KEYED_COLLECTION_SUPERSEDED_ID,
  KEYED_COLLECTION_TERMINAL_ACTION,
  keyedCollectionDomain,
  keyedCollectionReasoningContractJson,
} from '../fixtures/keyed-collection-live-scenario.js';

/**
 * pgas#993 keyed-extraction LIVE-DRIVE SCENARIO — hermetic proof.
 *
 * This is the exact scenario, script derivation, runner and verdict the operator
 * runs against a real provider (see the `PGAS_LIVE_GRADUATION=1` gate in
 * tests/integration/generated-live-drive.test.ts). Everything here is real
 * except the MODEL: synthesis is the real foundry, the program is the real
 * rendered scaffold, the runner is the real `renderKeyedCollectionLiveDriveRunnerSource`
 * output executing in a spawned node process against a real `createPgasServer`,
 * and the verdict is the real `assessKeyedCollectionEngagement`. Only the
 * OpenAI-compatible provider is a local scripted stand-in, so the whole rig can
 * be proven without a GPU.
 *
 * What the LIVE run adds that this cannot: that a real model, unaided, chooses
 * to call the element-append action once per listed record (including the
 * re-stated one) instead of batching. That behaviour is the whole point of the
 * live rung and is NOT claimed here.
 */

const SCENARIO_TIMEOUT_MS = 300_000;

/**
 * The catalogue listing as records, in listing order. The 4th entry re-states
 * `R-1001` with corrected values — the re-append that makes upsert-by-key
 * testable at all.
 */
const LISTED_RECORDS: Array<Record<string, unknown>> = [
  { record_id: 'R-1001', label: 'Halogen Lamp Assembly', unit_price: 42 },
  { record_id: 'R-1002', label: 'Copper Bus Bar', unit_price: 17 },
  { record_id: 'R-1003', label: 'Ceramic Insulator Set', unit_price: 9 },
  { record_id: 'R-1001', label: 'Halogen Lamp Assembly (Rev B)', unit_price: 46 },
];

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('pgas#993 keyed-extraction live-drive scenario (hermetic rig)', () => {
  it('synthesizes a keyed record_array and derives the drive script from the emitted spec', { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const artifact = await synthesizeKeyedScenario();

    // The spec-level gate the live drive runs BEFORE spending a provider round:
    // no keyed_collections (or a batch-shaped append) means there is nothing
    // keyed to drive, and the drive must refuse rather than "pass".
    const script = deriveKeyedCollectionScript(artifact.spec_yaml);
    expect(script).toEqual<GeneratedLiveDriveKeyedCollectionScript>({
      collectionPath: KEYED_COLLECTION_PATH,
      key: KEYED_COLLECTION_KEY,
      field: 'records',
      appendAction: KEYED_COLLECTION_APPEND_ACTION,
      terminalAction: KEYED_COLLECTION_TERMINAL_ACTION,
      stage: KEYED_COLLECTION_STAGE,
    });

    expect(artifact.spec_yaml).toContain('keyed_collection');
    expect(artifact.spec_yaml).toContain(`collection: ${KEYED_COLLECTION_PATH}`);
    expect(artifact.spec_yaml).toContain(`key: ${KEYED_COLLECTION_KEY}`);
  });

  it('refuses to derive a drive script from a spec with no keyed collection', () => {
    expect(() => deriveKeyedCollectionScript('name: no-keys\naction_map: {}\n'))
      .toThrow(/declares no keyed_collections/u);
  });

  it('refuses a spec whose terminal action still carries the record_array batch arg', () => {
    // The #825 batch shape leaking back onto the one-shot completion action is
    // precisely the pgas#993 regression; the derivation must not paper over it.
    expect(() => deriveKeyedCollectionScript(regressedBatchArgSpecYaml()))
      .toThrow(/still declares the keyed record_array arg records/u);
  });

  it('drives the rendered scaffold through the REAL keyed live-drive runner to a green verdict', { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const artifact = await synthesizeKeyedScenario();
    const script = deriveKeyedCollectionScript(artifact.spec_yaml);
    const targetDir = renderKeyedScenario(artifact);

    const provider = await startScriptedProvider(script);
    try {
      const drive = await driveGeneratedProgramLive({
        targetDir,
        slug: KEYED_COLLECTION_SLUG,
        providerBaseUrl: provider.baseUrl,
        model: 'hermetic-scripted',
        initialText: KEYED_COLLECTION_INITIAL_TEXT,
        finalStage: 'complete',
        maxTriggers: 16,
        driveTimeoutMs: 240_000,
        keyedCollectionScript: script,
      });

      expect(drive.runner_error, `runner error (output tail: ${drive.runner_output_excerpt})`).toBeUndefined();
      expect(drive.final_mode).toBe('complete');

      const report = drive.keyed_collection;
      expect(report, 'keyed-collection report harvested by the runner').toBeTruthy();

      // The runner harvested ONE append call per listed record, each carrying a
      // single ELEMENT (never a batch array), each keyed.
      expect(report?.append_calls).toHaveLength(LISTED_RECORDS.length);
      expect(report?.append_calls.map((call) => call.arg_kind)).toEqual(
        LISTED_RECORDS.map(() => 'object'),
      );
      expect(report?.append_calls.map((call) => call.key)).toEqual(
        LISTED_RECORDS.map((record) => record.record_id),
      );

      // …the one-shot completion action fired and carried NO record_array arg…
      expect(report?.terminal_calls.length).toBeGreaterThanOrEqual(1);
      expect(report?.terminal_calls.every((call) => call.arg_kind === 'absent')).toBe(true);

      // …and the keyed upsert collapsed the re-stated id to ONE element holding
      // the CORRECTED payload.
      expect(report?.collection_size).toBe(KEYED_COLLECTION_DISTINCT_IDS.length);
      const superseded = (report?.collection ?? []).filter(
        (element) => element[KEYED_COLLECTION_KEY] === KEYED_COLLECTION_SUPERSEDED_ID,
      );
      expect(superseded).toHaveLength(1);
      expect(superseded[0]?.label).toBe('Halogen Lamp Assembly (Rev B)');
      expect(superseded[0]?.unit_price).toBe(46);

      // The real verdict, computed from the real report.
      expect(drive.keyed_collection_verdict.notes).toEqual([]);
      expect(drive.keyed_collection_verdict.duplicate_key_reappended).toBe(true);
      expect(drive.keyed_collection_verdict.upsert_deduped).toBe(true);
      expect(drive.keyed_collection_verdict.upsert_replaced_latest).toBe(true);
      expect(drive.keyed_collection_verdict.terminal_batch_arg_absent).toBe(true);
      expect(drive.keyed_collection_engaged).toBe(true);
    } finally {
      await provider.close();
    }
  });

  it('KILL: a model that BATCHES the records upserts NOTHING, and the verdict refuses', { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const artifact = await synthesizeKeyedScenario();
    const script = deriveKeyedCollectionScript(artifact.spec_yaml);
    const targetDir = renderKeyedScenario(artifact);

    // Same program, same listing. The ONLY change is the scripted model's
    // behaviour: it packs all four records into ONE append call — the shape
    // pgas#993 says a keyed MAppend cannot resolve.
    const provider = await startScriptedProvider(script, { batchAllRecords: true });
    try {
      const drive = await driveGeneratedProgramLive({
        targetDir,
        slug: KEYED_COLLECTION_SLUG,
        providerBaseUrl: provider.baseUrl,
        model: 'hermetic-scripted-batch',
        initialText: KEYED_COLLECTION_INITIAL_TEXT,
        finalStage: 'complete',
        maxTriggers: 16,
        driveTimeoutMs: 240_000,
        keyedCollectionScript: script,
      });

      // OBSERVED on engine 5.7.1: the batch arg upserts NOTHING — the keyed
      // collection stays empty, exactly the silent no-op pgas#993 describes.
      expect(drive.keyed_collection?.collection_size).toBe(0);
      expect(drive.keyed_collection?.append_calls).toHaveLength(1);
      expect(drive.keyed_collection?.append_calls[0]?.arg_kind).toBe('array');

      // On THIS scenario the empty collection is additionally caught downstream
      // by the generated persistence stage's own non-empty guard, so the drive
      // never reaches `complete`. That downstream guard is scenario-specific;
      // the verdict below does not depend on it.
      expect(drive.final_mode).not.toBe('complete');

      // THE KILL: the verdict refuses, naming the batch arg and the empty
      // collection — it does not need the program to fail to say no.
      expect(drive.keyed_collection_engaged).toBe(false);
      expect(drive.keyed_collection_verdict.one_record_per_call).toBe(false);
      expect(drive.keyed_collection_verdict.append_action_repeated).toBe(false);
      expect(drive.keyed_collection_verdict.collection_non_empty).toBe(false);
      expect(drive.keyed_collection_verdict.notes.join(';')).toContain('batch_arg_on_append:round=2:kind=array');
      expect(drive.keyed_collection_verdict.notes).toContain('collection_empty');
    } finally {
      await provider.close();
    }
  });
});

// ───────────────────────────── scenario rig ─────────────────────────────

async function synthesizeKeyedScenario(): Promise<SynthesizedArtifact> {
  const cacheDir = trackedTempRoot('pgas-new-keyed-scenario-cache-');
  return synthesizeDomainLogic(
    { ...synthesizeProgramSpecFromDomain(keyedCollectionDomain), created_at: new Date().toISOString() },
    {
      cacheDir,
      providerUrl: 'http://provider.local/v1',
      model: 'hermetic',
      generator: async ({ stage }) => `return { ${stage}_ok: true };`,
      reasoningContractGenerator: async ({ stage }) => keyedCollectionReasoningContractJson(stage),
    },
  );
}

function renderKeyedScenario(artifact: SynthesizedArtifact): string {
  const targetDir = trackedTempRoot('pgas-new-keyed-scenario-render-');
  renderStandaloneScaffold({
    slug: KEYED_COLLECTION_SLUG,
    name: KEYED_COLLECTION_NAME,
    outDir: targetDir,
    synthesizedSpecYaml: artifact.spec_yaml,
    synthesizedRegistrationTs: artifact.registration_ts,
    synthesizedCapabilityGaps: artifact.capability_gaps,
    synthesizedContractsTs: artifact.contracts_ts,
    synthesizedHandlersTs: artifact.handlers_ts,
    synthesizedHandlersIndexTs: artifact.handlers_index_ts,
    synthesizedStageSources: artifact.stage_sources,
    synthesizedToolsTs: artifact.tools_ts,
    synthesizedSmokeTestTs: artifact.smoke_test_ts,
  });
  linkRootNodeModules(targetDir);
  return targetDir;
}

/**
 * A local OpenAI-compatible stand-in. It decides purely from the prompt: the
 * named completion action gives the mode, and the round HISTORY gives how many
 * element-appends already landed, so a repair round re-issues the SAME action
 * instead of skipping a record.
 */
async function startScriptedProvider(
  script: GeneratedLiveDriveKeyedCollectionScript,
  options: { batchAllRecords?: boolean } = {},
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let content: string;
      try {
        content = JSON.stringify(nextResponse(readPrompt(Buffer.concat(chunks).toString('utf8')), script, options));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'hermetic',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('scripted provider failed to bind');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readPrompt(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
  return (parsed.messages ?? [])
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

function nextResponse(
  prompt: string,
  script: GeneratedLiveDriveKeyedCollectionScript,
  options: { batchAllRecords?: boolean },
): Record<string, unknown> {
  const completionAction = /call ([a-z0-9_]+) as the single native tool_call/u.exec(prompt)?.[1];
  if (!completionAction) {
    throw new Error('scripted provider could not determine the mode completion action');
  }
  if (completionAction !== script.terminalAction) {
    // intake bootstrap and the deterministic persistence wrapper both take an
    // empty payload.
    return effect(completionAction, {}, 'stage_output');
  }

  const appendsSoFar = countHistoryTerminals(prompt, script.appendAction);
  if (options.batchAllRecords) {
    return appendsSoFar === 0
      ? effect(script.appendAction, { [script.field]: LISTED_RECORDS }, 'widget_output')
      : completionEffect(script);
  }
  const nextRecord = LISTED_RECORDS[appendsSoFar];
  return nextRecord
    ? effect(script.appendAction, { [script.field]: nextRecord }, 'widget_output')
    : completionEffect(script);
}

function completionEffect(script: GeneratedLiveDriveKeyedCollectionScript): Record<string, unknown> {
  return effect(script.terminalAction, {
    record_count: KEYED_COLLECTION_DISTINCT_IDS.length,
    extraction_notes: 'recorded every listed catalogue entry, re-stating the corrected id',
  }, 'stage_output');
}

function effect(name: string, payload: Record<string, unknown>, channel: string): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

/** Count rounds already closed by `actionName`, read from the prompt's History block. */
function countHistoryTerminals(prompt: string, actionName: string): number {
  const history = balancedJsonAfter(prompt, 'History:', '[');
  if (!Array.isArray(history)) {
    return 0;
  }
  return history.filter((round) => {
    if (!isRecord(round)) return false;
    const result = round.result;
    if (!isRecord(result)) return false;
    const terminal = result.terminal;
    return isRecord(terminal) && terminal.name === actionName;
  }).length;
}

function balancedJsonAfter(text: string, label: string, opener: '[' | '{'): unknown {
  const labelIndex = text.indexOf(label);
  if (labelIndex < 0) return undefined;
  const start = text.indexOf(opener, labelIndex);
  if (start < 0) return undefined;
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * A spec that declares the keyed collection but LEAVES the record_array on the
 * one-shot completion action — the pgas#993 regression the derivation refuses.
 */
function regressedBatchArgSpecYaml(): string {
  return [
    'name: regressed',
    'keyed_collections:',
    `  - collection: ${KEYED_COLLECTION_PATH}`,
    `    key: ${KEYED_COLLECTION_KEY}`,
    'action_map:',
    `  ${KEYED_COLLECTION_APPEND_ACTION}:`,
    '    arg_schema:',
    '      records: { type: object, required: true }',
    '    mutations:',
    `      - { op: MAppend, path: ${KEYED_COLLECTION_PATH}, value: {}, from_arg: records }`,
    `  ${KEYED_COLLECTION_TERMINAL_ACTION}:`,
    '    arg_schema:',
    '      records: { type: array, required: true }',
    '    mutations:',
    `      - { op: MSet, path: ${KEYED_COLLECTION_STAGE}.done, value: true }`,
    '',
  ].join('\n');
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
