import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import type {
  ConversationMessage,
  OpenAIToolDefinition,
  ProgramEntry,
  UnifiedAuthorDriverOptions,
} from '@simodelne/pgas-server/plugin.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { loadRenderedGeneratedProgramEntry } from '../fixtures/generated-convention-entry.js';

interface ParsedSpec {
  features: string[];
  modes: Record<string, { vocabulary: string[] }>;
  schema: Record<string, string>;
}

interface Capture {
  prompt: string;
  toolNames: string[];
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generated toolkit awareness', () => {
  it('advertises engine-native toolkit affordances only when wired', { timeout: 120_000 }, async () => {
    const artifact = synthesizeProgramSpecFromDomain(toolkitDomain());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;
    const targetDir = trackedTempRoot('pgas-generated-toolkit-awareness-');
    renderStandaloneScaffold({
      slug: 'toolkit-awareness',
      name: 'Toolkit Awareness',
      outDir: targetDir,
      synthesizedSpecYaml: artifact.spec_yaml,
      synthesizedRegistrationTs: artifact.registration_ts,
      synthesizedContractsTs: artifact.contracts_ts,
      synthesizedHandlersTs: artifact.handlers_ts,
      synthesizedHandlersIndexTs: artifact.handlers_index_ts,
      synthesizedStageSources: artifact.stage_sources,
      synthesizedToolsTs: artifact.tools_ts,
      synthesizedSmokeTestTs: artifact.smoke_test_ts,
    });
    linkRootNodeModules(targetDir);

    const entry = await importProgramEntry(targetDir);
    const allowedWorldQueryPrefixes = entry.queryPolicy?.allowedWorldQueryPrefixes ?? [];
    const captures: Capture[] = [];
    const complete = scriptedCapture(captures);
    const server = await createPgasServer({
      programs: [{ name: 'toolkit-awareness', entry }],
      drivers: {
        authorMode: 'unified',
        unified: {
          complete,
          inlineWorldQuery: { enabled: true },
        },
        authorHandle: {
          modelId: 'toolkit-awareness-legacy-author',
          async complete() {
            throw new Error('legacy author path should not run');
          },
        },
        observerHandle: {
          modelId: 'toolkit-awareness-observer',
          async complete() {
            return 'noop';
          },
        },
      },
      devMode: true,
      telemetry: { enabled: false },
      port: 0,
    });
    const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));

    try {
      const created = await client.sessions.create({ program: 'toolkit-awareness' });
      await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'start toolkit smoke' });
      await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'finish toolkit smoke' });
    } finally {
      await server.close();
    }

    const intakeCapture = captureWithTool(captures, 'begin_work');
    const workCapture = captureWithTool(captures, 'complete_research');

    expect(parsed.features).toContain('inline_world_query');
    expect(parsed.schema).toHaveProperty('notebook.*');
    expect(parsed.schema).toHaveProperty('notebook_pins');
    expect(parsed.modes.intake.vocabulary).not.toContain('record_user_note');
    expect(parsed.modes.research.vocabulary).not.toContain('record_user_note');
    expect(parsed.modes.complete.vocabulary).not.toEqual(expect.arrayContaining([
      'record_note',
      'pin_note',
      'unpin_note',
      'delete_note',
    ]));
    expect(allowedWorldQueryPrefixes.length).toBeGreaterThan(0);

    for (const capture of [intakeCapture, workCapture]) {
      expect(capture.prompt).toContain('Engine toolkit available in this mode');
      expect(capture.prompt).toContain('Session controls are for explicit control intent only');
      expect(capture.toolNames).toEqual(expect.arrayContaining(['query']));
      expect(allowedWorldQueryPrefixes.length).toBeGreaterThan(0);

      const notebookToolNames = ['read_note', 'record_note', 'pin_note', 'unpin_note', 'delete_note'];
      expect(capture.toolNames).toEqual(expect.arrayContaining(notebookToolNames));
      if (notebookToolNames.some((name) => capture.toolNames.includes(name))) {
        expect(capture.prompt).toContain('NOTEBOOK');
      }
    }
  });
});

function toolkitDomain(): Record<string, unknown> {
  return {
    'program.slug': 'toolkit-awareness',
    'program.name': 'Toolkit Awareness',
    'program.target_dir': '/tmp/toolkit-awareness',
    'program.design_path': 'design',
    'intake.purpose': 'Capture a request, perform one research step, and finish.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'research',
        domain_spec: {
          reads: ['inputs.initial_user_text', 'research.output.result_json'],
          produces: { 'research.done': true },
          rules: ['Use only declared state paths.'],
          invariants: ['Do not invent facts.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'research', trigger: 'started', guard_field: 'intake.started' },
      { from: 'research', to: 'complete', trigger: 'researched', guard_field: 'research.done' },
    ]),
    'intake.delegation_json': JSON.stringify({ research: { kind: 'llm-reasoning' } }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'research.done' }),
  };
}

function scriptedCapture(captures: Capture[]): UnifiedAuthorDriverOptions['complete'] {
  return async (messages, tools) => {
    captures.push({
      prompt: promptText(messages),
      toolNames: tools.map((tool) => tool.function.name),
    });
    if (hasTool(tools, 'begin_work')) {
      return toolCall('begin_work', {});
    }
    if (hasTool(tools, 'complete_research')) {
      return toolCall('complete_research', {
        result_json: JSON.stringify({ summary: 'researched toolkit awareness' }),
        items_json: JSON.stringify(['research:complete']),
      });
    }
    return toolCall('session_status', {});
  };
}

function hasTool(tools: OpenAIToolDefinition[], name: string): boolean {
  return tools.some((tool) => tool.function.name === name);
}

function toolCall(name: string, args: Record<string, unknown>): { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } {
  return {
    tool_calls: [
      {
        id: `call_${name}`,
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

function promptText(messages: ConversationMessage[]): string {
  return messages
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))
    .join('\n');
}

function captureWithTool(captures: Capture[], toolName: string): Capture {
  const capture = captures.find((entry) => entry.toolNames.includes(toolName));
  if (!capture) {
    throw new Error(`missing capture with tool ${toolName}; saw ${captures.map((entry) => entry.toolNames.join(',')).join(' | ')}`);
  }
  return capture;
}

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  return loadRenderedGeneratedProgramEntry(targetDir, 'toolkit-awareness');
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
