import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
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

  it('renders existing-repo attachments to import registration from programs/<slug>', async () => {
    let runnerSource = '';
    spawnMock.mockImplementation((_command: string, args: string[], options: SpawnOptions) => {
      runnerSource = readFileSync(String(args.at(-1)), 'utf8');
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

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-live-existing-repo-'));
    tempDirs.push(targetDir);
    mkdirSync(join(targetDir, 'programs/document-finalization'), { recursive: true });
    writeFileSync(join(targetDir, 'programs/document-finalization/registration.js'), 'export function createDocumentFinalizationProgramEntry() {}\n');

    const options = {
      targetDir,
      slug: 'document-finalization',
      providerBaseUrl: 'http://127.0.0.1:1/v1',
      model: 'unit-model',
      initialText: 'start',
      targetKind: 'existing_repo',
      programsDir: 'programs',
      driveTimeoutMs: 60_000,
    } as Parameters<typeof driveGeneratedProgramLive>[0] & {
      targetKind: 'existing_repo';
      programsDir: string;
    };
    await driveGeneratedProgramLive(options);

    const importPath = registrationImportFrom(runnerSource, 'createDocumentFinalizationProgramEntry');
    const resolvedImport = resolve(targetDir, '.pgas-new-live-drive', importPath);

    expect(resolvedImport).toBe(join(targetDir, 'programs/document-finalization/registration.js'));
    expect(existsSync(resolvedImport)).toBe(true);
    expect(runnerSource).not.toContain('../src/programs/document-finalization/registration.js');
  });

  it('renders existing-repo delegated child imports from the slug-safe child program name', async () => {
    let runnerSource = '';
    spawnMock.mockImplementation((_command: string, args: string[], options: SpawnOptions) => {
      runnerSource = readFileSync(String(args.at(-1)), 'utf8');
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
            final_mode: 'finalization_hub',
            terminal: false,
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

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-live-existing-repo-child-'));
    tempDirs.push(targetDir);
    mkdirSync(join(targetDir, 'programs/document-finalization'), { recursive: true });
    mkdirSync(join(targetDir, 'programs/document-ingest'), { recursive: true });
    writeFileSync(join(targetDir, 'programs/document-finalization/registration.js'), 'export function createDocumentFinalizationProgramEntry() {}\n');
    writeFileSync(join(targetDir, 'programs/document-ingest/registration.js'), 'export function createDocumentIngestProgramEntry() {}\n');

    await driveGeneratedProgramLive({
      targetDir,
      slug: 'document-finalization',
      providerBaseUrl: 'http://127.0.0.1:1/v1',
      model: 'unit-model',
      initialText: 'start',
      finalStage: 'finalization_hub',
      targetKind: 'existing_repo',
      programsDir: 'programs',
      driveTimeoutMs: 60_000,
      delegationScript: {
        resultPath: 'ingest.delegation.document_ingest.result',
        settledPath: 'ingest.delegation.document_ingest.settled',
        degradedPath: 'ingest.delegation.document_ingest.degraded',
        stage: 'ingest',
        childProgram: 'document-ingest',
      },
    });

    const childImportPath = registrationImportFrom(runnerSource, 'createDocumentIngestProgramEntry');
    const resolvedChildImport = resolve(targetDir, '.pgas-new-live-drive', childImportPath);

    expect(resolvedChildImport).toBe(join(targetDir, 'programs/document-ingest/registration.js'));
    expect(existsSync(resolvedChildImport)).toBe(true);
    expect(runnerSource).not.toContain('SimoneOS Document Ingest');
  });
});

function registrationImportFrom(source: string, exportName: string): string {
  const match = source.match(new RegExp(`import \\{ ${exportName} \\} from '([^']+)';`, 'u'));
  if (!match) {
    throw new Error(`runner source missing ${exportName} import`);
  }
  return match[1];
}
