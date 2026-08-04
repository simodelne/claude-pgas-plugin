import { loadSpecWithPatterns, type ToolImpl, type ToolRegistry } from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';
import { registerPgasNewTools } from '../../src/foundry-program/tools.js';
import { assertActionAllowed, legalActionsForMode } from '../../src/pgas-new/gates.js';
import { createInitialState, PGAS_NEW_ACTIONS, type PgasNewMode, type PgasNewState } from '../../src/pgas-new/model.js';

const MODEL_ACTION_OMISSION_ALLOWLIST = new Set([
  'record_program_target',
  'choose_design_path',
  'apply_default_skeleton',
  'ask_design_question',
  'record_q1_purpose',
  'record_q2_entry_channel',
  'record_q3_stages',
  'record_q4_transitions',
  'record_q5_delegation',
  'record_documents_descriptor',
  'record_q6_completion',
  'record_skill_catalog',
  'record_program_intake_finalize',
  'confirm_design',
  'reject_design_and_revise_q1',
  'reject_design_and_revise_q2',
  'reject_design_and_revise_q3',
  'reject_design_and_revise_q4',
  'reject_design_and_revise_q5',
  'reject_design_and_revise_q6',
]);

const TOOL_REGISTRY_EXTRA_ALLOWLIST = new Set([
  'repo_read_file',
  'repo_list_files',
]);

describe('foundry exported affordance drift', () => {
  it('registers every spec action-map entry as a semantic tool', () => {
    const registered = new Set<string>();
    registerPgasNewTools({
      register(name: string, _tool: ToolImpl): void {
        registered.add(name);
      },
    } as ToolRegistry);

    expect(specActionNames().filter((name) => !registered.has(name))).toEqual([]);
    expect([...registered].filter((name) => !specActionNames().includes(name) && !TOOL_REGISTRY_EXTRA_ALLOWLIST.has(name))).toEqual([]);
  });

  it('keeps the exported action model aligned with the loaded spec vocabulary', () => {
    const publicActions = new Set(PGAS_NEW_ACTIONS);
    expect(specActionNames().filter((name) =>
      !publicActions.has(name as (typeof PGAS_NEW_ACTIONS)[number]) &&
      !MODEL_ACTION_OMISSION_ALLOWLIST.has(name))).toEqual([]);
  });

  it('exposes loaded-spec actions through public gate helpers when their state preconditions are satisfied', () => {
    expect(specVocabulary('architecture_design')).toContain('synthesize_program_spec');
    const architecture = stateForMode('architecture_design', {
      program: { design_confirmed: true },
    });
    expect(legalActionsForMode(architecture, 'architecture_design')).toContain('synthesize_program_spec');
    expect(() => assertActionAllowed(architecture, 'architecture_design', 'synthesize_program_spec')).not.toThrow();

    expect(specVocabulary('scaffold_plan')).toContain('revise_artifact_plan');
    const scaffold = stateForMode('scaffold_plan', {
      program: { synthesis_complete: true },
      artifact_plan: { status: 'draft', approved: false, write_authorized: true },
    });
    expect(legalActionsForMode(scaffold, 'scaffold_plan')).toContain('revise_artifact_plan');
    expect(() => assertActionAllowed(scaffold, 'scaffold_plan', 'revise_artifact_plan')).not.toThrow();
  });
});

function specActionNames(): string[] {
  return [...loadedSpec().action_map.keys()];
}

function specVocabulary(mode: PgasNewMode): string[] {
  return loadedSpec().modes.get(mode)?.vocabulary ?? [];
}

function loadedSpec(): {
  action_map: Map<string, unknown>;
  modes: Map<string, { vocabulary: string[] }>;
} {
  return loadSpecWithPatterns('src/foundry-program/specs.yml').spec as {
    action_map: Map<string, unknown>;
    modes: Map<string, { vocabulary: string[] }>;
  };
}

function stateForMode(
  mode: PgasNewMode,
  overrides: {
    program?: Partial<PgasNewState['program']>;
    artifact_plan?: Partial<PgasNewState['artifact_plan']>;
  } = {},
): PgasNewState {
  const initial = createInitialState();
  return {
    ...initial,
    session: {
      ...initial.session,
      current_mode: mode,
    },
    repo: {
      ...initial.repo,
      target_kind: 'standalone_repo',
      write_authorized: true,
    },
    program: {
      ...initial.program,
      target_dir_confirmed: true,
      design_confirmed: true,
      architecture_ready: true,
      synthesis_complete: true,
      ...overrides.program,
    },
    artifact_plan: {
      ...initial.artifact_plan,
      status: 'approved',
      approved: true,
      write_authorized: true,
      ...overrides.artifact_plan,
    },
  };
}
