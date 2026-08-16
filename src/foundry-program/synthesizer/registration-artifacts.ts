import type {
  ProgramArtifactPolicy,
  ProgramArtifactRule,
  ProgramDelegationPolicy,
  ProgramEntry,
  ViewSection,
} from '@simodelne/pgas-server/plugin.js';

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
    delegationPolicy?: Required<Pick<ProgramDelegationPolicy, 'allowedTargetPrograms' | 'inputEnrichment'>>;
    delegationResultPolicy?: { fields: Array<{ path: string; key: string }> };
    artifactPolicy?: ProgramArtifactPolicy;
    queryPolicy?: { allowedWorldQueryPrefixes: string[]; mode: 'enforce' };
  } = {},
  options: {
    exportHookChannel?: string;
    syncOutContinuationChannels?: string[];
    renderProfile?: ProgramEntry['renderProfile'];
    viewSections?: readonly ViewSection[];
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
  const viewSupport = renderGeneratedViewSupport(options.viewSections ?? []);
  const renderSupport = renderGeneratedRenderSupport(options.renderProfile);
  const specLoadSnippet = `  const { spec } = ${viewSupport.loader}(specPath);\n`;
  const decisionOnlyRegistryPromptHelper = '';
  return `import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import { ${handlerImports} } from './handlers.js';
import { register${pascalName}Tools } from './tools.js';
${viewSupport.declarations}
${renderSupport.declarations}

export function create${pascalName}ProgramEntry(): ProgramEntry {
  const specPath = decodeURIComponent(new URL('./specs.yml', import.meta.url).pathname);
${specLoadSnippet}  const toolRegistry = createToolRegistry();
  register${pascalName}Tools(toolRegistry);

  return {
    spec,
${viewSupport.entry}
${renderSupport.entry}
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

function renderGeneratedViewSupport(viewSections: readonly ViewSection[]): {
  declarations: string;
  entry: string;
  loader: string;
} {
  if (viewSections.length === 0) {
    return {
      declarations: '',
      entry: '',
      loader: 'loadSpecWithPatterns',
    };
  }

  return {
    declarations: `
const VIEW_PROFILE: ProgramEntry['viewProfile'] = {
  sections: ${renderTsValue(viewSections)},
};
`,
    entry: `    viewProfile: VIEW_PROFILE,\n`,
    loader: 'loadSpecWithPatterns',
  };
}

function renderGeneratedRenderSupport(renderProfile: ProgramEntry['renderProfile'] | undefined): {
  declarations: string;
  entry: string;
} {
  if (!renderProfile) {
    return {
      declarations: '',
      entry: '',
    };
  }

  return {
    declarations: `
const RENDER_PROFILE: ProgramEntry['renderProfile'] = ${renderTsValue(renderProfile)};
`,
    entry: `    renderProfile: RENDER_PROFILE,\n`,
  };
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
