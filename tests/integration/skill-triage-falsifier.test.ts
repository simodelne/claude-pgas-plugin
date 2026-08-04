import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import type {
  ConversationMessage,
  OpenAIToolDefinition,
  ProgramEntry,
  UnifiedAuthorDriverOptions,
} from '@simodelne/pgas-server/plugin.js';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

const PROGRAM_SLUG = 'skill-triage-falsifier';
const PROGRAM_NAME = 'Skill Triage Falsifier';
const HUB_STAGE = 'hub';
const COMPLETE_STAGE = 'complete';
const HUB_STAY_ACTION = 'advance_hub_to_hub';
const COMPLETE_ACTION = 'advance_hub_to_complete';
const DECISION_PATH = 'skill_triage_settled';
const CLAUSE_BODY = 'CLAUSE_AMENDMENT_BODY_SENTINEL: propose the narrowest enforceable clause redline.';

const SKILLS = [
  { name: 'clause-amendment', body: CLAUSE_BODY },
  { name: 'enforceability-review', body: 'ENFORCEABILITY_BODY_SENTINEL: check capacity, authority, law, and remedy.' },
  { name: 'risk-disclosure-checklist', body: 'RISK_DISCLOSURE_BODY_SENTINEL: enumerate material risks and mitigants.' },
  { name: 'compare-to-precedent', body: 'PRECEDENT_BODY_SENTINEL: compare text against the supplied precedent.' },
] as const;

describe('generated skill triage falsifier', () => {
  it('synthesizes opt-in skill_triage and settles activation/decline through the engine', { timeout: 120_000 }, async () => {
    const artifact = synthesizeProgramSpecFromDomain(skillHubDomain());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.features).toEqual(expect.arrayContaining(['activation', 'skill_triage']));
    expect(parsed.decision_schema).toMatchObject({ [DECISION_PATH]: 'string' });
    expect(parsed.modes[HUB_STAGE]?.vocabulary).toContain(HUB_STAY_ACTION);
    expect(parsed.modes[HUB_STAGE]?.vocabulary).not.toEqual(expect.arrayContaining(['activate_skill', 'decline_skills']));

    const targets = parsed.activation_providers?.skill?.targets ?? {};
    expect(Object.keys(targets).sort()).toEqual(SKILLS.map((skill) => skill.name).sort());
    for (const skill of SKILLS) {
      expect(parsed.advisory_schema?.[`skill.${skill.name}`]).toBe('string');
      expect(targets[skill.name]?.body).toBe(skill.body);
    }

    const plain = load(synthesizeProgramSpecFromDomain(skillHubDomain({ skills: [] })).spec_yaml) as ParsedSpec;
    expect(plain.features).not.toContain('skill_triage');
    expect(plain.activation_providers).toBeUndefined();
    expect(plain.decision_schema).toBeUndefined();

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-skill-triage-'));
    try {
      renderStandaloneScaffold({
        slug: PROGRAM_SLUG,
        name: PROGRAM_NAME,
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedRegistrationTs: artifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);

      const activation = await runSkillScenario(targetDir, [
        step('begin_work', {}, { expectTool: 'begin_work' }),
        step('activate_skill', { name: 'clause-amendment' }, { expectTool: 'activate_skill' }),
        step('session_status', {}, { expectPromptIncludes: CLAUSE_BODY }),
      ]);
      expect(decisionState(activation.afterDecision, DECISION_PATH)).toBe('activated');
      expect(activation.decisionCapture.toolNames).toEqual(expect.arrayContaining(['activate_skill', 'decline_skills']));
      expect(activation.decisionCapture.prompt).toContain('Available skills');
      for (const skill of SKILLS) {
        expect(activation.decisionCapture.prompt).toContain(skill.name);
        expect(activation.decisionCapture.prompt).not.toContain(skill.body);
      }
      expect(activation.followupCapture.prompt).toContain(CLAUSE_BODY);

      const decline = await runSkillScenario(targetDir, [
        step('begin_work', {}, { expectTool: 'begin_work' }),
        step('decline_skills', {}, { expectTool: 'decline_skills' }),
        step('session_status', {}, { expectPromptExcludes: CLAUSE_BODY }),
      ]);
      expect(decisionState(decline.afterDecision, DECISION_PATH)).toBe('declined');
      expect(decline.decisionCapture.toolNames).toEqual(expect.arrayContaining(['activate_skill', 'decline_skills']));
      expect(decline.followupCapture.prompt).not.toContain(CLAUSE_BODY);
      expect(decline.followupCapture.prompt).not.toContain('ACTIVE SKILLS (advisory');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

interface ParsedSpec {
  features: string[];
  modes: Record<string, { vocabulary: string[] }>;
  advisory_schema?: Record<string, string>;
  activation_providers?: Record<string, {
    targets: Record<string, { body: unknown; description?: string }>;
  }>;
  decision_schema?: Record<string, string>;
}

interface Capture {
  prompt: string;
  toolNames: string[];
}

interface ScriptStep {
  toolName: string;
  args: Record<string, unknown>;
  expectTool?: string;
  expectPromptIncludes?: string;
  expectPromptExcludes?: string;
}

interface ScenarioResult {
  captures: Capture[];
  afterDecision: unknown;
  decisionCapture: Capture;
  followupCapture: Capture;
}

function skillHubDomain(options: { skills?: readonly { name: string; body: string }[] } = {}): Record<string, unknown> {
  const skills = options.skills ?? SKILLS;
  return {
    'program.slug': PROGRAM_SLUG,
    'program.name': PROGRAM_NAME,
    'program.target_dir': `/tmp/${PROGRAM_SLUG}`,
    'program.design_path': 'design',
    'intake.purpose': 'Use a conversational hub that can activate declared legal finalization skills on demand.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      {
        slug: HUB_STAGE,
        kind: 'hub',
        archetype: 'conversational_hub',
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: {},
          rules: ['Stay in the hub while skill triage activates or declines playbooks.'],
          invariants: ['Declared skill bodies must be injected only after activate_skill.'],
        },
      },
      { slug: COMPLETE_STAGE, is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: HUB_STAGE, trigger: 'started', guard_field: 'intake.started' },
      { from: HUB_STAGE, to: HUB_STAGE, trigger: 'stay' },
      { from: HUB_STAGE, to: COMPLETE_STAGE, trigger: 'done', guard_field: 'hub.done' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: COMPLETE_STAGE, guard_field: 'hub.done' }),
    ...(skills.length > 0 ? { 'intake.skills_json': JSON.stringify(skills) } : {}),
  };
}

async function runSkillScenario(targetDir: string, steps: ScriptStep[]): Promise<ScenarioResult> {
  const captures: Capture[] = [];
  const server = await createPgasServer({
    programs: [{ name: PROGRAM_SLUG, entry: await importProgramEntry(targetDir) }],
    drivers: {
      authorMode: 'unified',
      unified: { complete: scriptedAuthor(captures, steps) },
      authorHandle: {
        modelId: 'skill-triage-legacy-author',
        async complete() {
          throw new Error('legacy author path should not run');
        },
      },
      observerHandle: {
        modelId: 'skill-triage-observer',
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
    const created = await client.sessions.create({ program: PROGRAM_SLUG });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'start skill triage' });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'make a skill decision' });
    const afterDecision = await client.sessions.getFull(created.sessionId);
    return {
      captures,
      afterDecision,
      decisionCapture: captures[1] ?? missingCapture('decision'),
      followupCapture: captures[2] ?? missingCapture('followup'),
    };
  } finally {
    await server.close();
  }
}

function scriptedAuthor(captures: Capture[], steps: ScriptStep[]): UnifiedAuthorDriverOptions['complete'] {
  let index = 0;
  return async (messages, tools) => {
    const stepToRun = steps[index++];
    if (!stepToRun) {
      throw new Error(`no skill-triage author response scripted for call ${String(index - 1)}`);
    }
    const prompt = promptText(messages);
    const toolNames = tools.map((tool) => tool.function.name);
    captures.push({ prompt, toolNames });
    if (stepToRun.expectTool && !hasTool(tools, stepToRun.expectTool)) {
      throw new Error(`expected tool ${stepToRun.expectTool}; got ${toolNames.join(', ')}`);
    }
    if (stepToRun.expectPromptIncludes && !prompt.includes(stepToRun.expectPromptIncludes)) {
      throw new Error(`expected prompt to include ${stepToRun.expectPromptIncludes}`);
    }
    if (stepToRun.expectPromptExcludes && prompt.includes(stepToRun.expectPromptExcludes)) {
      throw new Error(`expected prompt not to include ${stepToRun.expectPromptExcludes}`);
    }
    return toolCall(stepToRun.toolName, stepToRun.args);
  };
}

function step(
  toolName: string,
  args: Record<string, unknown>,
  options: Omit<ScriptStep, 'toolName' | 'args'> = {},
): ScriptStep {
  return { toolName, args, ...options };
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

function hasTool(tools: OpenAIToolDefinition[], name: string): boolean {
  return tools.some((tool) => tool.function.name === name);
}

function promptText(messages: ConversationMessage[]): string {
  return messages
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))
    .join('\n');
}

async function importProgramEntry(targetDir: string): Promise<ProgramEntry> {
  const module = await import(pathToFileURL(join(targetDir, `src/programs/${PROGRAM_SLUG}/registration.ts`)).href) as Record<string, unknown>;
  const createEntry = Object.values(module).find((value): value is () => ProgramEntry =>
    typeof value === 'function' && /^create[A-Z].*ProgramEntry$/u.test(value.name));
  if (!createEntry) {
    throw new Error(`generated registration did not export a create*ProgramEntry function: ${Object.keys(module).join(', ')}`);
  }
  return createEntry();
}

function decisionState(fullState: unknown, path: string): unknown {
  const decision = firstDecisionList(fullState);
  if (!Array.isArray(decision)) {
    return undefined;
  }
  for (const entry of decision) {
    if (!Array.isArray(entry) || entry[0] !== path || !isRecord(entry[1])) {
      continue;
    }
    return entry[1].dec_state;
  }
  return undefined;
}

function firstDecisionList(fullState: unknown): unknown {
  if (!isRecord(fullState)) {
    return undefined;
  }
  const context = fullState.context;
  const nestedState = isRecord(context) && isRecord(context.state) ? context.state : undefined;
  return nestedState?.decision ?? fullState.decision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function missingCapture(label: string): never {
  throw new Error(`missing ${label} prompt capture`);
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}
