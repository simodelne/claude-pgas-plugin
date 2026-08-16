import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import type {
  ConversationMessage,
  OpenAIToolDefinition,
  ProgramEntry,
  UnifiedAuthorDriverOptions,
} from '@simodelne/pgas-server/plugin.js';
import { dump, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { loadRenderedGeneratedProgramEntry } from '../fixtures/generated-convention-entry.js';

const PROGRAM_SLUG = 'hub-selective-projection-falsifier';
const PROGRAM_NAME = 'Hub Selective Projection Falsifier';
const HUB_STAGE = 'finalization_hub';
const COMPLETE_STAGE = 'complete';
const SUMMARY_PATH = 'work.document.summary';
const SECTIONS_PATH = 'work.document.sections';
const SECTION_TEXT_SELECTOR = `${SECTIONS_PATH}.*.text`;
const SECTION_TWO_KEY = 'section_beta';
const SECTION_TWO_ID = 'section-beta';
const SECTION_TWO_HEADING = 'Findings and caveats';
const SECTION_TWO_STATUS = 'needs_revision';
const SECTION_TWO_TEXT_PATH = `${SECTIONS_PATH}.${SECTION_TWO_KEY}.text`;
const SUMMARY_SENTINEL = 'TASK4_SUMMARY_VISIBLE_SENTINEL';
const SECTION_ONE_TEXT = 'TASK4_SECTION_ONE_TEXT_MUST_NOT_PROJECT';
const SECTION_TWO_TEXT = 'TASK4_SECTION_TWO_TEXT_QUERY_ONLY_SENTINEL';

describe('hub selective section-artifact projection falsifier', () => {
  it('projects only document summary and section index while full section text is query-only', { timeout: 120_000 }, async () => {
    const artifact = synthesizeProgramSpecFromDomain(sectionArtifactHubDomain());
    const sectionState = sectionArtifactsState();
    const specYaml = withSeedIngestionPaths(artifact.spec_yaml, Object.keys(sectionState));
    const parsed = load(specYaml) as ParsedSpec;
    const hubProjection = parsed.projection[HUB_STAGE];

    expect(parsed.features).toContain('inline_world_query');
    expect(hubProjection.include).toEqual(expect.arrayContaining([
      SUMMARY_PATH,
      `${SECTIONS_PATH}.*.id`,
      `${SECTIONS_PATH}.*.heading`,
      `${SECTIONS_PATH}.*.status`,
    ]));
    expect(hubProjection.include).not.toContain(SECTION_TEXT_SELECTOR);
    expect(hubProjection.exclude).toContain(SECTION_TEXT_SELECTOR);

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-hub-selective-projection-'));
    const captures: Capture[] = [];
    try {
      renderStandaloneScaffold({
        slug: PROGRAM_SLUG,
        name: PROGRAM_NAME,
        outDir: targetDir,
        synthesizedSpecYaml: specYaml,
        synthesizedRegistrationTs: artifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);

      const entry = await importProgramEntry(targetDir);
      const allowedPrefixes = entry.queryPolicy?.allowedWorldQueryPrefixes ?? [];
      expect(allowedPrefixes).toContain(SECTIONS_PATH);

      const server = await createPgasServer({
        programs: [{ name: PROGRAM_SLUG, entry }],
        drivers: {
          authorMode: 'unified',
          unified: {
            complete: scriptedAuthor(captures),
            inlineWorldQuery: { enabled: true },
          },
          authorHandle: {
            modelId: 'hub-selective-projection-legacy-author',
            async complete() {
              throw new Error('legacy author path should not run');
            },
          },
          observerHandle: {
            modelId: 'hub-selective-projection-observer',
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
        const created = await client.sessions.create({
          program: PROGRAM_SLUG,
          initial_trigger: { channel: 'seed', payload: sectionState },
        });
        await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: `read ${SECTION_TWO_ID} text` });
      } finally {
        await server.close();
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }

    const preQuery = captures[1] ?? missingCapture('pre-query hub');
    expect(preQuery.toolNames).toContain('query');
    expect(preQuery.prompt).toContain(SUMMARY_SENTINEL);
    expect(preQuery.prompt).toContain(SECTION_TWO_ID);
    expect(preQuery.prompt).toContain(SECTION_TWO_HEADING);
    expect(preQuery.prompt).toContain(SECTION_TWO_STATUS);
    expect(preQuery.prompt).not.toContain(SECTION_ONE_TEXT);
    expect(preQuery.prompt).not.toContain(SECTION_TWO_TEXT);

    const afterQuery = captures[2] ?? missingCapture('post-query hub');
    expect(afterQuery.prompt).toContain(SECTION_TWO_TEXT);
  });
});

interface ParsedSpec {
  features: string[];
  ingestion: Record<string, string[]>;
  modes: Record<string, { channels?: string[] }>;
  projection: Record<string, { include: string[]; exclude: string[] }>;
}

interface Capture {
  prompt: string;
  toolNames: string[];
}

function sectionArtifactHubDomain(): Record<string, unknown> {
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
    'program.design_path': 'design',
    'intake.purpose': 'Use a document-finalization hub that can inspect a bounded section index and query full section text on demand.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: HUB_STAGE,
        kind: 'hub',
        archetype: 'conversational_hub',
        domain_spec: {
          reads: [
            'inputs.initial_user_text',
            SUMMARY_PATH,
            `${SECTIONS_PATH}.*.id`,
            `${SECTIONS_PATH}.*.heading`,
            `${SECTIONS_PATH}.*.status`,
            SECTION_TEXT_SELECTOR,
          ],
          produces: {},
          rules: ['Use the projected section index to choose a section, then query full text only when needed.'],
          invariants: ['Section full text must not appear in the hub prompt projection.'],
        },
      },
      { slug: COMPLETE_STAGE, is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: HUB_STAGE, trigger: 'started', guard_field: 'intake.started' },
      { from: HUB_STAGE, to: HUB_STAGE, trigger: 'stay' },
      { from: HUB_STAGE, to: COMPLETE_STAGE, trigger: 'done', guard_field: 'finalization.done' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({
      final_stage: COMPLETE_STAGE,
      guard_field: 'finalization.done',
    }),
  };
}

function scriptedAuthor(captures: Capture[]): UnifiedAuthorDriverOptions['complete'] {
  let queried = false;
  return async (messages, tools) => {
    const prompt = promptText(messages);
    const toolNames = tools.map((tool) => tool.function.name);
    captures.push({ prompt, toolNames });

    if (hasTool(tools, 'begin_work')) {
      return toolCall('begin_work', {});
    }
    if (!queried) {
      queried = true;
      return toolCall('query', { path: SECTION_TWO_TEXT_PATH });
    }
    return toolCall('session_status', {});
  };
}

function sectionArtifactsState(): Record<string, unknown> {
  return {
    [SUMMARY_PATH]: SUMMARY_SENTINEL,
    [`${SECTIONS_PATH}.section_alpha.id`]: 'section-alpha',
    [`${SECTIONS_PATH}.section_alpha.heading`]: 'Background',
    [`${SECTIONS_PATH}.section_alpha.status`]: 'approved',
    [`${SECTIONS_PATH}.section_alpha.text`]: SECTION_ONE_TEXT,
    [`${SECTIONS_PATH}.${SECTION_TWO_KEY}.id`]: SECTION_TWO_ID,
    [`${SECTIONS_PATH}.${SECTION_TWO_KEY}.heading`]: SECTION_TWO_HEADING,
    [`${SECTIONS_PATH}.${SECTION_TWO_KEY}.status`]: SECTION_TWO_STATUS,
    [SECTION_TWO_TEXT_PATH]: SECTION_TWO_TEXT,
  };
}

function withSeedIngestionPaths(specYaml: string, paths: string[]): string {
  const spec = load(specYaml) as ParsedSpec;
  spec.ingestion.seed = [...new Set([...(spec.ingestion.seed ?? []), ...paths])];
  return dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
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

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  return loadRenderedGeneratedProgramEntry(targetDir, PROGRAM_SLUG);
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function missingCapture(label: string): never {
  throw new Error(`missing ${label} capture`);
}
