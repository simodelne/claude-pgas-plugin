import { isRecord } from '../util/guards.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import ts from 'typescript';
import type { ViewSection } from '@simodelne/pgas-server/plugin.js';
import type { SynthesisContext } from '../foundry-program/synthesizer-store.js';
import {
  modularSpecFilesForYamlIfComplete,
  specBlockFileNames,
  type SynthesizedSpecFile,
} from '../foundry-program/synthesizer/modular-spec.js';
import {
  assertGeneratedProgramSourceGovernance,
  assertProgramDirPurity,
  type ProgramSourceGovernanceExemption,
} from '../foundry-program/program-purity.js';
import {
  createExistingRepoArtifactPlan,
  createStandaloneArtifactPlan,
  type ArtifactPlan,
  type GeneratedArtifactPlanOptions,
  type PlannedArtifact,
  type ProgramIdentity,
} from './artifact-plan.js';
import { renderControlPlaneControlsYaml } from './control-plane.js';
import {
  renderSimoneOsGovernedAttachCuratorRequest,
  renderSimoneOsGovernedAttachFacts,
  renderSimoneOsGovernedAttachFrontendScenario,
  renderSimoneOsGovernedAttachFrontendSpec,
  renderSimoneOsGovernedAttachProjectionTest,
  renderSimoneOsGovernedAttachProjection,
  renderSimoneOsGovernedAttachRegistration,
  renderSimoneOsGovernedAttachSpecLoadTest,
  renderSimoneOsGovernedAttachSpec,
  type ExistingRepoTargetProfile,
  type SimoneOsGovernedAttachFrontendMode,
} from './governed-attach-profile.js';
import { PGAS_SERVER_VERSION } from './version.js';
import type { WiringManifest } from './wiring-manifest.js';

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../templates/pgas-new');

export type ProgramTemplate = 'pgas-new-foundry';

export interface RenderStandaloneOptions extends ProgramIdentity {
  outDir: string;
  githubOwner?: string;
  githubRepo?: string;
  template?: ProgramTemplate;
  mandate?: string;
  synthesizedCapabilityGaps?: CapabilityGapInput[];
  synthesizedSpecYaml?: string;
  synthesizedSpecFiles?: SynthesizedSpecFileInput[];
  synthesizedRegistrationTs?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
  synthesizedChildArtifacts?: SynthesizedChildSourceInput[];
  synthesizedExportSurfaces?: GeneratedArtifactPlanOptions['exportSurfaces'];
  synthesizedDocumentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
}

export interface RenderExistingRepoOptions extends ProgramIdentity {
  repoRoot: string;
  manifest: WiringManifest;
  stageSlugs?: string[];
  template?: ProgramTemplate;
  mandate?: string;
  requestedArtifactPaths?: string[];
  targetProfile?: ExistingRepoTargetProfile;
  governedAttachFrontendMode?: SimoneOsGovernedAttachFrontendMode;
  synthesizedSpecYaml?: string;
  synthesizedSpecFiles?: SynthesizedSpecFileInput[];
  synthesizedViewSections?: readonly ViewSection[];
  synthesizedSynthesisContext?: SynthesisContext;
  synthesizedRegistrationTs?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
  synthesizedDocumentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
}

export interface RenderResult {
  plan: ArtifactPlan;
  written: string[];
}

interface TemplateSpec {
  file: string;
  tokens: readonly string[];
  substitute?: boolean;
  content?: string;
}

interface SynthesizedSources {
  specYaml?: string;
  specFiles?: SynthesizedSpecFile[];
  viewSections?: readonly ViewSection[];
  registrationTs?: string;
  projectionTs?: string;
  frontendSpecYaml?: string;
  factsYaml?: string;
  frontendScenarioYaml?: string;
  specLoadTestTs?: string;
  projectionTestTs?: string;
  curatorRequestMd?: string;
  contractsTs?: string;
  handlersTs?: string;
  handlersIndexTs?: string;
  stageSources?: Record<string, string>;
  toolsTs?: string;
  smokeTestTs?: string;
  exportSurfaces?: GeneratedArtifactPlanOptions['exportSurfaces'];
  documentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
  capabilityGaps: CapabilityGapInput[];
  childArtifacts: SynthesizedChildSources[];
}

interface CapabilityGapInput {
  capability: string;
  stage: string;
  connector_slug: string;
  message: string;
}

interface SynthesizedChildSourceInput {
  slug: string;
  name: string;
  spec_yaml: string;
  spec_files?: SynthesizedSpecFileInput[];
  registration_ts?: string;
  delegation_result_policy?: DelegationResultPolicyInput;
  contracts_ts: string;
  handlers_ts: string;
  handlers_index_ts: string;
  stage_sources?: Record<string, string>;
  tools_ts: string;
  smoke_test_ts: string;
}

interface SynthesizedChildSources extends SynthesizedSources {
  slug: string;
  name: string;
  delegationResultPolicy?: DelegationResultPolicyInput;
}

interface DelegationResultPolicyInput {
  fields: Array<{ path: string; key: string }>;
}

interface SynthesizedSpecFileInput {
  path: string;
  content: string;
}

interface ResolvedSynthesizedSources extends SynthesizedSources {
  slug: string;
}

interface RenderedArtifact {
  artifact: PlannedArtifact;
  outPath: string;
  output: string;
}

const STANDALONE_TEMPLATE_BY_PATH: Record<string, TemplateSpec> = {
  '.pgas/wiring.yml': spec('repo/.pgas/wiring.yml.tmpl', ['GITHUB_OWNER', 'GITHUB_REPO']),
  '.pgas/pgas-new/{{SLUG}}/dossier.yml': spec('standalone/.pgas/pgas-new/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  '.pgas/pgas-new/{{SLUG}}/artifacts.json': spec('standalone/.pgas/pgas-new/artifacts.json.tmpl', [
    'NAME',
    'PGAS_SERVER_VERSION',
    'SLUG',
  ]),
  'package.json': spec('standalone/package.json.tmpl', ['PGAS_SERVER_VERSION', 'SLUG']),
  'tsconfig.json': spec('standalone/tsconfig.json.tmpl', []),
  'src/server.ts': spec('standalone/src/server.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'src/author-driver.ts': spec('standalone/src/author-driver.ts.tmpl', []),
  'src/repl/index.ts': spec('standalone/src/repl/index.ts.tmpl', ['NAME', 'SLUG']),
  'src/repl/renderer.ts': spec('standalone/src/repl/renderer.ts.tmpl', []),
  'src/programs/{{SLUG}}/specs.yml': spec('program/spec-skeleton.yml.tmpl', ['NAME', 'SLUG']),
  'src/programs/{{SLUG}}/handlers.ts': spec('program/handlers-skeleton.ts.tmpl', []),
  'src/programs/{{SLUG}}/handlers/index.ts': spec('program/handlers-index.ts.tmpl', []),
  'src/programs/{{SLUG}}/handlers/_resolver.ts': spec('program/handlers-resolver.ts.tmpl', []),
  'src/programs/{{SLUG}}/tools.ts': spec('program/tools-skeleton.ts.tmpl', ['PASCAL_NAME']),
  'tests/spec-load.test.ts': spec('tests/spec-load.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/control-plane.test.ts': spec('tests/control-plane.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/program-deterministic.test.ts': spec('tests/program-deterministic.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/api-blackbox.test.ts': spec('tests/api-blackbox.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/live-provider.test.ts': spec('tests/live-provider.test.ts.tmpl', ['SLUG']),
  'audit/PGAS-NEW-GRADUATION.md': spec('audit/PGAS-NEW-GRADUATION.md.tmpl', ['NAME', 'SLUG']),
};

export function renderStandaloneScaffold(options: RenderStandaloneOptions): RenderResult {
  const synthesizedSources = synthesizedSourcesFor(options);
  const basePlan = createStandaloneArtifactPlan(
    { slug: options.slug, name: options.name },
    {
      stageSlugs: Object.keys(synthesizedSources.stageSources ?? {}),
      specBlockFiles: specBlockFileNames(synthesizedSources.specFiles),
      includeSmokeTest: typeof synthesizedSources.smokeTestTs === 'string',
      capabilityGaps: synthesizedSources.capabilityGaps,
      exportSurfaces: synthesizedSources.exportSurfaces,
      documentExtractionSurfaces: synthesizedSources.documentExtractionSurfaces,
    },
  );
  const plan = withSynthesizedChildArtifacts(basePlan, synthesizedSources.childArtifacts);
  assertSupportedTemplate(options.template);

  assertNoExistingArtifacts(options.outDir, plan);

  return renderPlan({
    plan,
    rootDir: options.outDir,
    templateForArtifact: (artifact) => templateForStandaloneArtifact(artifact, options.slug, synthesizedSources),
    tokens: tokensFor(options, plan),
  });
}

export function renderExistingRepoAttachment(options: RenderExistingRepoOptions): RenderResult {
  const synthesizedSources = existingRepoSynthesizedSources(options, profiledSynthesizedSources(options, synthesizedSourcesFor(options)));
  const plan = createExistingRepoArtifactPlan(
    { slug: options.slug, name: options.name },
    options.manifest,
    {
      targetProfile: options.targetProfile,
      governedAttachFrontendMode: options.governedAttachFrontendMode,
      stageSlugs: options.stageSlugs ?? Object.keys(synthesizedSources.stageSources ?? {}),
      specBlockFiles: specBlockFileNames(synthesizedSources.specFiles),
      includeSmokeTest: typeof synthesizedSources.smokeTestTs === 'string',
      documentExtractionSurfaces: synthesizedSources.documentExtractionSurfaces,
      requestedArtifactPaths: options.requestedArtifactPaths,
    },
  );
  assertSupportedTemplate(options.template);

  assertNoExistingArtifacts(options.repoRoot, plan);

  return renderPlan({
    plan,
    rootDir: options.repoRoot,
    templateForArtifact: (artifact) => templateForExistingArtifact(artifact, options.slug, synthesizedSources),
    tokens: tokensFor(options, plan),
  });
}

function profiledSynthesizedSources(options: RenderExistingRepoOptions, sources: SynthesizedSources): SynthesizedSources {
  if (options.targetProfile === undefined) {
    return sources;
  }
  if (options.targetProfile === 'simoneos-governed-attach') {
    if (!options.synthesizedSynthesisContext) {
      throw new Error('simoneos governed attach profile requires synthesizedSynthesisContext');
    }
    const frontendSpecPath = options.governedAttachFrontendMode === 'user-facing'
      ? `${trimRepoRelativePath(options.manifest.paths.programs_dir)}/${options.slug}`
      : undefined;
    return {
      ...sources,
      specYaml: renderSimoneOsGovernedAttachSpec({
        slug: options.slug,
        name: options.name,
        context: options.synthesizedSynthesisContext,
      }),
      specFiles: undefined,
      registrationTs: renderSimoneOsGovernedAttachRegistration({
        slug: options.slug,
        name: options.name,
        frontendSpecPath,
      }),
      projectionTs: renderSimoneOsGovernedAttachProjection({
        slug: options.slug,
        name: options.name,
      }),
      frontendSpecYaml: options.governedAttachFrontendMode === 'user-facing'
        ? renderSimoneOsGovernedAttachFrontendSpec({
            slug: options.slug,
            name: options.name,
          })
        : undefined,
      factsYaml: options.governedAttachFrontendMode === 'user-facing'
        ? renderSimoneOsGovernedAttachFacts({
            slug: options.slug,
            name: options.name,
          })
        : undefined,
      frontendScenarioYaml: options.governedAttachFrontendMode === 'user-facing'
        ? renderSimoneOsGovernedAttachFrontendScenario({
            slug: options.slug,
            name: options.name,
          })
        : undefined,
      specLoadTestTs: renderSimoneOsGovernedAttachSpecLoadTest({
        slug: options.slug,
        name: options.name,
        frontendSpecPath,
      }),
      projectionTestTs: renderSimoneOsGovernedAttachProjectionTest({
        slug: options.slug,
        name: options.name,
      }),
      curatorRequestMd: renderSimoneOsGovernedAttachCuratorRequest({
        slug: options.slug,
        name: options.name,
        frontendSpecPath,
      }),
    };
  }

  const unreachable: never = options.targetProfile;
  throw new Error(`unsupported existing repo target profile: ${unreachable}`);
}

function existingRepoSynthesizedSources(options: RenderExistingRepoOptions, sources: SynthesizedSources): SynthesizedSources {
  // The program lands at <programs_dir>/<slug> in the existing repo. Consumer QC/spec-graph
  // discovery (and the frontend catalog) locate the spec via ProgramEntry.frontendSpecPath,
  // so stamp the repo-relative program directory into the generated registration.
  const frontendSpecPath = `${trimRepoRelativePath(options.manifest.paths.programs_dir)}/${options.slug}`;
  const programDir = frontendSpecPath;
  const registrationTs = sources.registrationTs
    ? options.targetProfile === 'simoneos-governed-attach'
      ? sources.registrationTs
      : injectFrontendSpecPath(sources.registrationTs, frontendSpecPath)
    : sources.registrationTs;

  return {
    ...sources,
    registrationTs,
    toolsTs: sources.toolsTs
      ? rewriteExistingRepoSearchImport(sources.toolsTs, programDir)
      : sources.toolsTs,
    smokeTestTs: sources.smokeTestTs
      ? rewriteSmokeTestRegistrationImport(
          sources.smokeTestTs,
          options.slug,
          existingRepoProgramRegistrationImport(options.manifest, options.slug),
        )
      : sources.smokeTestTs,
  };
}

function rewriteExistingRepoSearchImport(source: string, programDir: string): string {
  const importPath = existingRepoSearchImport(programDir);
  return source.replaceAll('../../../libraries/search/index.js', importPath);
}

function existingRepoSearchImport(programDir: string): string {
  const importPath = posix.relative(programDir, 'libraries/search/index.js');
  return importPath.startsWith('.') ? importPath : `./${importPath}`;
}

function injectFrontendSpecPath(registrationTs: string, frontendSpecPath: string): string {
  if (registrationTs.includes('frontendSpecPath:')) return registrationTs;
  const anchor = 'return {\n    spec,\n';
  if (!registrationTs.includes(anchor)) {
    throw new Error('unable to patch frontendSpecPath into existing-repo registration; ProgramEntry return shape changed');
  }
  return registrationTs.replace(anchor, `return {\n    spec,\n    frontendSpecPath: ${JSON.stringify(frontendSpecPath)},\n`);
}

function existingRepoProgramRegistrationImport(manifest: WiringManifest, slug: string): string {
  const programsDir = trimRepoRelativePath(manifest.paths.programs_dir);
  const registrationPath = posix.join(programsDir, slug, 'registration.js');
  let relativePath = posix.relative('tests', registrationPath);
  if (!relativePath.startsWith('.')) {
    relativePath = `./${relativePath}`;
  }
  return relativePath;
}

function rewriteSmokeTestRegistrationImport(source: string, slug: string, registrationImportPath: string): string {
  const standaloneImportPath = `../src/programs/${slug}/registration.js`;
  if (!source.includes(standaloneImportPath)) {
    throw new Error(`generated smoke test missing standalone registration import: ${standaloneImportPath}`);
  }
  return source.replaceAll(standaloneImportPath, registrationImportPath);
}

function assertNoExistingArtifacts(rootDir: string, plan: ArtifactPlan): void {
  const collisions = plan.artifacts
    .filter((artifact) => (artifact.writeMode ?? 'create') === 'create')
    .map((artifact) => artifact.path)
    .filter((path) => existsSync(join(rootDir, path)));

  if (collisions.length > 0) {
    throw new Error(`refusing to overwrite existing attach artifacts:\n${collisions.join('\n')}`);
  }
}

export function renderTemplate(
  source: string,
  tokens: Record<string, string>,
  options: { allowUnusedTokens?: boolean } = {},
): string {
  const required = new Set([...source.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1]));
  for (const token of required) {
    if (!(token in tokens)) {
      throw new Error(`missing template token: ${token}`);
    }
  }

  for (const token of Object.keys(tokens)) {
    if (!options.allowUnusedTokens && !required.has(token)) {
      throw new Error(`unused template token: ${token}`);
    }
  }

  let rendered = source;
  for (const token of required) {
    rendered = rendered.replaceAll(`{{${token}}}`, tokens[token]);
  }

  if (/\{\{[^}]+\}\}/.test(rendered)) {
    throw new Error('unrendered template token remains');
  }

  return rendered;
}

function renderPlan(options: {
  plan: ArtifactPlan;
  rootDir: string;
  templateForArtifact: (artifact: PlannedArtifact) => TemplateSpec | undefined;
  tokens: Record<string, string>;
}): RenderResult {
  const written: string[] = [];
  const renderedArtifacts: RenderedArtifact[] = [];

  assertProgramDirPurity(options.plan.artifacts);

  for (const artifact of options.plan.artifacts) {
    const templatePath = options.templateForArtifact(artifact);
    if (!templatePath) {
      throw new Error(`no template for artifact path: ${artifact.path}`);
    }

    const source = templatePath.content ?? readFileSync(join(TEMPLATE_ROOT, templatePath.file), 'utf8');
    const rendered = templatePath.substitute === false
      ? renderDirectSource(source)
      : renderTemplate(source, selectTokens(options.tokens, templatePath.tokens));
    const outPath = join(options.rootDir, artifact.path);
    const output = renderArtifactWriteContent({
      artifact,
      rendered,
      outPath,
      tokens: options.tokens,
    });
    renderedArtifacts.push({ artifact, outPath, output });
  }

  assertNoDuplicateRenderedHandlerBodies(renderedArtifacts);
  assertGeneratedProgramSourceGovernance(
    renderedArtifacts.map(({ artifact, output }) => ({
      path: artifact.path,
      kind: artifact.kind,
      sourceText: output,
    })),
    { onUnavoidableExemption: logUnavoidableGovernanceExemption },
  );

  for (const { artifact, outPath, output } of renderedArtifacts) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output);
    written.push(artifact.path);
  }

  return { plan: options.plan, written };
}

function logUnavoidableGovernanceExemption(exemption: ProgramSourceGovernanceExemption): void {
  console.warn(
    `[program-governance] exempted ${exemption.governedArtifactKind} findings in ${exemption.path}: ${exemption.findingKinds.join(', ')}`,
  );
}

function templateForExistingArtifact(
  artifact: PlannedArtifact,
  slug: string,
  synthesizedSources: SynthesizedSources,
): TemplateSpec | undefined {
  const synthesizedTemplate = templateForSynthesizedArtifact(artifact, slug, synthesizedSources);
  if (synthesizedTemplate) {
    return synthesizedTemplate;
  }
  const existingStageTemplate = templateForExistingStageArtifact(artifact, slug);
  if (existingStageTemplate) {
    return existingStageTemplate;
  }
  const handlerDirectoryTemplate = templateForHandlerDirectoryArtifact(artifact, slug);
  if (handlerDirectoryTemplate) {
    return handlerDirectoryTemplate;
  }

  return templateForFoundryArtifact(artifact, slug);
}

function templateForFoundryArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  if (artifact.kind === 'spec') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/specs.yml'];
  }
  if (artifact.kind === 'registration') {
    return inlineTemplate(renderAttachedRegistrationSource(slug));
  }
  if (artifact.kind === 'handler') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers.ts'];
  }
  if (artifact.kind === 'tool') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/tools.ts'];
  }
  if (artifact.kind === 'dossier') {
    return STANDALONE_TEMPLATE_BY_PATH['.pgas/pgas-new/{{SLUG}}/dossier.yml'];
  }
  if (artifact.kind === 'metadata') {
    return spec('consumer/artifacts.json.tmpl', ['ARTIFACT_PATHS_JSON', 'NAME', 'PGAS_SERVER_VERSION', 'SLUG']);
  }
  if (artifact.kind === 'audit') {
    return STANDALONE_TEMPLATE_BY_PATH['audit/PGAS-NEW-GRADUATION.md'];
  }
  const existingUserFacingTemplate = templateForExistingUserFacingArtifact(artifact, slug);
  if (existingUserFacingTemplate) {
    return existingUserFacingTemplate;
  }

  return templateForStandalonePath(artifact.path, slug);
}

function templateForExistingStageArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  const stageMatch = artifact.path.match(new RegExp(`/${slug}/stages/([^/]+)\\.ts$`, 'u'));
  const stage = stageMatch?.[1];
  if (artifact.kind !== 'stage' || !stage) {
    return undefined;
  }

  return inlineTemplate(renderMinimalStageSource(stage));
}

function templateForExistingUserFacingArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  const path = artifact.path;
  if (path.endsWith(`/${slug}/projection.ts`)) {
    return spec('consumer/projection.ts.tmpl', ['CAMEL_NAME', 'PASCAL_NAME', 'SLUG']);
  }
  if (path.endsWith(`/${slug}/frontend.spec.yml`)) {
    return spec('consumer/frontend.spec.yml.tmpl', ['NAME', 'SLUG']);
  }
  if (path.endsWith(`/${slug}/export/html.ts`)) {
    return spec('consumer/export-html.ts.tmpl', ['NAME']);
  }
  if (path.endsWith(`/${slug}/export/docx.ts`)) {
    return spec('consumer/export-docx.ts.tmpl', ['NAME']);
  }
  if (path.endsWith(`/${slug}/extract/docx.ts`)) {
    return spec('consumer/extract-docx.ts.tmpl', []);
  }
  if (path.endsWith(`/${slug}/export/diff.ts`)) {
    return spec('consumer/export-diff.ts.tmpl', []);
  }
  if (path === `tests/${slug}-deterministic.test.ts`) {
    return spec('consumer/deterministic.test.ts.tmpl', ['CAMEL_NAME', 'SLUG']);
  }
  if (path === `qc/e2e-frontend/${slug}.scenario.yml`) {
    return spec('consumer/e2e-frontend.scenario.yml.tmpl', ['SLUG']);
  }
  if (path === `qc/facts/${slug}.facts.yml`) {
    return spec('consumer/facts.yml.tmpl', ['SLUG']);
  }
  if (path === 'qc/e2e-coverage.yml') {
    return inlineTemplate(defaultE2eCoverageYaml(slug));
  }
  return undefined;
}

function templateForStandaloneArtifact(
  artifact: PlannedArtifact,
  slug: string,
  synthesizedSources: SynthesizedSources,
): TemplateSpec | undefined {
  if (artifact.path === 'README.md' && synthesizedSources.capabilityGaps.length > 0) {
    return inlineTemplate(renderCapabilityGapReadme(slug, synthesizedSources.capabilityGaps));
  }
  if (artifact.path === 'audit/PGAS-NEW-GRADUATION.md' && synthesizedSources.capabilityGaps.length > 0) {
    return inlineTemplate(renderCapabilityGapGraduationAudit(slug, synthesizedSources.capabilityGaps));
  }
  if (artifact.path === 'src/server.ts' && synthesizedSources.childArtifacts.length > 0) {
    return inlineTemplate(renderMultiProgramServerSource(slug, synthesizedSources.childArtifacts));
  }
  if (artifact.path === 'tests/program-deterministic.test.ts' && synthesizedSources.childArtifacts.length > 0) {
    return inlineTemplate(renderMultiProgramDeterministicTestSource(slug, synthesizedSources.childArtifacts));
  }
  const synthesizedTemplate = templateForSynthesizedArtifact(artifact, slug, synthesizedSources);
  if (synthesizedTemplate) {
    return synthesizedTemplate;
  }
  const handlerDirectoryTemplate = templateForHandlerDirectoryArtifact(artifact, slug);
  if (handlerDirectoryTemplate) {
    return handlerDirectoryTemplate;
  }

  return templateForStandalonePath(artifact.path, slug);
}

function assertSupportedTemplate(template: ProgramTemplate | undefined): void {
  const value = template as string | undefined;
  if (!value || value === 'pgas-new-foundry') {
    return;
  }

  throw new Error(
    `invalid --template: ${value}. In v3.0, the template selector is reserved for legacy foundry bootstrap only. ` +
      'For per-domain programs, run the bare `pgas-new` REPL and walk the foundry design interview.',
  );
}

function templateForStandalonePath(path: string, slug: string): TemplateSpec | undefined {
  if (path === `.pgas/pgas-new/${slug}/dossier.yml`) {
    return STANDALONE_TEMPLATE_BY_PATH['.pgas/pgas-new/{{SLUG}}/dossier.yml'];
  }
  if (path === `.pgas/pgas-new/${slug}/artifacts.json`) {
    return STANDALONE_TEMPLATE_BY_PATH['.pgas/pgas-new/{{SLUG}}/artifacts.json'];
  }
  if (path === `src/programs/${slug}/specs.yml`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/specs.yml'];
  }
  if (path === `src/programs/${slug}/handlers.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers.ts'];
  }
  if (path === `src/programs/${slug}/handlers/index.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers/index.ts'];
  }
  if (path === `src/programs/${slug}/handlers/_resolver.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers/_resolver.ts'];
  }
  if (path === `src/programs/${slug}/tools.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/tools.ts'];
  }
  if (path === `src/programs/${slug}/connectors/web-navigation.ts`) {
    return inlineTemplate(renderCombinedConsumerTemplate(
      'web-navigation-connector.ts.tmpl',
      'web-navigation-mock.ts.tmpl',
      './web-navigation-connector.js',
    ));
  }
  if (path === `src/programs/${slug}/connectors/persistence.ts`) {
    return inlineTemplate(renderCombinedConsumerTemplate(
      'persistence-connector.ts.tmpl',
      'persistence-mock.ts.tmpl',
      './persistence-connector.js',
    ));
  }
  if (path === `src/programs/${slug}/connectors/pdf-report.ts`) {
    return inlineTemplate(renderCombinedConsumerTemplate(
      'pdf-report-connector.ts.tmpl',
      'pdf-report-mock.ts.tmpl',
      './pdf-report-connector.js',
    ));
  }
  if (path === `src/programs/${slug}/export/html.ts`) {
    return spec('consumer/export-html.ts.tmpl', ['NAME']);
  }
  if (path === `src/programs/${slug}/export/docx.ts`) {
    return spec('consumer/export-docx.ts.tmpl', ['NAME']);
  }
  if (path === `src/programs/${slug}/extract/docx.ts`) {
    return spec('consumer/extract-docx.ts.tmpl', []);
  }
  if (path === `src/programs/${slug}/export/diff.ts`) {
    return spec('consumer/export-diff.ts.tmpl', []);
  }

  return STANDALONE_TEMPLATE_BY_PATH[path];
}

function spec(file: string, tokens: readonly string[]): TemplateSpec {
  return { file, tokens };
}

function inlineTemplate(content: string): TemplateSpec {
  return { file: '', tokens: [], content, substitute: false };
}

function renderCombinedConsumerTemplate(
  contractTemplate: string,
  mockTemplate: string,
  mockTypeImport: string,
): string {
  const contractSource = readConsumerTemplate(contractTemplate).trimEnd();
  const mockSource = removeLeadingTypeImport(readConsumerTemplate(mockTemplate), mockTypeImport).trimStart();
  return ensureTrailingNewline(`${contractSource}\n\n${mockSource}`);
}

function readConsumerTemplate(template: string): string {
  return readFileSync(join(TEMPLATE_ROOT, 'consumer', template), 'utf8');
}

function removeLeadingTypeImport(source: string, importSpecifier: string): string {
  const escapedSpecifier = importSpecifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const importPattern = new RegExp(`^import type [\\s\\S]+? from '${escapedSpecifier}';\\n\\n?`, 'u');
  if (!importPattern.test(source)) {
    throw new Error(`mock connector template missing leading type import from ${importSpecifier}`);
  }
  return source.replace(importPattern, '');
}

function renderArtifactWriteContent(options: {
  artifact: PlannedArtifact;
  rendered: string;
  outPath: string;
  tokens: Record<string, string>;
}): string {
  if ((options.artifact.writeMode ?? 'create') !== 'update') {
    return options.rendered;
  }

  if (options.artifact.path === 'qc/e2e-coverage.yml') {
    const existing = existsSync(options.outPath) ? readFileSync(options.outPath, 'utf8') : options.rendered;
    return mergeE2eCoverageYaml(existing, options.tokens.SLUG);
  }

  return options.rendered;
}

function defaultE2eCoverageYaml(slug: string): string {
  return renderStructuredE2eCoverageYaml({ version: 1 }, slug);
}

function mergeE2eCoverageYaml(source: string, slug: string): string {
  const document = parseE2eCoverageYaml(source);
  const textMerged = mergeE2eCoverageText(source, document, slug);
  if (textMerged) {
    return textMerged;
  }

  return renderStructuredE2eCoverageYaml(document, slug);
}

function parseE2eCoverageYaml(source: string): Record<string, unknown> {
  if (source.trim().length === 0) {
    return {};
  }

  const parsed = load(source);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isRecord(parsed)) {
    throw new Error('qc/e2e-coverage.yml must contain a YAML mapping');
  }
  return parsed;
}

function renderStructuredE2eCoverageYaml(document: Record<string, unknown>, slug: string): string {
  const userFacing = sortedUniqueStrings([...coverageUserFacingPrograms(document.user_facing_programs), slug]);
  const programs = sortRecord({
    ...coveragePrograms(document.programs),
    [slug]: e2eCoverageProgramEntry(slug),
  });
  const next = {
    ...document,
    user_facing_programs: userFacing,
    programs,
  };

  return ensureTrailingNewline(dump(next, { lineWidth: -1, noRefs: true, sortKeys: false }));
}

function mergeE2eCoverageText(source: string, document: Record<string, unknown>, slug: string): string | undefined {
  if (!Array.isArray(document.user_facing_programs) || !document.user_facing_programs.every((value) => typeof value === 'string')) {
    return undefined;
  }
  if (!isRecord(document.programs)) {
    return undefined;
  }

  let lines = stripOneTrailingNewline(source).split('\n');
  if (!document.user_facing_programs.includes(slug)) {
    const merged = insertYamlListItem(lines, 'user_facing_programs', slug);
    if (!merged) return undefined;
    lines = merged;
  }
  if (!Object.prototype.hasOwnProperty.call(document.programs, slug)) {
    const merged = insertCoverageProgramEntry(lines, slug);
    if (!merged) return undefined;
    lines = merged;
  }

  return ensureTrailingNewline(lines.join('\n'));
}

function insertYamlListItem(lines: string[], key: string, value: string): string[] | undefined {
  const block = findTopLevelBlock(lines, key);
  if (!block || lines[block.start].trim() !== `${key}:`) {
    return undefined;
  }

  const next = [...lines];
  const entries: Array<{ index: number; value: string }> = [];
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = /^  - ([^\s#][^#]*?)(?:\s+#.*)?$/u.exec(next[index]);
    if (match?.[1]) {
      entries.push({ index, value: match[1].trim() });
    }
  }

  const firstGreater = entries.find((entry) => entry.value.localeCompare(value) > 0);
  const insertAt = firstGreater?.index ?? (entries.at(-1)?.index ?? block.start) + 1;
  next.splice(insertAt, 0, `  - ${value}`);
  return next;
}

function insertCoverageProgramEntry(lines: string[], slug: string): string[] | undefined {
  const block = findTopLevelBlock(lines, 'programs');
  if (!block || lines[block.start].trim() !== 'programs:') {
    return undefined;
  }

  const next = [...lines];
  const entries: Array<{ index: number; slug: string }> = [];
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = /^  ([a-z0-9]+(?:-[a-z0-9]+)*):\s*(?:#.*)?$/u.exec(next[index]);
    if (match?.[1]) {
      entries.push({ index, slug: match[1] });
    }
  }

  const firstGreater = entries.find((entry) => entry.slug.localeCompare(slug) > 0);
  let insertAt = firstGreater?.index ?? block.end;
  if (!firstGreater) {
    while (insertAt > block.start + 1) {
      const previous = next[insertAt - 1].trim();
      if (previous.length !== 0 && !previous.startsWith('#')) {
        break;
      }
      insertAt -= 1;
    }
  }

  next.splice(insertAt, 0, ...coverageProgramEntryLines(slug));
  return next;
}

function coverageProgramEntryLines(slug: string): string[] {
  return [
    '',
    `  ${slug}:`,
    `    facts: qc/facts/${slug}.facts.yml`,
    '    e2e-frontend:',
    '      channels: [frontend]',
    '      required: true',
  ];
}

function findTopLevelBlock(lines: string[], key: string): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => line.trim() === `${key}:` || line.startsWith(`${key}: `));
  if (start < 0) {
    return undefined;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelYamlKey(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function isTopLevelYamlKey(line: string): boolean {
  return /^[A-Za-z0-9_-]+:\s*(?:.*)?$/u.test(line);
}

function coverageUserFacingPrograms(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }
  throw new Error('qc/e2e-coverage.yml user_facing_programs must be a string array when present');
}

function coveragePrograms(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (Array.isArray(value) && value.length === 0) {
    return {};
  }
  if (isRecord(value)) {
    return value;
  }
  throw new Error('qc/e2e-coverage.yml programs must be a mapping or an empty array');
}

function e2eCoverageProgramEntry(slug: string): Record<string, unknown> {
  return {
    facts: `qc/facts/${slug}.facts.yml`,
    'e2e-frontend': {
      channels: ['frontend'],
      required: true,
    },
  };
}

function sortedUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function stripOneTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function trimRepoRelativePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

const ATTACHED_PROJECTION_MIGRATION_REMAINING_KEYS = [
  'program_title',
  'program_slug',
  'mode',
  'status_banner',
  'phase_steps',
  'workspace_checkpoints',
  'workspace_metadata',
  'pricing_cards',
  'fee_model',
  'risk_adjustment',
  'scope_summary',
  'assumptions_summary',
  'pricing_options',
  'recommended_option',
  'pricing_rationale',
  'proposal_preview_html',
  'proposal_outline',
  'review_status',
  'export_actions',
  'signature_page',
  'payment_terms',
  'composer_placeholder',
] as const;

function renderAttachedRegistrationSource(slug: string, viewSections: readonly ViewSection[] = []): string {
  const source = readFileSync(join(TEMPLATE_ROOT, 'consumer/registration-attached.ts.tmpl'), 'utf8');
  return renderTemplate(source, {
    CAMEL_NAME: toCamelCase(slug),
    LOAD_SPEC_SNIPPET: '  const { spec } = loadSpecWithPatterns(specPath);\n',
    PASCAL_NAME: toPascalCase(slug),
    SLUG: slug,
    ...attachedViewSupportTokens(viewSections),
  });
}

function attachedViewSupportTokens(viewSections: readonly ViewSection[]): Record<string, string> {
  if (viewSections.length === 0) {
    return {
      VIEW_PROFILE_ENTRY: '',
      VIEW_SUPPORT_DECLARATIONS: '',
      VIEW_SUPPORT_IMPORTS: '',
    };
  }
  return {
    VIEW_PROFILE_ENTRY: `    viewProfile: VIEW_PROFILE,
    projectionBuilderMigration: {
      trackingIssue: 'docs/ENGINE-DECLARATION-CATALOG.md#declarative-projection',
      remainingKeys: ${renderTsValue([...ATTACHED_PROJECTION_MIGRATION_REMAINING_KEYS])},
    },
`,
    VIEW_SUPPORT_DECLARATIONS: `
const VIEW_PROFILE: ProgramEntry['viewProfile'] = {
  sections: ${renderTsValue(viewSections)},
};
`,
    VIEW_SUPPORT_IMPORTS: '',
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

function tsString(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

function templateForSynthesizedArtifact(
  artifact: PlannedArtifact,
  slug: string,
  synthesizedSources: SynthesizedSources,
): TemplateSpec | undefined {
  const selected = synthesizedSourcesForArtifact(artifact.path, slug, synthesizedSources);
  if (!selected?.specYaml && !selected?.specFiles) {
    return undefined;
  }
  const specFile = synthesizedSpecFileForArtifact(artifact.path, selected);
  if (specFile) {
    return inlineTemplate(specFile.content);
  }
  if (artifact.path.endsWith(`/${selected.slug}/specs.yml`) && selected.specYaml) {
    return inlineTemplate(selected.specYaml);
  }
  if (artifact.path.endsWith(`/${selected.slug}/registration.ts`)) {
    if (selected.registrationTs) {
      return inlineTemplate(selected.registrationTs);
    }
    return inlineTemplate(renderAttachedRegistrationSource(selected.slug, selected.viewSections ?? []));
  }
  if (artifact.path.endsWith(`/${selected.slug}/projection.ts`) && selected.projectionTs) {
    return inlineTemplate(selected.projectionTs);
  }
  if (artifact.path.endsWith(`/${selected.slug}/frontend.spec.yml`) && selected.frontendSpecYaml) {
    return inlineTemplate(selected.frontendSpecYaml);
  }
  if (artifact.path === `qc/facts/${selected.slug}.facts.yml` && selected.factsYaml) {
    return inlineTemplate(selected.factsYaml);
  }
  if (artifact.path === `qc/e2e-frontend/${selected.slug}.scenario.yml` && selected.frontendScenarioYaml) {
    return inlineTemplate(selected.frontendScenarioYaml);
  }
  if (artifact.path.endsWith(`/${selected.slug}/__tests__/spec-load.test.ts`) && selected.specLoadTestTs) {
    return inlineTemplate(selected.specLoadTestTs);
  }
  if (artifact.path.endsWith(`/${selected.slug}/__tests__/projection.test.ts`) && selected.projectionTestTs) {
    return inlineTemplate(selected.projectionTestTs);
  }
  if (artifact.path === `audit/PGAS-NEW-${selected.slug}.curator-request.md` && selected.curatorRequestMd) {
    return inlineTemplate(selected.curatorRequestMd);
  }
  if (artifact.path.endsWith(`/${selected.slug}/contracts.ts`) && selected.contractsTs) {
    return inlineTemplate(selected.contractsTs);
  }
  if (artifact.path.endsWith(`/${selected.slug}/handlers.ts`) && selected.handlersTs) {
    return inlineTemplate(selected.handlersTs);
  }
  if (artifact.path.endsWith(`/${selected.slug}/handlers/index.ts`)) {
    if (selected.handlersTs && selected.handlersIndexTs) {
      assertNoDuplicateHandlerBodies(selected.handlersTs, selected.handlersIndexTs, artifact.path);
    }
    return inlineTemplate(renderHandlersIndexBarrelSource());
  }
  const stageMatch = artifact.path.match(new RegExp(`/${selected.slug}/stages/([^/]+)\\.ts$`, 'u'));
  if (stageMatch?.[1] && selected.stageSources?.[stageMatch[1]]) {
    return inlineTemplate(selected.stageSources[stageMatch[1]]);
  }
  if (artifact.path.endsWith(`/${selected.slug}/tools.ts`) && selected.toolsTs) {
    return inlineTemplate(selected.toolsTs);
  }
  if (artifact.path === 'tests/generated-program-smoke.test.ts' && selected.smokeTestTs) {
    return inlineTemplate(selected.smokeTestTs);
  }
  return undefined;
}

function synthesizedSpecFileForArtifact(
  artifactPath: string,
  selected: ResolvedSynthesizedSources,
): SynthesizedSpecFile | undefined {
  return selected.specFiles?.find((file) =>
    artifactPath.endsWith(`/${selected.slug}/${file.path}`));
}

function synthesizedSourcesForArtifact(
  artifactPath: string,
  primarySlug: string,
  sources: SynthesizedSources,
): ResolvedSynthesizedSources | undefined {
  if (artifactPath === 'tests/generated-program-smoke.test.ts') {
    return { ...sources, slug: primarySlug };
  }
  if (artifactPath === `audit/PGAS-NEW-${primarySlug}.curator-request.md`) {
    return { ...sources, slug: primarySlug };
  }
  if (
    artifactPath === `qc/facts/${primarySlug}.facts.yml`
    || artifactPath === `qc/e2e-frontend/${primarySlug}.scenario.yml`
  ) {
    return { ...sources, slug: primarySlug };
  }
  if (artifactPathBelongsToProgram(artifactPath, primarySlug)) {
    return { ...sources, slug: primarySlug };
  }
  return sources.childArtifacts.find((child) =>
    artifactPathBelongsToProgram(artifactPath, child.slug));
}

function artifactPathBelongsToProgram(artifactPath: string, slug: string): boolean {
  return artifactPath.includes(`/${slug}/`) || artifactPath.startsWith(`${slug}/`);
}

function withSynthesizedChildArtifacts(plan: ArtifactPlan, children: SynthesizedChildSources[]): ArtifactPlan {
  if (children.length === 0) {
    return plan;
  }
  return {
    ...plan,
    artifacts: uniquePlannedArtifacts([
      ...plan.artifacts,
      ...children.flatMap(childProgramArtifacts),
    ]),
  };
}

function childProgramArtifacts(child: SynthesizedChildSources): PlannedArtifact[] {
  const slug = child.slug;
  const stageSlugs = Object.keys(child.stageSources ?? {});
  return [
    plannedArtifact('spec', `src/programs/${slug}/specs.yml`, 'Declare synthesized delegated child PGAS program spec.', 'branch_write', [
      'spec-load',
    ]),
    ...specBlockFileNames(child.specFiles).map((fileName) =>
      plannedArtifact('spec', `src/programs/${slug}/${fileName}`, `Declare delegated child modular PGAS spec ${fileName} fragment.`, 'branch_write', [
        'spec-load',
      ])),
    ...(stageSlugs.length > 0
      ? [
          plannedArtifact('contract', `src/programs/${slug}/contracts.ts`, 'Declare delegated child stage contracts.', 'domain_synthesis', [
            'typecheck',
          ]),
          ...stageSlugs.map((stageSlug) =>
            plannedArtifact('stage', `src/programs/${slug}/stages/${stageSlug}.ts`, `Implement delegated child stage ${stageSlug}.`, 'domain_synthesis', [
              'typecheck',
            ])),
        ]
      : []),
    plannedArtifact('handler', `src/programs/${slug}/handlers.ts`, 'Implement delegated child handlers and reactions.', 'branch_write', [
      'typecheck',
    ]),
    plannedArtifact('handler', `src/programs/${slug}/handlers/index.ts`, 'Expose delegated child handlers from the handler directory.', 'branch_write', [
      'typecheck',
    ]),
    plannedArtifact('handler', `src/programs/${slug}/handlers/_resolver.ts`, 'Resolve delegated child handler values from payload or state.', 'branch_write', [
      'typecheck',
    ]),
    plannedArtifact('tool', `src/programs/${slug}/tools.ts`, 'Declare delegated child action metadata.', 'branch_write', [
      'typecheck',
    ]),
  ];
}

function plannedArtifact(
  kind: PlannedArtifact['kind'],
  path: string,
  purpose: string,
  mode_introduced: PlannedArtifact['mode_introduced'],
  verification: string[],
): PlannedArtifact {
  return {
    kind,
    path,
    purpose,
    owner: 'pgas-new',
    mode_introduced,
    verification,
  };
}

function uniquePlannedArtifacts(artifacts: PlannedArtifact[]): PlannedArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.path)) {
      return false;
    }
    seen.add(artifact.path);
    return true;
  });
}

function renderCapabilityGapReadme(slug: string, gaps: readonly CapabilityGapInput[]): string {
  return `# ${slug}

This PGAS program was generated by pgas-new.

## Capability Gaps

${gaps.map((gap) => `- ${gap.capability} (${gap.stage}): ${gap.message}`).join('\n')}
`;
}

function renderCapabilityGapGraduationAudit(slug: string, gaps: readonly CapabilityGapInput[]): string {
  return `# ${slug} PGAS-New Graduation

Program: \`${slug}\`

Static verification is required before live verification. Final graduation requires a real provider round trip through the external API and must not be inferred from deterministic tests.

## Capability Gaps

${gaps.map((gap) => `- ${gap.capability} (${gap.stage}): ${gap.message}`).join('\n')}

## Evidence

- Static verification: pending
- API black-box verification: pending
- Live provider verification: pending
- Post-rebase verification: pending
- Pull request: pending
`;
}

interface ConventionProgramSource {
  slug: string;
  delegationResultPolicy?: DelegationResultPolicyInput;
}

function renderConventionProgramImports(programs: ConventionProgramSource[], programImportRoot: string): string {
  return programs.flatMap(({ slug }) => {
    const pascal = toPascalCase(slug);
    const camel = toCamelCase(slug);
    return [
      `import { createHandlerAdapterOverrides as create${pascal}HandlerAdapterOverrides, handlers as ${camel}Handlers, reactionHandlers as ${camel}ReactionHandlers } from '${programImportRoot}/${slug}/handlers.js';`,
      `import { registeredToolNames as ${camel}RegisteredToolNames, register${pascal}Tools } from '${programImportRoot}/${slug}/tools.js';`,
    ];
  }).join('\n');
}

function renderConventionProgramHelpers(programs: ConventionProgramSource[], programsRootExpression: string): string {
  const entryFactories = programs.map((program) => {
    const pascal = toPascalCase(program.slug);
    const camel = toCamelCase(program.slug);
    const entryOverrides = program.delegationResultPolicy
      ? `, ${renderTsValue({ delegationResultPolicy: program.delegationResultPolicy })}`
      : '';
    return `function create${pascal}ProgramEntry(): ProgramEntry {
  return createConventionProgramEntry(
    '${program.slug}',
    ${camel}Handlers,
    ${camel}ReactionHandlers,
    register${pascal}Tools,
    ${camel}RegisteredToolNames,
    create${pascal}HandlerAdapterOverrides${entryOverrides},
  );
}`;
  }).join('\n\n');

  return `const programsRoot = ${programsRootExpression};

type ToolRegistryInstance = ReturnType<typeof createToolRegistry>;
type RegisterTools = (registry: ToolRegistryInstance) => void;
type HandlerAdapterOverrides = () => Record<string, ProgramAdapterOverride>;

${entryFactories}

function createConventionProgramEntry(
  name: string,
  handlers: Record<string, ToolHandler>,
  reactionHandlers: Map<string, ReactionHandler>,
  registerTools: RegisterTools,
  registeredToolNames: readonly string[],
  createHandlerAdapterOverrides: HandlerAdapterOverrides,
  entryOverrides?: RegisterProgramByConventionOptions['entryOverrides'],
): ProgramEntry {
  const toolRegistry = createToolRegistry();
  registerTools(toolRegistry);
  const loaded = loadProgramByConvention(name, {
    programsRoot,
    additionalHandlers: {
      ...handlers,
      ...toolHandlerPlaceholders(toolRegistry, registeredToolNames),
    },
    reactionHandlers,
    adapterOptions: {
      overrides: {
        ...createHandlerAdapterOverrides(),
        ...toolAdapterOverrides(toolRegistry, registeredToolNames),
      },
    },
    ...(entryOverrides ? { entryOverrides } : {}),
  });
  return { ...loaded.entry, spec: withDecisionOnlyRegistryPrompts(loaded.entry.spec) };
}

function toolHandlerPlaceholders(toolRegistry: ToolRegistryInstance, registeredToolNames: readonly string[]): Record<string, ToolHandler> {
  const placeholders: Record<string, ToolHandler> = {};
  for (const name of registeredToolNames) {
    if (!toolRegistry.has(name)) continue;
    placeholders[\`invoke_tool_\${name}\`] = async () => {
      throw new Error(\`tool adapter for \${name} was not installed\`);
    };
  }
  return placeholders;
}

function toolAdapterOverrides(toolRegistry: ToolRegistryInstance, registeredToolNames: readonly string[]): Record<string, ProgramAdapterOverride> {
  const overrides: Record<string, ProgramAdapterOverride> = {};
  for (const name of registeredToolNames) {
    if (toolRegistry.has(name)) {
      overrides[\`tool:\${name}\`] = toolRegistry.createAdapter(name);
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
}`;
}

function renderMultiProgramServerSource(primarySlug: string, children: SynthesizedChildSources[]): string {
  const programSources = [
    { slug: primarySlug },
    ...children.map((child) => ({ slug: child.slug, delegationResultPolicy: child.delegationResultPolicy })),
  ];
  const imports = renderConventionProgramImports(programSources, './programs');
  const helpers = renderConventionProgramHelpers(programSources, "decodeURIComponent(new URL('.', import.meta.url).pathname)");
  const programs = programSources
    .map(({ slug }) => `{ name: '${slug}', entry: create${toPascalCase(slug)}ProgramEntry() }`)
    .join(',\n    ');
  return `import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import {
  createToolRegistry,
  loadProgramByConvention,
  type ProgramAdapterOverride,
  type ProgramEntry,
  type ReactionHandler,
  type RegisterProgramByConventionOptions,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { resolveAuthorDrivers } from './author-driver.js';
${imports}

${helpers}

// Opt-in unified native-tools author driver (PGAS_AUTHOR_DRIVER=unified).
// Default (env unset): \`drivers\` is undefined, no \`drivers\` key is passed,
// and the engine boots its legacy JSON author path exactly as before.
const drivers = resolveAuthorDrivers();

const server = await createPgasServer({
  programs: [
    ${programs},
  ],
  devMode: process.env.PGAS_DEV_MODE === '1',
  ...(drivers ? { drivers } : {}),
});

await server.start();
`;
}

function renderMultiProgramDeterministicTestSource(primarySlug: string, children: SynthesizedChildSources[]): string {
  const programSources = [
    { slug: primarySlug },
    ...children.map((child) => ({ slug: child.slug, delegationResultPolicy: child.delegationResultPolicy })),
  ];
  const imports = renderConventionProgramImports(programSources, '../src/programs');
  const helpers = renderConventionProgramHelpers(programSources, "decodeURIComponent(new URL('../src', import.meta.url).pathname)");
  const programs = programSources
    .map(({ slug }) => `{ name: '${slug}', entry: create${toPascalCase(slug)}ProgramEntry() }`)
    .join(',\n      ');
  return `import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createToolRegistry,
  loadProgramByConvention,
  type ProgramAdapterOverride,
  type ProgramEntry,
  type ReactionHandler,
  type RegisterProgramByConventionOptions,
  type Specification,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
${imports}

${helpers}

interface Snapshot {
  mode: string | null;
  status: string | null;
  domain: Record<string, unknown>;
  rounds: unknown[];
}

interface FieldSpec {
  name: string;
  type: string;
}

interface TerminalActionExample {
  name: string;
  channel?: string;
}

describe('${primarySlug} deterministic runtime', () => {
  it('drives the program through a deterministic trigger path', async () => {
    const programEntries: Array<{ name: string; entry: ProgramEntry }> = [
      ${programs},
    ];
    const primary = programEntries[0];
    if (!primary) {
      throw new Error('deterministic route test missing primary program entry');
    }

    const server = await createPgasServer({
      programs: programEntries,
      drivers: {
        authorHandle: deterministicAuthor(actionChannelsFor(programEntries.map((program) => program.entry.spec))),
        observerHandle: {
          modelId: 'generated-deterministic-route-observer',
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
      const created = await client.sessions.create({ program: ${JSON.stringify(primarySlug)} });
      const snapshot = await driveToTerminal(client, created.sessionId, firstInputChannel(primary.entry.spec), primary.entry.spec);

      expect(isTerminalSnapshot(snapshot, primary.entry.spec)).toBe(true);
      expect(snapshot.mode === null || primary.entry.spec.terminal.includes(snapshot.mode)).toBe(true);
      expect(snapshot.rounds.length).toBeGreaterThan(0);
      expect(hasFallbackRound(snapshot.rounds)).toBe(false);
    } finally {
      await server.close();
    }
  });
});

async function driveToTerminal(
  client: PgasClient,
  sessionId: string,
  inputChannel: string,
  spec: Specification,
): Promise<Snapshot> {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const snapshot = await readSnapshot(client, sessionId);
    if (isTerminalSnapshot(snapshot, spec)) {
      return snapshot;
    }

    if (isDecisionOnlyMode(spec, snapshot.mode)) {
      await delayTick();
      const afterAuto = await readSnapshot(client, sessionId);
      if (afterAuto.mode !== snapshot.mode || isTerminalSnapshot(afterAuto, spec)) {
        continue;
      }
      throw new Error(\`decision_only mode did not auto-advance: \${String(snapshot.mode)}\`);
    }

    try {
      await client.sessions.trigger(sessionId, {
        channel: inputChannel,
        payload: attempt === 0 ? 'start deterministic scaffold' : 'continue deterministic scaffold',
      });
    } catch (error) {
      if (!String((error as Error).message).includes('terminal')) {
        throw error;
      }
      return readSnapshot(client, sessionId);
    }
  }
  const stalled = await readSnapshot(client, sessionId);
  throw new Error(\`deterministic route did not reach a terminal mode; stopped in \${String(stalled.mode)}\`);
}

function deterministicAuthor(actionChannels: Map<string, string>) {
  const appendedActions = new Set<string>();
  return {
    modelId: 'generated-deterministic-route-author',
    async complete(prompt: string) {
      // pgas#993: a keyed record_array field is appended ONE element per call
      // through a repeatable append action before the stage's terminal completion
      // (a keyed MAppend upserts a single element by key). Emit each such append
      // once (idempotent upsert-by-key) so the keyed collection is populated for
      // downstream stages, then fall through to the terminal action.
      const append = pendingAppendAction(prompt, appendedActions);
      if (append) {
        appendedActions.add(append.name);
        const appendChannel = actionChannels.get(append.name) ?? 'widget_output';
        return JSON.stringify(effect(append.name, appendPayloadFor(append.arg), appendChannel));
      }
      const example = terminalExample(prompt);
      const channel = example.channel ?? actionChannels.get(example.name) ?? 'widget_output';
      return JSON.stringify(effect(example.name, payloadFor(example.name, channel, prompt), channel));
    },
  };
}

function pendingAppendAction(prompt: string, appended: ReadonlySet<string>): { name: string; arg: string } | undefined {
  // Match the active stage's keyed record_array append guidance:
  // "call <append_action> once for EACH <label> (each upserted into <collection> by <key> ...".
  // This guidance is present only while the owning reasoning stage is active, so it
  // does not fire for later stages that merely reference the collection in history.
  const pattern = /call (append_[A-Za-z0-9_]+) once for EACH [A-Za-z0-9_]+ \\(each upserted into ([A-Za-z0-9_.]+) by/gu;
  for (const match of prompt.matchAll(pattern)) {
    const name = match[1];
    const collection = match[2];
    if (name && collection && !appended.has(name)) {
      const arg = collection.split('.').pop() ?? name;
      return { name, arg };
    }
  }
  return undefined;
}

function appendPayloadFor(arg: string): Record<string, unknown> {
  const sample = sampleResultValue({ name: arg, type: 'record_array' });
  const record = Array.isArray(sample) ? (sample[0] ?? {}) : sample;
  return { [arg]: record };
}

function terminalExample(prompt: string): TerminalActionExample {
  const examples = terminalExamples(prompt);
  if (examples.length === 0) {
    throw new Error('deterministic author could not find a terminal action in prompt: ' + prompt.slice(0, 500));
  }
  const rejected = rejectedActions(prompt);
  const candidates = examples.filter((example) => !rejected.has(example.name));
  const viable = candidates.length > 0 ? candidates : examples;
  const request = viable.find((example) => example.name.startsWith('request_'));
  if (request && shouldPreferRequestAction(prompt, rejected, request.name)) {
    return request;
  }
  const selected = viable[0] ?? examples[0];
  if (!selected) {
    throw new Error('deterministic author could not select a terminal action');
  }
  return selected;
}

function terminalExamples(prompt: string): TerminalActionExample[] {
  const examples: TerminalActionExample[] = [];
  const seen = new Set<string>();
  const add = (example: TerminalActionExample): void => {
    if (seen.has(example.name)) {
      return;
    }
    seen.add(example.name);
    examples.push(example);
  };

  const jsonPattern = /Valid terminal action JSON example:\\s*\\{"actions":\\[\\{"kind":"EffectAction","name":"([^"]+)","channel":"([^"]+)","payload":\\{\\}\\}\\]\\}/gu;
  for (const match of prompt.matchAll(jsonPattern)) {
    if (match[1]) {
      add({ name: match[1], ...(match[2] ? { channel: match[2] } : {}) });
    }
  }
  const callPattern = /call ([A-Za-z_][A-Za-z0-9_]*) as the single native tool_call/gu;
  for (const match of prompt.matchAll(callPattern)) {
    if (match[1]) {
      add({ name: match[1] });
    }
  }
  return examples;
}

function rejectedActions(prompt: string): Set<string> {
  const rejected = new Set<string>();
  const rejectionPattern = /(?:Action|action) "([^"]+)"[^\\n]*(?:not|invalid|precondition|reject|fail)/gu;
  for (const match of prompt.matchAll(rejectionPattern)) {
    if (match[1]) {
      rejected.add(match[1]);
    }
  }
  return rejected;
}

function shouldPreferRequestAction(prompt: string, rejected: ReadonlySet<string>, actionName: string): boolean {
  if (rejected.has(actionName)) {
    return false;
  }
  if (hasCompletedFanOut(prompt)) {
    return false;
  }
  return prompt.includes('.fan_out.') ||
    prompt.includes('delegation') ||
    prompt.includes('target_spec');
}

function hasCompletedFanOut(prompt: string): boolean {
  return /"[^"]+\\.fan_out\\.complete"\\s*:\\s*true/u.test(prompt);
}

function payloadFor(action: string, channel: string, prompt: string): Record<string, unknown> {
  const expectsEmptyPayload = prompt.includes('EMPTY payload');
  const payload: Record<string, unknown> = {};
  if (action === 'begin_work') {
    return payload;
  }
  if (action.startsWith('request_')) {
    payload.request = {
      intent: 'deterministic',
      source: 'https://example.com/deterministic',
      allowed_domains: ['example.com'],
    };
    return payload;
  }

  const fields = resultFieldsFromPrompt(prompt);
  if (fields.length > 0) {
    const result = Object.fromEntries(fields.map((field) => [field.name, sampleResultValue(field)]));
    payload.result_json = JSON.stringify(result);
    payload.items_json = JSON.stringify([deterministicItemFor(action, result)]);
    for (const field of fields) {
      payload[field.name] = sampleArgumentValue(field);
    }
  } else if (!expectsEmptyPayload) {
    payload.result_json = JSON.stringify({ stage: action, status: 'deterministic' });
    payload.items_json = JSON.stringify([action]);
  }

  if (channel === 'stage_output' && !expectsEmptyPayload) {
    payload.__stage_runtime = {
      now_iso: '2026-06-28T00:00:00.000Z',
      random: 0.25,
    };
  }
  return payload;
}

function resultFieldsFromPrompt(prompt: string): FieldSpec[] {
  const markers = [
    'result_json must be a JSON object containing at least:',
    'Populate every declared result field directly:',
  ];
  const marker = markers.find((candidate) => prompt.includes(candidate));
  const start = marker ? prompt.indexOf(marker) : -1;
  if (start < 0) {
    return [];
  }
  const afterMarker = prompt.slice(start + marker!.length);
  const period = afterMarker.indexOf('.');
  const sentence = period >= 0 ? afterMarker.slice(0, period) : afterMarker;
  const fields: FieldSpec[] = [];
  const fieldPattern = /([A-Za-z_][A-Za-z0-9_]*)\\s+\\(([^)]*)\\)/gu;
  for (const match of sentence.matchAll(fieldPattern)) {
    if (match[1] && match[2]) {
      fields.push({ name: match[1], type: match[2].toLowerCase() });
    }
  }
  return fields;
}

function sampleResultValue(field: FieldSpec): unknown {
  if (field.name === 'leads') {
    return [sampleLead()];
  }
  if (field.name === 'items') {
    return [{ title: 'Deterministic item', email: 'lead@example.com', url: 'https://example.com/deterministic' }];
  }
  if (field.name === 'audit') {
    return [{ action: 'fetch', url: 'https://example.com/deterministic', status: 'ok' }];
  }
  if (field.type.includes('number') || /(?:count|total|score|visited|rounds)$/u.test(field.name)) {
    return 1;
  }
  if (field.type.includes('boolean')) {
    return true;
  }
  if (field.type.includes('array') || field.name.endsWith('s')) {
    return [\`\${field.name}-sample\`];
  }
  if (field.name === 'status') {
    return 'complete';
  }
  if (field.name === 'source' || field.name.endsWith('_url')) {
    return 'https://example.com/deterministic';
  }
  if (field.name.includes('email')) {
    return 'lead@example.com';
  }
  return \`\${field.name}-sample\`;
}

function sampleArgumentValue(field: FieldSpec): unknown {
  const value = sampleResultValue(field);
  if (field.type.includes('record_array')) {
    return value;
  }
  return Array.isArray(value) || (value && typeof value === 'object')
    ? JSON.stringify(value)
    : value;
}

function sampleLead(): Record<string, unknown> {
  return {
    name: 'Deterministic Lead',
    role: 'Director',
    company: 'Example Co',
    email: 'lead@example.com',
    profile_url: 'https://example.com/deterministic',
    notes: 'Generated deterministic lead fixture.',
    relevance_score: 1,
  };
}

function deterministicItemFor(action: string, result: Record<string, unknown>): string {
  if (typeof result.email === 'string') {
    return \`\${action}:\${result.email}\`;
  }
  return \`\${action}:deterministic\`;
}

function actionChannelsFor(specs: Specification[]): Map<string, string> {
  const channels = new Map<string, string>();
  for (const spec of specs) {
    for (const [name, action] of spec.action_map) {
      channels.set(name, action.channel ?? 'widget_output');
    }
  }
  return channels;
}

function firstInputChannel(spec: Specification): string {
  let fallback: string | undefined;
  for (const [id, channel] of spec.schannels) {
    if (channel.direction !== 'In') {
      continue;
    }
    fallback ??= id;
    if (id !== 'seed' && id !== 'system_query_result' && id !== 'system_mode_entry') {
      return id;
    }
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(\`program \${spec.name} declares no input channel\`);
}

function isDecisionOnlyMode(spec: Specification, modeName: string | null): boolean {
  if (!modeName) {
    return false;
  }
  const mode = spec.modes.get(modeName) as { decision_only?: boolean } | undefined;
  return mode?.decision_only === true;
}

function isTerminalSnapshot(snapshot: Snapshot, spec: Specification): boolean {
  return !!snapshot.mode && spec.terminal.includes(snapshot.mode) ||
    String(snapshot.status ?? '').toLowerCase() === 'completed' ||
    String(snapshot.status ?? '').toLowerCase() === 'complete';
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<Snapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    status: firstString(envelope.status, state?.status),
    domain: world.domain as Record<string, unknown>,
    rounds: Array.isArray(state?.rounds) ? state.rounds : [],
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function effect(name: string, payload: Record<string, unknown>, channel: string) {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function hasFallbackRound(rounds: unknown[]): boolean {
  return rounds.some((round) => {
    if (!round || typeof round !== 'object' || Array.isArray(round)) return false;
    const result = (round as { result?: unknown }).result;
    return !!result && typeof result === 'object' && !Array.isArray(result) &&
      (result as { fallback?: unknown }).fallback === true;
  });
}

function delayTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
`;
}

function templateForHandlerDirectoryArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  void slug;
  if (artifact.path.endsWith('/handlers/index.ts')) {
    return spec('program/handlers-index.ts.tmpl', []);
  }
  if (artifact.path.endsWith('/handlers/_resolver.ts')) {
    return spec('program/handlers-resolver.ts.tmpl', []);
  }
  return undefined;
}

function renderHandlersIndexBarrelSource(): string {
  return "export { handlers, reactionHandlers } from '../handlers.js';\n";
}

function assertNoDuplicateRenderedHandlerBodies(renderedArtifacts: RenderedArtifact[]): void {
  const byProgramDir = new Map<string, { primary?: RenderedArtifact; index?: RenderedArtifact }>();
  for (const rendered of renderedArtifacts) {
    const path = rendered.artifact.path;
    if (!path.endsWith('/handlers.ts') && !path.endsWith('/handlers/index.ts')) {
      continue;
    }
    const key = path.endsWith('/handlers.ts')
      ? path.slice(0, -'/handlers.ts'.length)
      : path.slice(0, -'/handlers/index.ts'.length);
    const entry = byProgramDir.get(key) ?? {};
    if (path.endsWith('/handlers.ts')) {
      entry.primary = rendered;
    } else {
      entry.index = rendered;
    }
    byProgramDir.set(key, entry);
  }

  for (const entry of byProgramDir.values()) {
    if (entry.primary && entry.index) {
      assertNoDuplicateHandlerBodies(entry.primary.output, entry.index.output, entry.index.artifact.path);
    }
  }
}

function assertNoDuplicateHandlerBodies(primarySource: string, indexSource: string, indexPath: string): void {
  const primaryBodies = new Set(handlerFunctionBodies(primarySource));
  if (primaryBodies.size === 0) {
    return;
  }
  for (const body of handlerFunctionBodies(indexSource)) {
    if (primaryBodies.has(body)) {
      throw new Error(`duplicate generated handler implementation in ${indexPath}; handlers/index.ts must re-export handlers.ts`);
    }
  }
}

function handlerFunctionBodies(source: string): string[] {
  const sourceFile = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.body) {
      bodies.push(normalizeFunctionBody(node.body.getText(sourceFile)));
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer)) &&
      ts.isBlock(node.initializer.body)
    ) {
      bodies.push(normalizeFunctionBody(node.initializer.body.getText(sourceFile)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bodies;
}

function normalizeFunctionBody(body: string): string {
  return body.replace(/\s+/gu, ' ').trim();
}

function renderMinimalStageSource(stage: string): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: ${JSON.stringify(`${stage}_ready`)}, at: runtime.now() }),
    items_json: JSON.stringify([${JSON.stringify(`${stage}:ready`)}]),
    digest: '',
  };
}
`;
}


function renderDirectSource(source: string): string {
  if (/\{\{[A-Z0-9_]+\}\}/u.test(source)) {
    throw new Error('foundry program source must not contain template tokens');
  }

  return source;
}

function selectTokens(tokens: Record<string, string>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => {
      const value = tokens[name];
      if (value === undefined) {
        throw new Error(`template token not in pool: ${name}`);
      }
      return [name, value];
    }),
  );
}

function synthesizedSourcesFor(options: {
  synthesizedSpecYaml?: string;
  synthesizedSpecFiles?: SynthesizedSpecFileInput[];
  synthesizedViewSections?: readonly ViewSection[];
  synthesizedRegistrationTs?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
  synthesizedExportSurfaces?: GeneratedArtifactPlanOptions['exportSurfaces'];
  synthesizedDocumentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
  synthesizedCapabilityGaps?: CapabilityGapInput[];
  synthesizedChildArtifacts?: SynthesizedChildSourceInput[];
}): SynthesizedSources {
  const specFiles = synthesizedSpecFilesFor(options.synthesizedSpecYaml, options.synthesizedSpecFiles);
  return {
    specYaml: options.synthesizedSpecYaml,
    specFiles,
    viewSections: options.synthesizedViewSections ?? [],
    registrationTs: options.synthesizedRegistrationTs,
    projectionTs: undefined,
    frontendSpecYaml: undefined,
    factsYaml: undefined,
    frontendScenarioYaml: undefined,
    curatorRequestMd: undefined,
    contractsTs: options.synthesizedContractsTs,
    handlersTs: options.synthesizedHandlersTs,
    handlersIndexTs: options.synthesizedHandlersIndexTs,
    stageSources: options.synthesizedStageSources,
    toolsTs: options.synthesizedToolsTs,
    smokeTestTs: options.synthesizedSmokeTestTs,
    exportSurfaces: options.synthesizedExportSurfaces,
    documentExtractionSurfaces: options.synthesizedDocumentExtractionSurfaces,
    capabilityGaps: options.synthesizedCapabilityGaps ?? [],
    childArtifacts: (options.synthesizedChildArtifacts ?? []).map((child) => ({
      slug: child.slug,
      name: child.name,
      delegationResultPolicy: child.delegation_result_policy,
      specYaml: child.spec_yaml,
      specFiles: synthesizedSpecFilesFor(child.spec_yaml, child.spec_files),
      viewSections: [],
      registrationTs: child.registration_ts,
      projectionTs: undefined,
      frontendSpecYaml: undefined,
      factsYaml: undefined,
      frontendScenarioYaml: undefined,
      curatorRequestMd: undefined,
      contractsTs: child.contracts_ts,
      handlersTs: child.handlers_ts,
      handlersIndexTs: child.handlers_index_ts,
      stageSources: child.stage_sources,
      toolsTs: child.tools_ts,
      smokeTestTs: child.smoke_test_ts,
      capabilityGaps: [],
      childArtifacts: [],
    })),
  };
}

function synthesizedSpecFilesFor(
  specYaml: string | undefined,
  files: readonly SynthesizedSpecFileInput[] | undefined,
): SynthesizedSpecFile[] | undefined {
  if (files && files.length > 0) {
    return files.map((file) => ({
      path: file.path,
      content: file.content,
    }));
  }
  return modularSpecFilesForYamlIfComplete(specYaml);
}

function tokensFor(options: ProgramIdentity & { githubOwner?: string; githubRepo?: string; mandate?: string }, plan: ArtifactPlan): Record<string, string> {
  return {
    ARTIFACT_PATHS_JSON: JSON.stringify(plan.artifacts.map((artifact) => artifact.path), null, 2),
    GITHUB_OWNER: options.githubOwner ?? 'simodelne',
    GITHUB_REPO: options.githubRepo ?? options.slug,
    MANDATE: options.mandate ?? defaultMandate(options.name),
    NAME: options.name,
    CAMEL_NAME: toCamelCase(options.slug),
    PASCAL_NAME: toPascalCase(options.slug),
    PGAS_SERVER_VERSION,
    SLUG: options.slug,
    CONTROL_PLANE_CONTROLS_YAML: renderControlPlaneControlsYaml(options.slug),
  };
}

function defaultMandate(name: string): string {
  return `${name} program generated by pgas-new. Replace this mandate with the approved intake dossier before live graduation.`;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return `${pascal[0]?.toLowerCase() ?? ''}${pascal.slice(1)}`;
}
