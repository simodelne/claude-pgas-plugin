import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { ConversationMessage } from '@simodelne/pgas-server/plugin.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenAiUnifiedPayload } from '../../src/foundry-server.js';
import { shouldDisableThinking } from '../../src/pgas-new/disable-thinking.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { sanitizedVerificationEnv, VERIFICATION_ENV_DENYLIST } from '../../src/pgas-new/verification-env.js';

// pgas v6 removes the engine's Qwen/GLM model-prefix thinking inference and canonicalizes
// the disable policy on PGAS_DISABLE_THINKING=1. pgas-new builds OpenAI-compatible author
// payloads in TWO places — its own unified driver (src/foundry-server.ts) and the driver it
// emits into every generated program (templates/.../author-driver.ts.tmpl) — and a generated
// program cannot import foundry src/, so the policy is duplicated on purpose.
//
// These tests lock, for BOTH sites:
//   (1) canonical-first precedence across all four cases,
//   (2) that the emitted copy is byte-identical to the foundry copy (drift is silent
//       otherwise: nothing errors, the model just resumes emitting thinking tokens).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY_BEGIN = '// --- BEGIN pgas thinking policy (parity-locked) ---';
const POLICY_END = '// --- END pgas thinking policy ---';
const PAYLOAD_SPREAD = '...(shouldDisableThinking(model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),';
// The pre-v6 consumer-side re-implementation of the engine's model-prefix inference.
const LEGACY_PREFIX_INFERENCE = "qwenModel && process.env.PGAS_OPENAI_DISABLE_THINKING";

interface PrecedenceCase {
  readonly name: string;
  readonly model: string;
  readonly env: Record<string, string | undefined>;
  readonly disabled: boolean;
}

const PRECEDENCE_CASES: readonly PrecedenceCase[] = [
  {
    name: 'canonical=1 disables thinking regardless of model family',
    model: 'glm-4.7',
    env: { PGAS_DISABLE_THINKING: '1' },
    disabled: true,
  },
  {
    name: 'canonical=1 wins over an explicit PGAS_OPENAI_DISABLE_THINKING=0',
    model: 'glm-4.7',
    env: { PGAS_DISABLE_THINKING: '1', PGAS_OPENAI_DISABLE_THINKING: '0' },
    disabled: true,
  },
  {
    name: 'canonical=0 keeps thinking enabled regardless of PGAS_OPENAI_DISABLE_THINKING',
    model: 'qwen36-27b',
    env: { PGAS_DISABLE_THINKING: '0', PGAS_OPENAI_DISABLE_THINKING: '1' },
    disabled: false,
  },
  {
    name: 'canonical unset + qwen model falls back to the family default (disabled)',
    model: 'qwen36-27b',
    env: {},
    disabled: true,
  },
  {
    name: 'canonical unset + qwen model honours the consumer-owned opt-out',
    model: 'qwen36-27b',
    env: { PGAS_OPENAI_DISABLE_THINKING: '0' },
    disabled: false,
  },
  {
    name: 'canonical unset + non-qwen model sends no thinking control at all',
    model: 'glm-4.7',
    env: {},
    disabled: false,
  },
];

describe('thinking-disable policy (pgas v6 canonical-first precedence)', () => {
  let outDir = '';
  let emittedAuthorDriver = '';

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'pgas-new-disable-thinking-'));
    renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });
    emittedAuthorDriver = readFileSync(join(outDir, 'src/author-driver.ts'), 'utf8');
  });

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  describe('shared policy function', () => {
    for (const testCase of PRECEDENCE_CASES) {
      it(testCase.name, () => {
        expect(shouldDisableThinking(testCase.model, testCase.env)).toBe(testCase.disabled);
      });
    }
  });

  describe("site 1 — the foundry's own unified author payload (src/foundry-server.ts)", () => {
    for (const testCase of PRECEDENCE_CASES) {
      it(testCase.name, () => {
        withProcessEnv({ PGAS_MODEL: testCase.model, PGAS_OPENAI_MODEL: undefined, ...testCase.env }, () => {
          const payload = createOpenAiUnifiedPayload(conversation(), []);
          expect(payload.model).toBe(testCase.model);
          expectThinkingControl(payload, testCase.disabled);
        });
      });
    }
  });

  describe('site 2 — the author payload emitted into every generated program', () => {
    for (const testCase of PRECEDENCE_CASES) {
      it(testCase.name, async () => {
        const payload = await emittedAuthorPayload(emittedAuthorDriver, testCase);
        expect(payload.model).toBe(testCase.model);
        expectThinkingControl(payload, testCase.disabled);
      });
    }
  });

  describe('parity between the two sites', () => {
    it('emits the foundry policy block verbatim into the generated author driver', () => {
      const foundryPolicy = policyBlock(readFileSync(join(ROOT, 'src/pgas-new/disable-thinking.ts'), 'utf8'));
      const emittedPolicy = policyBlock(emittedAuthorDriver);

      expect(foundryPolicy).toContain('PGAS_DISABLE_THINKING');
      expect(foundryPolicy).toContain('export function shouldDisableThinking(');
      expect(emittedPolicy).toBe(foundryPolicy);
    });

    it('routes both payload builders through the shared policy instead of re-inferring the model family', () => {
      const foundryServer = readFileSync(join(ROOT, 'src/foundry-server.ts'), 'utf8');

      expect(foundryServer).toContain(PAYLOAD_SPREAD);
      expect(emittedAuthorDriver).toContain(PAYLOAD_SPREAD);
      expect(foundryServer).not.toContain(LEGACY_PREFIX_INFERENCE);
      expect(emittedAuthorDriver).not.toContain(LEGACY_PREFIX_INFERENCE);
    });
  });

  // Sites 3 and 4 are the foundry's two DIRECT provider calls (domain-synthesis
  // and reasoning-contract). They build their request bodies inline rather than
  // through a shared payload builder, which is exactly how they ended up as the
  // one place in the foundry that carried NO thinking control at all — silently,
  // since nothing errors when a model resumes emitting thinking tokens.
  //
  // This block does not hardcode a list of files. It DERIVES every OpenAI-compatible
  // call site from source and requires each to route through the shared policy, so a
  // newly added provider call cannot reintroduce the asymmetry unnoticed.
  describe('completeness — every OpenAI-compatible call site carries the policy', () => {
    const callSites = openAiCallSites();

    it('finds the known call sites (guards against the scan silently matching nothing)', () => {
      expect(callSites.length).toBeGreaterThanOrEqual(3);
      expect(callSites.map((site) => site.file)).toEqual(
        expect.arrayContaining([
          'src/foundry-server.ts',
          'src/foundry-program/domain-synthesis.ts',
          'src/foundry-program/reasoning-contract.ts',
        ]),
      );
    });

    for (const site of openAiCallSites()) {
      it(`${site.file} routes through shouldDisableThinking`, () => {
        expect(site.source, `${site.file} calls an OpenAI-compatible endpoint but never consults the shared policy`)
          .toContain('shouldDisableThinking(');
        expect(site.source, `${site.file} must not re-infer the model family locally`)
          .not.toContain(LEGACY_PREFIX_INFERENCE);
        expect(site.source, `${site.file} must set chat_template_kwargs from the policy`)
          .toMatch(/shouldDisableThinking\([^)]*\)\s*\?\s*\{\s*chat_template_kwargs:\s*\{\s*enable_thinking:\s*false\s*\}\s*\}\s*:\s*\{\}/);
      });
    }
  });

  describe('deploy/env surface', () => {
    it('strips the canonical thinking variable from generated-scaffold verification subprocesses', () => {
      expect(VERIFICATION_ENV_DENYLIST).toContain('PGAS_DISABLE_THINKING');
      expect(sanitizedVerificationEnv({ PGAS_DISABLE_THINKING: '1', KEEP_ME: 'yes' })).toEqual({ KEEP_ME: 'yes' });
    });

    it('documents the canonical variable in the emitted author-driver header', () => {
      expect(emittedAuthorDriver).toContain('`PGAS_DISABLE_THINKING` — canonical');
    });
  });
});

function conversation(): ConversationMessage[] {
  return [{ role: 'user', content: 'thinking policy probe' }] as ConversationMessage[];
}

function expectThinkingControl(payload: Record<string, unknown>, disabled: boolean): void {
  if (disabled) {
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
  } else {
    expect(Object.keys(payload)).not.toContain('chat_template_kwargs');
  }
}

const THINKING_ENV_KEYS = [
  'PGAS_DISABLE_THINKING',
  'PGAS_OPENAI_DISABLE_THINKING',
  'PGAS_MODEL',
  'PGAS_OPENAI_MODEL',
] as const;

function withProcessEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map(THINKING_ENV_KEYS.map((key) => [key as string, process.env[key]]));
  try {
    for (const key of THINKING_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Runs the REAL emitted `src/author-driver.ts` (transpiled, in a vm realm with a
 * controlled `process.env` and a capturing `fetch`) and returns the request body the
 * generated program would actually put on the wire.
 */
async function emittedAuthorPayload(
  source: string,
  testCase: PrecedenceCase,
): Promise<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  const env: Record<string, string | undefined> = {
    PGAS_AUTHOR_DRIVER: 'unified',
    PGAS_OPENAI_BASE_URL: 'http://provider.local/v1',
    PGAS_OPENAI_API_KEY: 'local',
    PGAS_OPENAI_MODEL: testCase.model,
    ...testCase.env,
  };

  const transpiled = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({
    exports: exportsObject,
    module: moduleObject,
    console: { error: (): void => {} },
    process: { env },
    fetch: async (_url: string, init: { body: string }): Promise<unknown> => {
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        json: async (): Promise<unknown> => ({}),
        text: async (): Promise<string> => '',
      };
    },
    require: (specifier: string): never => {
      throw new Error(`unexpected emitted author-driver import: ${specifier}`);
    },
  });
  new Script(transpiled.outputText, { filename: 'emitted-author-driver.cjs' }).runInContext(context, {
    timeout: 5_000,
  });

  const resolveAuthorDrivers = (moduleObject.exports as Record<string, unknown>).resolveAuthorDrivers;
  if (typeof resolveAuthorDrivers !== 'function') {
    throw new Error('emitted author driver did not export resolveAuthorDrivers');
  }
  const drivers = (resolveAuthorDrivers as () => {
    unified: { complete: (messages: unknown, tools: unknown[]) => Promise<unknown> };
  })();
  await drivers.unified.complete(conversation(), []);

  if (requests.length !== 1) {
    throw new Error(`expected exactly one emitted provider request, got ${String(requests.length)}`);
  }
  return requests[0];
}

function policyBlock(source: string): string {
  const start = source.indexOf(POLICY_BEGIN);
  const end = source.indexOf(POLICY_END);
  if (start === -1 || end === -1) {
    throw new Error('source is missing the parity-locked thinking policy markers');
  }
  return source.slice(start, end + POLICY_END.length);
}

/**
 * Every foundry source file that POSTs to an OpenAI-compatible `/chat/completions`
 * endpoint. Derived from source rather than hardcoded so a new provider call is
 * covered the moment it is written.
 */
function openAiCallSites(): Array<{ file: string; source: string }> {
  const roots = ['src/foundry-server.ts', 'src/foundry-program', 'src/pgas-new'];
  const files: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) walk(`${rel}/${entry}`);
      return;
    }
    if (rel.endsWith('.ts')) files.push(rel);
  };
  for (const root of roots) walk(root);
  return files
    .map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }))
    // the generated repo-integration POST targets a HOST API, not a model, so it
    // is correctly excluded by keying on the chat-completions path.
    .filter((entry) => entry.source.includes('/chat/completions'));
}
