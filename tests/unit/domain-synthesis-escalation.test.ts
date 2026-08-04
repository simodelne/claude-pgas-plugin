import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';

const engineMocks = vi.hoisted(() => {
  const complete = vi.fn<(prompt: string) => Promise<string>>();
  return {
    complete,
    createProviderHandles: vi.fn(() => ({
      authorHandle: { complete },
      observerHandle: { complete: vi.fn<(prompt: string) => Promise<string>>() },
    })),
  };
});

vi.mock('@simodelne/pgas-server/plugin.js', () => ({
  createProviderHandles: engineMocks.createProviderHandles,
}));

const validBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'ok' }),
    items_json: JSON.stringify([input.stage]),
    digest: '',
  };
}
`;

const invalidBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void input;
  void runtime;
  return {
    result_json: JSON.stringify({ stage: 'wrong-stage' }),
    items_json: JSON.stringify([]),
    digest: '',
  };
}
`;

function artifact(): SynthesizedArtifact {
  return {
    spec_yaml: 'name: test',
    mode_names: ['intake', 'calculate', 'done'],
    sha256: 'sha',
    created_at: '2026-06-28T00:00:00.000Z',
    contracts_ts: 'export interface StageInput {}; export interface StageRuntime {}; export interface StageOutput {};',
    handlers_ts: 'export const handlers = {};',
    handlers_index_ts: 'export const handlers = {};',
    tools_ts: 'export const stageActionTools = {};',
    smoke_test_ts: 'describe("generated program smoke", () => {});',
    stage_classification: [
      { slug: 'calculate', archetype: 'pure-compute', rationale: 'compute' },
    ],
    body_stage_slugs: ['calculate'],
  };
}

function withCache<T>(fn: (cacheDir: string) => Promise<T>): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-domain-synthesis-escalation-test-'));
  return fn(cacheDir).finally(() => rmSync(cacheDir, { recursive: true, force: true }));
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

describe('domain synthesis codex escalation', () => {
  const originalEscalationDriver = process.env.PGAS_SYNTH_ESCALATION_DRIVER;
  const originalEscalationMaxAttempts = process.env.PGAS_SYNTH_ESCALATION_MAX_ATTEMPTS;
  const originalEnableCodexDriver = process.env.PGAS_ENABLE_CODEX_DRIVER;
  const originalOpenAiBaseUrl = process.env.PGAS_OPENAI_BASE_URL;
  const originalOpenAiModel = process.env.PGAS_OPENAI_MODEL;
  const originalPgasModel = process.env.PGAS_MODEL;
  const originalOpenAiApiKey = process.env.PGAS_OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    engineMocks.complete.mockReset();
    engineMocks.createProviderHandles.mockClear();
    globalThis.fetch = originalFetch;
    restoreEnv('PGAS_SYNTH_ESCALATION_DRIVER', originalEscalationDriver);
    restoreEnv('PGAS_SYNTH_ESCALATION_MAX_ATTEMPTS', originalEscalationMaxAttempts);
    restoreEnv('PGAS_ENABLE_CODEX_DRIVER', originalEnableCodexDriver);
    restoreEnv('PGAS_OPENAI_BASE_URL', originalOpenAiBaseUrl);
    restoreEnv('PGAS_OPENAI_MODEL', originalOpenAiModel);
    restoreEnv('PGAS_MODEL', originalPgasModel);
    restoreEnv('PGAS_OPENAI_API_KEY', originalOpenAiApiKey);
  });

  it('escalates exhausted stage-body repair to codex-cli before deterministic fallback', async () => {
    await withCache(async (cacheDir) => {
      process.env.PGAS_SYNTH_ESCALATION_DRIVER = 'codex-cli';
      process.env.PGAS_SYNTH_ESCALATION_MAX_ATTEMPTS = '2';
      delete process.env.PGAS_ENABLE_CODEX_DRIVER;
      engineMocks.complete
        .mockResolvedValueOnce(invalidBody)
        .mockResolvedValueOnce(`\`\`\`ts\n${validBody}\n\`\`\``);

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        maxAttempts: 1,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => 'export const nope = 1;',
      });

      expect(engineMocks.createProviderHandles).toHaveBeenCalledTimes(1);
      expect(engineMocks.createProviderHandles).toHaveBeenCalledWith({ provider: 'codex-cli' });
      expect(process.env.PGAS_ENABLE_CODEX_DRIVER).toBe('1');
      expect(engineMocks.complete).toHaveBeenCalledTimes(2);
      expect(engineMocks.complete.mock.calls[0]?.[0]).toContain('Return only TypeScript source code. Do not use markdown fences.');
      expect(engineMocks.complete.mock.calls[0]?.[0]).toContain('Previous attempt failed:\nstage body must export function runStage');
      expect(engineMocks.complete.mock.calls[1]?.[0]).toContain('Previous attempt failed:\nbehavioral gate failed for stage calculate');
      expect(result.stage_sources?.calculate).toBe(validBody.trim());
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        stage: 'calculate',
        archetype: 'pure-compute',
        behavioral_gate: 'passed',
        attempts: 1,
        escalation_driver: 'codex-cli',
        escalation_attempts: 2,
        cache_hit: false,
      }));
      expect(result.domain_synthesis_audit?.[0]).not.toHaveProperty('deterministic_fallback');

      const cacheFiles = readdirSync(cacheDir).filter((name) => name.endsWith('.json'));
      expect(cacheFiles).toHaveLength(1);
      const cached = JSON.parse(readFileSync(join(cacheDir, cacheFiles[0]!), 'utf8')) as Record<string, unknown>;
      expect(cached.escalation_driver).toBe('codex-cli');
    });
  });

  it('uses the OpenAI-compatible body generator env even when the codex author driver is enabled', async () => {
    await withCache(async (cacheDir) => {
      const bodyRequests: Array<{ url: string; authorization: string | null; payload: Record<string, unknown> }> = [];
      process.env.PGAS_ENABLE_CODEX_DRIVER = '1';
      process.env.PGAS_OPENAI_BASE_URL = 'http://qwen.local/v1';
      process.env.PGAS_OPENAI_MODEL = 'qwen36-27b';
      process.env.PGAS_OPENAI_API_KEY = 'local';
      delete process.env.PGAS_MODEL;
      delete process.env.PGAS_SYNTH_ESCALATION_DRIVER;
      globalThis.fetch = openAiBodyGeneratorFetchStub(bodyRequests);

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        maxAttempts: 1,
      });

      expect(engineMocks.createProviderHandles).not.toHaveBeenCalled();
      expect(result.stage_sources?.calculate).toBe(validBody.trim());
      expect(bodyRequests).toEqual([
        expect.objectContaining({
          url: 'http://qwen.local/v1/chat/completions',
          authorization: 'Bearer local',
          payload: expect.objectContaining({
            model: 'qwen36-27b',
            temperature: 0,
          }),
        }),
      ]);
    });
  });

  it('leaves the deterministic fallback path default-off when escalation env is unset', async () => {
    await withCache(async (cacheDir) => {
      delete process.env.PGAS_SYNTH_ESCALATION_DRIVER;
      delete process.env.PGAS_SYNTH_ESCALATION_MAX_ATTEMPTS;

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        maxAttempts: 1,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => 'export const nope = 1;',
      });

      expect(engineMocks.createProviderHandles).not.toHaveBeenCalled();
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        stage: 'calculate',
        behavioral_gate: 'passed',
        deterministic_fallback: true,
        attempts: 1,
      }));
      expect(result.domain_synthesis_audit?.[0]).not.toHaveProperty('escalation_driver');
      expect(result.domain_synthesis_audit?.[0]).not.toHaveProperty('escalation_attempts');
    });
  });
});

function openAiBodyGeneratorFetchStub(
  requests: Array<{ url: string; authorization: string | null; payload: Record<string, unknown> }>,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const payload = await request.json() as Record<string, unknown>;
    requests.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      payload,
    });
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: validBody,
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
