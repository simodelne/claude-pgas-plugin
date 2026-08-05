import type { ProgramArtifactPolicy, ProgramArtifactRule } from '@simodelne/pgas-server/plugin.js';

import { tsString } from './shared.js';

export function pdfReportArtifactRule(input: {
  title: string;
  payloadRef: string;
}): ProgramArtifactRule {
  return {
    artifactType: 'pdf_report',
    title: input.title,
    summary: 'Structured lead report rendered by host PdfReportHostConnector; PDF bytes are base64 in domain state.',
    payloadRef: input.payloadRef,
    whenAllPaths: [`${input.payloadRef}.pdf_base64`],
  };
}

export function renderRegistrationSource(
  pascalName: string,
  policies: {
    delegationPolicy?: { allowedTargetPrograms: string[]; inputEnrichment: Array<{ source: string; target: string }> };
    delegationResultPolicy?: { fields: Array<{ path: string; key: string }> };
    artifactPolicy?: ProgramArtifactPolicy;
    queryPolicy?: { allowedWorldQueryPrefixes: string[]; mode: 'enforce' };
  } = {},
  options: {
    exportHookChannel?: string;
    syncOutContinuationChannels?: string[];
  } = {},
): string {
  const policyEntries = [
    policies.delegationPolicy
      ? `    delegationPolicy: ${renderTsValue(policies.delegationPolicy)},`
      : '',
    policies.delegationResultPolicy
      ? `    delegationResultPolicy: ${renderTsValue(policies.delegationResultPolicy)},`
      : '',
    policies.artifactPolicy
      ? `    artifactPolicy: ${renderTsValue(policies.artifactPolicy)},`
      : '',
    policies.queryPolicy
      ? `    queryPolicy: ${renderTsValue(policies.queryPolicy)},`
      : '',
  ].filter(Boolean).join('\n');
  const handlerImports = options.exportHookChannel
    ? 'handlers, reactionHandlers, createExportHookAdapter'
    : 'handlers, reactionHandlers';
  const exportHookAdapterRegistration = options.exportHookChannel
    ? `      adapters.outputs.set(${tsString(options.exportHookChannel)}, createExportHookAdapter());\n`
    : '';
  const syncOutContinuationPolicy = options.syncOutContinuationChannels && options.syncOutContinuationChannels.length > 0
    ? `    syncOutContinuationPolicy: {
      channels: ${renderTsValue(options.syncOutContinuationChannels)},
      maxContinuations: 4,
    },
`
    : '';
  const specLoadSnippet = options.exportHookChannel
    ? `  const { spec: loadedSpec } = loadSpecWithPatterns(specPath);\n  const spec = withDecisionOnlyRegistryPrompts(loadedSpec);\n`
    : `  const { spec } = loadSpecWithPatterns(specPath);\n`;
  const decisionOnlyRegistryPromptHelper = options.exportHookChannel
    ? `

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
`
    : '';
  return `import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import { ${handlerImports} } from './handlers.js';
import { register${pascalName}Tools } from './tools.js';

export function create${pascalName}ProgramEntry(): ProgramEntry {
  const specPath = decodeURIComponent(new URL('./specs.yml', import.meta.url).pathname);
${specLoadSnippet}  const toolRegistry = createToolRegistry();
  register${pascalName}Tools(toolRegistry);

  return {
    spec,
    reactionHandlers,
${syncOutContinuationPolicy}${policyEntries ? `${policyEntries}\n` : ''}    createAdapters: (ctx) => {
      const adapterHandlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
        ...handlers,
      };
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (!toolRegistry.has(name)) continue;
          const actionName = decl.actionName ?? \`invoke_tool_\${name}\`;
          adapterHandlers[actionName] = async () => {
            throw new Error(\`tool adapter for \${name} was not installed\`);
          };
        }
      }
      const adapters = createProgramAdapters(spec, ctx, adapterHandlers);
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (toolRegistry.has(name)) {
            adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name));
          }
        }
      }
${exportHookAdapterRegistration}      return adapters;
    },
  };
}
${decisionOnlyRegistryPromptHelper}
`;
}

function renderTsValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(renderTsValue).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => `${key}: ${renderTsValue(entryValue)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof value === 'string') {
    return tsString(value);
  }
  return JSON.stringify(value);
}
