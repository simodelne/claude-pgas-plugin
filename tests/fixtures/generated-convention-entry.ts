import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import {
  createToolRegistry,
  loadProgramByConvention,
  type ProgramAdapterOverride,
  type ProgramEntry,
  type ReactionHandler,
  type RegisterProgramByConventionOptions,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';

interface GeneratedHandlersModule {
  handlers?: Record<string, ToolHandler>;
  reactionHandlers?: Map<string, ReactionHandler>;
  createHandlerAdapterOverrides?: () => Record<string, ProgramAdapterOverride>;
}

interface GeneratedToolsModule {
  registeredToolNames?: readonly string[];
  [key: string]: unknown;
}

export async function loadRenderedGeneratedProgramEntry(
  rootDir: string,
  slug: string,
  options: {
    entryOverrides?: RegisterProgramByConventionOptions['entryOverrides'];
    inferDelegationResultPolicy?: boolean;
    /**
     * Wrap the generated adapter overrides before registration. Tests use this to
     * COUNT hook dispatches on the real generated artifact — the engine does not
     * log hook fires, so dispatch cardinality is otherwise unobservable.
     */
    wrapAdapterOverrides?: (
      overrides: Record<string, ProgramAdapterOverride>,
    ) => Record<string, ProgramAdapterOverride>;
  } = {},
): Promise<ProgramEntry> {
  const programDir = join(rootDir, 'src/programs', slug);
  const handlersModule = await import(pathToFileURL(join(programDir, 'handlers.ts')).href) as GeneratedHandlersModule;
  const toolsModule = await import(pathToFileURL(join(programDir, 'tools.ts')).href) as GeneratedToolsModule;
  const toolRegistry = createToolRegistry();
  const registerTools = toolsModule[`register${toPascalCase(slug)}Tools`];
  if (typeof registerTools === 'function') {
    registerTools(toolRegistry);
  }
  const registeredToolNames = toolsModule.registeredToolNames ?? [];
  const entryOverrides = options.entryOverrides
    ?? (options.inferDelegationResultPolicy
      ? inferredDelegationResultPolicyEntryOverrides(join(programDir, 'specs.yml'))
      : undefined);
  const loaded = loadProgramByConvention(slug, {
    programsRoot: join(rootDir, 'src'),
    additionalHandlers: {
      ...(handlersModule.handlers ?? {}),
      ...toolHandlerPlaceholders(toolRegistry, registeredToolNames),
    },
    reactionHandlers: handlersModule.reactionHandlers,
    adapterOptions: {
      overrides: (options.wrapAdapterOverrides ?? ((o) => o))({
        ...(handlersModule.createHandlerAdapterOverrides?.() ?? {}),
        ...toolAdapterOverrides(toolRegistry, registeredToolNames),
      }),
    },
    ...(entryOverrides ? { entryOverrides } : {}),
  });
  return { ...loaded.entry, spec: withDecisionOnlyRegistryPrompts(loaded.entry.spec) };
}

function inferredDelegationResultPolicyEntryOverrides(
  specPath: string,
): RegisterProgramByConventionOptions['entryOverrides'] | undefined {
  const parsed = load(readFileSync(specPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  const fields: Array<{ path: string; key: string }> = [];
  const resultRoots = new Set<string>();
  for (const path of Object.keys(schema)) {
    const resultMatch = /^([^.]+)\.result\.([^.]+)$/u.exec(path);
    if (resultMatch) {
      resultRoots.add(`${resultMatch[1]}.result`);
      fields.push({ path, key: resultMatch[2] as string });
      continue;
    }
    const outputMatch = /^([^.]+)\.output\.(result_json|adapter_kind)$/u.exec(path);
    if (outputMatch) {
      fields.push({ path, key: outputMatch[2] as string });
    }
  }
  for (const root of resultRoots) {
    fields.unshift({ path: root, key: 'result' });
  }
  return fields.length > 0 ? { delegationResultPolicy: { fields } } : undefined;
}

function toolHandlerPlaceholders(
  toolRegistry: ReturnType<typeof createToolRegistry>,
  registeredToolNames: readonly string[],
): Record<string, ToolHandler> {
  const placeholders: Record<string, ToolHandler> = {};
  for (const name of registeredToolNames) {
    if (!toolRegistry.has(name)) continue;
    placeholders[`invoke_tool_${name}`] = async () => {
      throw new Error(`tool adapter for ${name} was not installed`);
    };
  }
  return placeholders;
}

function toolAdapterOverrides(
  toolRegistry: ReturnType<typeof createToolRegistry>,
  registeredToolNames: readonly string[],
): Record<string, ProgramAdapterOverride> {
  const overrides: Record<string, ProgramAdapterOverride> = {};
  for (const name of registeredToolNames) {
    if (toolRegistry.has(name)) {
      overrides[`tool:${name}`] = toolRegistry.createAdapter(name);
    }
  }
  return overrides;
}

function withDecisionOnlyRegistryPrompts<T extends {
  modes?: Map<string, { decisionOnly?: boolean }>;
  prompts?: Map<string, string>;
}>(spec: T): T {
  if (!(spec.modes instanceof Map) || !(spec.prompts instanceof Map)) {
    return spec;
  }
  const prompts = new Map(spec.prompts);
  for (const [modeName, mode] of spec.modes) {
    if (mode.decisionOnly === true && !prompts.has(modeName)) {
      prompts.set(modeName, 'Decision-only auto-transition mode.');
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(spec);
  delete descriptors.prompts;
  const clone = Object.create(Object.getPrototypeOf(spec)) as T;
  Object.defineProperties(clone, descriptors);
  Object.defineProperty(clone, 'prompts', {
    value: prompts,
    enumerable: true,
    configurable: true,
  });
  return clone;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}
