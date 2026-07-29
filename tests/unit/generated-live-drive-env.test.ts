import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { driveGeneratedProgramLive } from '../../src/pgas-new/generated-live-drive.js';

interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
}

describe('generated live-drive child environment', () => {
  const tempDirs: string[] = [];
  const originalOpenAiKey = process.env.PGAS_OPENAI_API_KEY;

  afterEach(() => {
    spawnMock.mockReset();
    if (originalOpenAiKey === undefined) {
      delete process.env.PGAS_OPENAI_API_KEY;
    } else {
      process.env.PGAS_OPENAI_API_KEY = originalOpenAiKey;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a caller-supplied PGAS_OPENAI_API_KEY over the parent process key', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    process.env.PGAS_OPENAI_API_KEY = 'parent-process-key';
    spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptions) => {
      capturedEnv = options.env;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      const reportPath = options.env?.PGAS_LIVE_DRIVE_REPORT;
      queueMicrotask(() => {
        if (reportPath) {
          writeFileSync(reportPath, JSON.stringify({
            final_mode: 'complete',
            terminal: true,
            rounds: 0,
            triggers: 0,
            actions: [],
            terminal_actions: [],
            world: {},
            author_driver: 'default',
          }));
        }
        child.emit('close', 0);
      });
      return child;
    });

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-live-env-'));
    tempDirs.push(targetDir);
    await driveGeneratedProgramLive({
      targetDir,
      slug: 'proposal-ops',
      providerBaseUrl: 'http://127.0.0.1:1/v1',
      model: 'unit-model',
      initialText: 'start',
      env: { PGAS_OPENAI_API_KEY: 'caller-option-key' },
      driveTimeoutMs: 60_000,
    });

    expect(capturedEnv?.PGAS_OPENAI_API_KEY).toBe('caller-option-key');
  });
});
