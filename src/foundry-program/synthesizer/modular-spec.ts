import { dump, load } from 'js-yaml';

export const BLUEPRINT_SPEC_BLOCKS = [
  'identity',
  'domain',
  'lifecycle',
  'channels',
  'actions',
  'guidance',
  'delegation',
  'validation',
  'view',
  'render',
  'policy',
] as const;

export type BlueprintSpecBlock = typeof BLUEPRINT_SPEC_BLOCKS[number];

export interface SynthesizedSpecFile {
  path: string;
  content: string;
}

const BLOCK_KEY_ORDER: Record<BlueprintSpecBlock, readonly string[]> = {
  identity: [
    'name',
    'version',
    'description',
    'kind',
    'metadata',
    'features',
    'pure',
    'disallow_raw_mutation_authoring',
  ],
  domain: [
    'schema',
    'ephemeral',
    'advisory_schema',
    'activation_providers',
    'decision_schema',
    'keyed_collections',
    'merge_collections',
    'derived_paths',
    'derived_state_machines',
    'collection_finalizers',
    'reactions',
    'collection',
    'collections',
  ],
  lifecycle: [
    'modes',
    'initial',
    'terminal',
    'topology',
    'termination',
    'status_on_terminal',
    'proceed_to',
    'notice_terminal_exemptions',
  ],
  channels: [
    'channels',
    'fallback',
    'ingestion',
    'ingestion_guidance',
    'ingestion_root_passthrough',
    'agent_nodes',
    'schedule',
    'command_grammar',
    'control_plane',
    'integrations',
  ],
  actions: [
    'action_map',
    'tools',
    'confirmation_pairing',
  ],
  guidance: [
    'preamble',
    'prompts',
    'guidance',
  ],
  delegation: [
    'delegation',
    'children',
    'requires_delegations',
  ],
  validation: [
    'preconditions',
    'invariants',
    'finalization_requires',
    'finalization_gated_actions',
    'schema_invariants',
    'bounded_rework',
    'recovery_steers',
    'no_action_escapes',
    'repair_bound',
    'invariant',
  ],
  view: [
    'projection',
    'view',
    'initial_crystallize',
  ],
  render: [
    'render',
    'artifact_bundle',
  ],
  policy: [
    'policies',
    'notebook',
  ],
};

const MANIFEST_KEYS = new Set(['import', 'patterns']);
const KEY_TO_BLOCK = new Map<string, BlueprintSpecBlock>(
  BLUEPRINT_SPEC_BLOCKS.flatMap((block) =>
    BLOCK_KEY_ORDER[block].map((key) => [key, block] as const)),
);

export function modularSpecFilesFor(spec: Record<string, unknown>): SynthesizedSpecFile[] {
  const manifestValues = manifestValuesFor(spec);
  const blocks = new Map<BlueprintSpecBlock, Record<string, unknown>>();

  for (const [key, value] of Object.entries(spec)) {
    if (MANIFEST_KEYS.has(key)) {
      continue;
    }
    const block = KEY_TO_BLOCK.get(key);
    if (!block) {
      throw new Error(`cannot modularize synthesized spec: top-level key "${key}" is not mapped to a blueprint block`);
    }
    const target = blocks.get(block) ?? {};
    target[key] = value;
    blocks.set(block, target);
  }

  const importMap: Record<string, string> = {};
  const blockFiles: SynthesizedSpecFile[] = [];
  for (const block of BLUEPRINT_SPEC_BLOCKS) {
    const content = sortedBlockContent(block, blocks.get(block));
    if (!content) {
      continue;
    }
    const path = `${block}.yml`;
    importMap[block] = path;
    blockFiles.push({ path, content: dump(content, yamlOptions()) });
  }

  const manifest = {
    import: importMap,
    ...manifestValues,
  };

  return [
    { path: 'specs.yml', content: dump(manifest, yamlOptions()) },
    ...blockFiles,
  ];
}

export function modularSpecFilesForYamlIfComplete(specYaml: string | undefined): SynthesizedSpecFile[] | undefined {
  if (!specYaml) {
    return undefined;
  }
  const parsed = load(specYaml);
  if (!isRecord(parsed) || !isCompleteSpecificationShape(parsed) || isRecord(parsed.import)) {
    return undefined;
  }
  return modularSpecFilesFor(parsed);
}

export function specBlockFileNames(files: readonly SynthesizedSpecFile[] | undefined): string[] {
  return (files ?? [])
    .map((file) => file.path)
    .filter((path) => path !== 'specs.yml');
}

function sortedBlockContent(
  block: BlueprintSpecBlock,
  content: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!content || Object.keys(content).length === 0) {
    return undefined;
  }

  const known = new Set(BLOCK_KEY_ORDER[block]);
  const out: Record<string, unknown> = {};
  for (const key of BLOCK_KEY_ORDER[block]) {
    if (Object.prototype.hasOwnProperty.call(content, key)) {
      out[key] = content[key];
    }
  }
  for (const [key, value] of Object.entries(content)) {
    if (!known.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

function manifestValuesFor(spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(spec, 'patterns')) {
    out.patterns = spec.patterns;
  }
  return out;
}

function isCompleteSpecificationShape(value: Record<string, unknown>): boolean {
  return isRecord(value.schema)
    && isRecord(value.modes)
    && typeof value.name === 'string'
    && typeof value.initial === 'string'
    && Array.isArray(value.terminal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function yamlOptions(): Parameters<typeof dump>[1] {
  return { lineWidth: -1, noRefs: true, sortKeys: false };
}
