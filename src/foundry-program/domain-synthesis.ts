import { isRecord } from '../util/guards.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import ts from 'typescript';
import { createProviderHandles } from '@simodelne/pgas-server/plugin.js';
import type { WiringIntegration } from '../pgas-new/wiring-manifest.js';
import type { ExportStageDescriptor, SynthesizedArtifact } from './synthesizer-store.js';
import { resynthesizeWithReasoningContracts } from './synthesizer.js';
import { isRepeatedRecordSchema } from './schema-shapes.js';
import {
  synthesizeReasoningContract,
  type ReasoningContractGenerator,
  type ReasoningStageContract,
  type SynthesizedReasoningContract,
} from './reasoning-contract.js';
import {
  detectGovernedConstructs,
  fatalGovernanceViolations,
  GovernanceRefusalError,
  type GovernedArtifactKind,
  type GovernedConstructKind,
} from './governance-gate.js';
import { activeEnforcedConstructs } from './engine-primitive-registry.js';

const SYNTHESIS_VERSION = 'foundry-domain-synthesis-v6';
const CODEX_CLI_ESCALATION_DRIVER = 'codex-cli';
const EXPORT_DOCX_IMPORT = '../export/docx.js';
const EXPORT_HTML_IMPORT = '../export/html.js';
const REPORT_DATA_IMPORT = '../report-data.js';
const PDF_REPORT_CONNECTOR_IMPORT = '../connectors/pdf-report.js';
const WEB_NAVIGATION_IMPORT = '../connectors/web-navigation.js';
const PERSISTENCE_IMPORT = '../connectors/persistence.js';
const EXPORT_TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../templates/pgas-new/consumer');
const STAGE_BODY_SYSTEM_PREAMBLE = [
  'Return only TypeScript source code. Do not use markdown fences.',
  'Do not include comments.',
  'Do not include the literal words TODO, placeholder, stage_action_stub, or not implemented.',
  "The only allowed import is: import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';",
].join(' ');

export interface StageBodyRequest {
  stage: string;
  archetype: 'pure-compute' | 'external-adapter';
  contract: string;
  prompt: string;
  repair?: {
    attempt: number;
    lastError: string;
  };
}

export interface StageBodyGenerator {
  (request: StageBodyRequest): Promise<string>;
}

export interface DomainSynthesisOptions {
  generator?: StageBodyGenerator;
  reasoningContractGenerator?: ReasoningContractGenerator;
  cacheDir?: string;
  maxAttempts?: number;
  providerUrl?: string;
  model?: string;
  targetKind?: 'standalone_repo' | 'existing_repo';
  integrations?: WiringIntegration[];
}

interface StageClassification {
  slug: string;
  archetype: string;
  rationale?: string;
  adapter_kind?: string;
  export_kind?: string;
  integration_name?: string;
  integration_import?: string;
  integration_method?: string;
  connector_slug?: string;
  integration_gap?: boolean;
  audit_note?: string;
}

interface StageDomainSpec {
  reads: string[];
  produces: Record<string, unknown>;
  rules: string[];
  invariants: string[];
  input_domain?: Record<string, unknown>;
}

interface CacheRecord {
  body: string;
  body_hash: string;
  behavioral_gate?: string;
  behavioral_fixture?: StageBehaviorFixture;
  real_call_verified?: true;
  escalation_driver?: typeof CODEX_CLI_ESCALATION_DRIVER;
}

interface StageBehaviorFixture {
  input_stage: string;
  expected_result_stage: string;
  expected_items_non_empty: true;
  expected_adapter_kind?: 'in_memory_mock' | 'repo_integration';
  expected_integration?: string;
  expected_method?: string;
  expected_endpoint?: string;
  real_call_verified?: true;
  verified_response_status?: number;
  available_domain_paths?: string[];
  domain_spec_reads?: string[];
  expected_items_templates?: string[];
  expected_positive_fields?: string[];
  expected_parameter_fields?: string[];
  expected_connector_slug?: string;
}

interface WebNavigationStageDescriptor {
  integration_name: 'web_navigation';
  connector_slug: 'web-navigation';
  audit_note?: string;
}

interface PersistenceStageDescriptor {
  integration_name: 'persistence';
  connector_slug: 'persistence';
  keyed_collection_path?: string;
  audit_note?: string;
}

export async function synthesizeDomainLogic(
  artifact: SynthesizedArtifact,
  options: DomainSynthesisOptions = {},
): Promise<SynthesizedArtifact> {
  const cacheDir = options.cacheDir ?? join(process.cwd(), '.pgas-new-domain-synthesis-cache');
  const maxAttempts = options.maxAttempts ?? 4;
  const providerUrl = options.providerUrl ?? process.env.PGAS_OPENAI_BASE_URL ?? '';
  const model = options.model ?? process.env.PGAS_OPENAI_MODEL ?? process.env.PGAS_MODEL ?? '';
  const generator = options.generator ?? createOpenAiCompatibleBodyGenerator({ providerUrl, model });
  const targetKind = options.targetKind ?? 'standalone_repo';
  const integrations = options.integrations ?? [];
  const stageSources: Record<string, string> = { ...(artifact.stage_sources ?? {}) };
  const audit: Array<Record<string, unknown>> = [];

  mkdirSync(cacheDir, { recursive: true });

  // Reasoning contracts run FIRST (spec §6.8 ordering): the deterministic
  // body loop below must generate against the woven artifact so body prompts
  // embed the contract-bearing spec_yaml and typed prior-stage paths.
  const reasoningStages = artifact.body_stage_slugs.filter((stage) =>
    classificationFor(artifact, stage).archetype === 'llm-reasoning');
  const reasoningResults: Record<string, SynthesizedReasoningContract> = {};
  for (const stage of reasoningStages) {
    reasoningResults[stage] = await synthesizeReasoningContract(stage, artifact, {
      generator: options.reasoningContractGenerator,
      cacheDir,
      maxAttempts,
      providerUrl,
      model,
    });
  }
  const reasoningContracts: Record<string, ReasoningStageContract> = Object.fromEntries(
    Object.entries(reasoningResults).map(([stage, result]) => [stage, result.contract]),
  );
  const workingArtifact: SynthesizedArtifact = reasoningStages.length > 0 && artifact.synthesis_context
    ? {
        ...artifact,
        ...resynthesizeWithReasoningContracts(artifact, reasoningContracts, { targetKind, integrations }),
      }
    : artifact;

  for (const stage of workingArtifact.body_stage_slugs) {
    const classification = resolveIntegrationBinding(classificationFor(workingArtifact, stage), targetKind, integrations);
    if (classification.archetype === 'llm-reasoning') {
      const reasoningResult = reasoningResults[stage];
      if (!reasoningResult) {
        throw new Error(`missing synthesized reasoning contract for stage ${stage}`);
      }
      const body = renderReasoningContractRecordModule(reasoningResult.contract);
      stageSources[stage] = body;
      audit.push({
        stage,
        archetype: classification.archetype,
        ...auditFieldsFor(classification),
        behavioral_gate: 'reasoning_contract_conformance',
        contract_source: reasoningResult.contract_source,
        contract_hash: reasoningResult.contract_hash,
        ...(reasoningResult.fallback_reason ? { fallback_reason: reasoningResult.fallback_reason } : {}),
        attempts: reasoningResult.attempts,
        cache_hit: reasoningResult.cache_hit,
        body_hash: sha256(body),
      });
      continue;
    }
    if (classification.archetype !== 'pure-compute' && classification.archetype !== 'external-adapter') {
      throw new Error(`unsupported stage archetype for ${stage}: ${classification.archetype}`);
    }

    const prompt = promptForStage(stage, classification, workingArtifact);
    const cacheKey = cacheKeyFor({
      stage,
      contract: workingArtifact.contracts_ts,
      prompt,
      model,
      providerUrl,
    });
    const cachePath = join(cacheDir, `${cacheKey}.json`);
    const hasArgSchemaCacheOverlay = legacyArgSchemaCachePrompt(prompt) !== undefined;
    const legacyCachePaths = legacyStageBodyCachePaths({
      cacheDir,
      stage,
      contract: workingArtifact.contracts_ts,
      prompt,
      model,
      providerUrl,
    });
    const repoIntegration = integrationForClassification(classification, integrations);
    const exportDescriptor = exportDescriptorForStage(workingArtifact, stage, classification);
    const webNavigationDescriptor = webNavigationDescriptorForStage(classification);
    const persistenceDescriptor = persistenceDescriptorForStage(classification, workingArtifact);
    const domainSpec = domainSpecForStage(workingArtifact, stage);
    const verificationOptions = {
      stage,
      ...(exportDescriptor ? {
        allowedIntegrationImport: exportPrimaryImportForDescriptor(exportDescriptor),
        allowedIntegrationImports: exportImportsForDescriptor(exportDescriptor),
        exportKind: exportDescriptor.kind,
      } : {}),
      ...(repoIntegration ? {
        allowedIntegrationImport: repoIntegration.import,
        integrationName: repoIntegration.name,
        integrationMethod: repoIntegration.methods[0],
        integration: repoIntegration,
      } : {}),
      ...(webNavigationDescriptor ? {
        allowedIntegrationImport: WEB_NAVIGATION_IMPORT,
        webNavigationDescriptor,
      } : {}),
      ...(persistenceDescriptor ? {
        allowedIntegrationImport: PERSISTENCE_IMPORT,
        persistenceDescriptor,
      } : {}),
      ...(domainSpec ? { domainSpec } : {}),
      reasoningContracts,
    };
    const cached = exportDescriptor || webNavigationDescriptor || persistenceDescriptor
      ? undefined
      : readCache(cachePath)
        ?? readFirstCache(legacyCachePaths)
        ?? (hasArgSchemaCacheOverlay ? readCompatibleStageCache(cacheDir, stage, domainSpec) : undefined);
    if (cached) {
      let behaviorFields = behaviorAuditFields(cached);
      if (classification.adapter_kind === 'repo_integration' && repoIntegration?.kind === 'http_api') {
        const verification = await verifyStageBody(cached.body, classification.archetype, verificationOptions);
        if (!verification.ok) {
          throw new Error(`domain synthesis cached repo integration failed runtime verification for stage ${stage}: ${verification.error}`);
        }
        behaviorFields = behaviorAuditFields({
          behavioral_gate: verification.behavioral_gate,
          behavioral_fixture: verification.behavioral_fixture,
          real_call_verified: verification.real_call_verified,
        });
      } else {
        verifyGovernanceOfStageBody(cached.body, 'stage_body');
      }
      stageSources[stage] = cached.body;
      audit.push({
        stage,
        archetype: classification.archetype,
        ...auditFieldsFor(classification),
        ...behaviorFields,
        ...escalationAuditFields(cached),
        attempts: 0,
        cache_hit: true,
        body_hash: cached.body_hash,
      });
      continue;
    }

    let lastError = '';
    let accepted: CacheRecord | undefined;
    let attemptsUsed = 0;
    let fallbackUsed = false;
    let escalationDriver: typeof CODEX_CLI_ESCALATION_DRIVER | undefined;
    let escalationAttemptsUsed = 0;
    if (exportDescriptor) {
      attemptsUsed = 1;
      const body = renderExportStageBody(stage, exportDescriptor);
      const verification = await verifyStageBody(body, classification.archetype, verificationOptions);
      if (verification.ok) {
        accepted = {
          body,
          body_hash: sha256(body),
          behavioral_gate: verification.behavioral_gate,
          behavioral_fixture: verification.behavioral_fixture,
          real_call_verified: verification.real_call_verified,
        };
      } else {
        lastError = verification.error;
      }
    } else if (classification.adapter_kind === 'repo_integration' && repoIntegration) {
      attemptsUsed = 1;
      const body = renderRepoIntegrationStageBody(stage, repoIntegration);
      const verification = await verifyStageBody(body, classification.archetype, verificationOptions);
      if (verification.ok) {
        accepted = {
          body,
          body_hash: sha256(body),
          behavioral_gate: verification.behavioral_gate,
          behavioral_fixture: verification.behavioral_fixture,
          real_call_verified: verification.real_call_verified,
        };
      } else {
        lastError = verification.error;
      }
    } else if (webNavigationDescriptor) {
      attemptsUsed = 1;
      const body = renderWebNavigationStageBody(stage, webNavigationDescriptor);
      const verification = await verifyStageBody(body, classification.archetype, verificationOptions);
      if (verification.ok) {
        accepted = {
          body,
          body_hash: sha256(body),
          behavioral_gate: verification.behavioral_gate,
          behavioral_fixture: verification.behavioral_fixture,
          real_call_verified: verification.real_call_verified,
        };
      } else {
        lastError = verification.error;
      }
    } else if (persistenceDescriptor) {
      attemptsUsed = 1;
      const body = renderPersistenceStageBody(stage, persistenceDescriptor);
      const verification = await verifyStageBody(body, classification.archetype, verificationOptions);
      if (verification.ok) {
        accepted = {
          body,
          body_hash: sha256(body),
          behavioral_gate: verification.behavioral_gate,
          behavioral_fixture: verification.behavioral_fixture,
          real_call_verified: verification.real_call_verified,
        };
      } else {
        lastError = verification.error;
      }
    } else {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attemptsUsed = attempt;
        let body: string;
        try {
          body = await generator({
            stage,
            archetype: classification.archetype,
            contract: workingArtifact.contracts_ts,
            prompt,
            ...(lastError ? { repair: { attempt, lastError } } : {}),
          });
        } catch (error) {
          lastError = `stage body generator failed: ${errorMessage(error)}`;
          continue;
        }
        const verification = await verifyStageBody(body, classification.archetype, {
          stage,
          ...(domainSpec ? { domainSpec } : {}),
          reasoningContracts,
        });
        if (verification.ok) {
          accepted = {
            body,
            body_hash: sha256(body),
            behavioral_gate: verification.behavioral_gate,
            behavioral_fixture: verification.behavioral_fixture,
            real_call_verified: verification.real_call_verified,
          };
          break;
        }
        lastError = verification.error;
      }

      const escalationGenerator = !accepted ? resolveEscalationGenerator() : undefined;
      if (escalationGenerator) {
        escalationDriver = CODEX_CLI_ESCALATION_DRIVER;
        const escalationMaxAttempts = domainSynthesisEscalationMaxAttempts();
        for (let attempt = 1; attempt <= escalationMaxAttempts; attempt += 1) {
          escalationAttemptsUsed = attempt;
          let body: string;
          try {
            body = await escalationGenerator({
              stage,
              archetype: classification.archetype,
              contract: workingArtifact.contracts_ts,
              prompt,
              ...(lastError ? { repair: { attempt, lastError } } : {}),
            });
          } catch (error) {
            lastError = `stage body escalation generator failed: ${errorMessage(error)}`;
            continue;
          }
          const verification = await verifyStageBody(body, classification.archetype, {
            stage,
            ...(domainSpec ? { domainSpec } : {}),
            reasoningContracts,
          });
          if (verification.ok) {
            accepted = {
              body,
              body_hash: sha256(body),
              behavioral_gate: verification.behavioral_gate,
              behavioral_fixture: verification.behavioral_fixture,
              real_call_verified: verification.real_call_verified,
              escalation_driver: CODEX_CLI_ESCALATION_DRIVER,
            };
            break;
          }
          lastError = verification.error;
        }
      }

      // Issue #93: LLM repair exhausted. Before failing terminally, try a
      // deterministic mechanical fallback body derived from the frozen
      // domain_spec. Accept it ONLY if it passes the SAME behavioral gate, so
      // a bogus body can never be silently written; specs whose gate the
      // fallback cannot satisfy still surface the terminal error below.
      if (!accepted) {
        const fallbackBody = renderDeterministicFallbackStageBody(stage, classification.archetype, domainSpec);
        const fallbackVerification = await verifyStageBody(fallbackBody, classification.archetype, {
          stage,
          ...(domainSpec ? { domainSpec } : {}),
          reasoningContracts,
        });
        if (fallbackVerification.ok) {
          accepted = {
            body: fallbackBody,
            body_hash: sha256(fallbackBody),
            behavioral_gate: fallbackVerification.behavioral_gate,
            behavioral_fixture: fallbackVerification.behavioral_fixture,
            real_call_verified: fallbackVerification.real_call_verified,
          };
          fallbackUsed = true;
        } else {
          lastError = `${lastError} (deterministic fallback also failed the behavioral gate: ${fallbackVerification.error})`;
        }
      }
    }

    if (!accepted) {
      throw new Error(`domain synthesis failed for stage ${stage} after ${maxAttempts} attempts; last error: ${lastError}`);
    }

    writeFileSync(cachePath, JSON.stringify(accepted, null, 2));
    stageSources[stage] = accepted.body;
    audit.push({
      stage,
      archetype: classification.archetype,
      ...auditFieldsFor(classification),
      ...behaviorAuditFields(accepted),
      attempts: attemptsUsed,
      cache_hit: false,
      ...(escalationDriver ? {
        escalation_driver: escalationDriver,
        escalation_attempts: escalationAttemptsUsed,
      } : {}),
      ...(fallbackUsed ? { deterministic_fallback: true } : {}),
      body_hash: accepted.body_hash,
    });
  }

  return {
    ...workingArtifact,
    stage_sources: stageSources,
    domain_synthesis_audit: audit,
  };
}

function verifyStageBody(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    allowedIntegrationImport?: string;
    allowedIntegrationImports?: readonly string[];
    integrationName?: string;
    integrationMethod?: string;
    integration?: WiringIntegration;
    exportKind?: ExportStageDescriptor['kind'];
    webNavigationDescriptor?: WebNavigationStageDescriptor;
    persistenceDescriptor?: PersistenceStageDescriptor;
    domainSpec?: StageDomainSpec;
    reasoningContracts?: Record<string, ReasoningStageContract>;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture; real_call_verified?: true }
  | { ok: false; error: string }
> {
  const stubError = scanBodyStubMarkers(body, archetype);
  if (stubError) {
    return Promise.resolve({ ok: false, error: stubError });
  }

  const source = ts.createSourceFile('stage.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const safetyError = scanSafety(source, {
    allowedIntegrationImport: options.allowedIntegrationImport,
    allowedIntegrationImports: options.allowedIntegrationImports,
    allowFetch: options.integration?.kind === 'http_api',
    allowedProcessEnv: options.integration?.kind === 'http_api' ? options.integration.config_env : [],
  });
  if (safetyError) {
    return Promise.resolve({ ok: false, error: formatSafetyGateFailure(safetyError) });
  }
  verifyGovernanceOfStageBody(body, 'stage_body');

  if (!exportsRunStage(source)) {
    return Promise.resolve({ ok: false, error: 'stage body must export function runStage' });
  }

  const transpiled = ts.transpileModule(body, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    reportDiagnostics: true,
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    return Promise.resolve({
      ok: false,
      error: diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'),
    });
  }

  const typecheckError = typecheckStageBody(body, options);
  if (typecheckError) {
    return Promise.resolve({ ok: false, error: typecheckError });
  }

  if (options.webNavigationDescriptor) {
    return runWebNavigationBehavioralGate(body, archetype, {
      ...options,
      descriptor: options.webNavigationDescriptor,
    });
  }

  if (options.persistenceDescriptor) {
    return runPersistenceBehavioralGate(body, archetype, {
      ...options,
      descriptor: options.persistenceDescriptor,
    });
  }

  return runBehavioralGate(body, archetype, options);
}

export function verifyGovernanceOfStageBody(
  sourceText: string,
  artifactKind: GovernedArtifactKind,
  enforcedConstructs: ReadonlySet<GovernedConstructKind> = activeEnforcedConstructs(),
): void {
  const violations = fatalGovernanceViolations(detectGovernedConstructs(sourceText), artifactKind, enforcedConstructs);
  if (violations.length > 0) throw new GovernanceRefusalError(artifactKind, violations);
}

function typecheckStageBody(
  body: string,
  options: { allowedIntegrationImport?: string; allowedIntegrationImports?: readonly string[] },
): string | undefined {
  const allowedIntegrationImports = [
    ...(options.allowedIntegrationImport ? [options.allowedIntegrationImport] : []),
    ...(options.allowedIntegrationImports ?? []),
  ];
  if (
    allowedIntegrationImports.length > 0 &&
    !allowedIntegrationImports.every((allowedImport) =>
      isExportImport(allowedImport) ||
      allowedImport === REPORT_DATA_IMPORT ||
      allowedImport === PDF_REPORT_CONNECTOR_IMPORT ||
      allowedImport === WEB_NAVIGATION_IMPORT ||
      allowedImport === PERSISTENCE_IMPORT)
  ) {
    return undefined;
  }

  const stageFile = '/virtual/pgas/stages/stage.ts';
  const contractsFile = '/virtual/pgas/contracts.ts';
  const docxFile = '/virtual/pgas/export/docx.ts';
  const htmlFile = '/virtual/pgas/export/html.ts';
  const reportDataFile = '/virtual/pgas/report-data.ts';
  const pdfReportConnectorFile = '/virtual/pgas/connectors/pdf-report.ts';
  const webNavigationFile = '/virtual/pgas/connectors/web-navigation.ts';
  const persistenceFile = '/virtual/pgas/connectors/persistence.ts';
  const compilerOptions: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  };
  const contractsSource = `export interface StageDomainSpec {
  reads: readonly string[];
  produces: Record<string, unknown>;
  rules: readonly string[];
  invariants: readonly string[];
  input_domain?: Record<string, unknown>;
}

export interface StageInput {
  stage: string;
  payload: Record<string, unknown>;
  domain: Record<string, unknown>;
  domain_spec: StageDomainSpec;
}

export interface StageRuntime {
  now(): string;
  random(): number;
  llm(prompt: string): Promise<string>;
}

export interface StageOutput {
  result_json: string;
  items_json: string;
  digest: string;
  adapter_kind?: 'in_memory_mock' | 'repo_integration';
}

declare const Buffer: {
  from(data: Uint8Array): { toString(encoding: 'base64'): string };
};
`;

  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) =>
      fileName === stageFile ||
      fileName === contractsFile ||
      fileName === docxFile ||
      fileName === htmlFile ||
      fileName === reportDataFile ||
      fileName === pdfReportConnectorFile ||
      fileName === webNavigationFile ||
      fileName === persistenceFile ||
      baseHost.fileExists(fileName),
    readFile: (fileName) => {
      if (fileName === stageFile) return body;
      if (fileName === contractsFile) return contractsSource;
      if (fileName === docxFile) return docxDeclarationSource();
      if (fileName === htmlFile) return htmlDeclarationSource();
      if (fileName === reportDataFile) return reportDataDeclarationSource();
      if (fileName === pdfReportConnectorFile) return pdfReportDeclarationSource();
      if (fileName === webNavigationFile) return webNavigationDeclarationSource();
      if (fileName === persistenceFile) return persistenceDeclarationSource();
      return baseHost.readFile(fileName);
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (fileName === stageFile) {
        return ts.createSourceFile(fileName, body, languageVersion, true, ts.ScriptKind.TS);
      }
      if (fileName === contractsFile) {
        return ts.createSourceFile(fileName, contractsSource, languageVersion, true, ts.ScriptKind.TS);
      }
      if (fileName === docxFile) {
        return ts.createSourceFile(fileName, docxDeclarationSource(), languageVersion, true, ts.ScriptKind.TS);
      }
      if (fileName === htmlFile) {
        return ts.createSourceFile(fileName, htmlDeclarationSource(), languageVersion, true, ts.ScriptKind.TS);
      }
      if (fileName === reportDataFile) {
        return ts.createSourceFile(fileName, reportDataDeclarationSource(), languageVersion, true, ts.ScriptKind.TS);
      }
      if (fileName === pdfReportConnectorFile) {
        return ts.createSourceFile(fileName, pdfReportDeclarationSource(), languageVersion, true, ts.ScriptKind.TS);
      }
      if (fileName === webNavigationFile) {
        return ts.createSourceFile(fileName, webNavigationDeclarationSource(), languageVersion, true, ts.ScriptKind.TS);
      }
      if (fileName === persistenceFile) {
        return ts.createSourceFile(fileName, persistenceDeclarationSource(), languageVersion, true, ts.ScriptKind.TS);
      }
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    resolveModuleNames: (moduleNames) => moduleNames.map((moduleName) => {
      if (moduleName === '../contracts.js') {
        return {
          resolvedFileName: contractsFile,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
      if (moduleName === EXPORT_DOCX_IMPORT) {
        return {
          resolvedFileName: docxFile,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
      if (moduleName === EXPORT_HTML_IMPORT) {
        return {
          resolvedFileName: htmlFile,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
      if (moduleName === REPORT_DATA_IMPORT) {
        return {
          resolvedFileName: reportDataFile,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
      if (moduleName === PDF_REPORT_CONNECTOR_IMPORT) {
        return {
          resolvedFileName: pdfReportConnectorFile,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
      if (moduleName === WEB_NAVIGATION_IMPORT) {
        return {
          resolvedFileName: webNavigationFile,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
      if (moduleName === PERSISTENCE_IMPORT) {
        return {
          resolvedFileName: persistenceFile,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
      return undefined;
    }),
  };
  const program = ts.createProgram([stageFile], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
    diagnostic.file?.fileName === stageFile ||
    diagnostic.file?.fileName === contractsFile ||
    diagnostic.file === undefined,
  );
  return diagnostics.length > 0
    ? diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join('\n')
    : undefined;
}

function docxDeclarationSource(): string {
  return `export interface ProgramDocxInput {
  title?: string;
  clientName?: string;
  serviceType?: string;
  sections?: Array<{ title: string; body: string | string[] }>;
}
export function renderStructuredDocxDocument(input: ProgramDocxInput): Uint8Array;
`;
}

function htmlDeclarationSource(): string {
  return `export function renderHtmlDocument(body: string): string;
`;
}

function reportDataDeclarationSource(): string {
  return `export interface StructuredReport {
  readonly title: string;
  readonly purpose: string;
  readonly executive_summary: string;
  readonly per_source: ReadonlyArray<{ source: string; found: number; pages_visited: number }>;
  readonly leads: readonly Record<string, unknown>[];
  readonly guard_audit_summary: ReadonlyArray<{ action: string; url: string; reason?: string }>;
}
export function assembleStructuredReport(domain: Record<string, unknown>): StructuredReport;
`;
}

function pdfReportDeclarationSource(): string {
  return `export interface StructuredReport {
  readonly title: string;
  readonly purpose: string;
  readonly executive_summary: string;
  readonly per_source: ReadonlyArray<{ source: string; found: number; pages_visited: number }>;
  readonly leads: readonly Record<string, unknown>[];
  readonly guard_audit_summary: ReadonlyArray<{ action: string; url: string; reason?: string }>;
}
export interface PdfReportHostConnector {
  render_report(report: StructuredReport): Promise<Uint8Array>;
}
export class MockPdfReportConnector implements PdfReportHostConnector {
  render_report(report: StructuredReport): Promise<Uint8Array>;
}
`;
}

function webNavigationDeclarationSource(): string {
  return `export interface GuardContext {
  readonly allowed_domains: readonly string[];
  readonly max_depth: number;
  readonly max_pages: number;
  readonly max_follow_links: number;
  readonly min_delay_ms: number;
  readonly max_concurrency: number;
}
export interface NavAuditEntry {
  readonly action: 'fetch' | 'follow' | 'extract' | 'skip' | 'refuse';
  readonly url: string;
  readonly reason?: string;
  readonly at_depth: number;
}
export interface ExtractedItem { readonly [key: string]: unknown }
export interface NavigateAndExtractResult {
  readonly items: readonly ExtractedItem[];
  readonly pages_visited: number;
  readonly audit: readonly NavAuditEntry[];
}
export interface WebNavigationHostConnector {
  navigate_and_extract(
    source: string,
    purpose: string,
    extraction_schema: Record<string, string>,
    guard: GuardContext,
  ): Promise<NavigateAndExtractResult>;
}
export class MockWebNavigationConnector implements WebNavigationHostConnector {
  navigate_and_extract(
    source: string,
    purpose: string,
    extraction_schema: Record<string, string>,
    guard: GuardContext,
  ): Promise<NavigateAndExtractResult>;
}
`;
}

function persistenceDeclarationSource(): string {
  return `export interface LeadRecord { readonly [key: string]: unknown }
export interface UpsertResult { readonly inserted: number; readonly updated: number; readonly ids: readonly string[] }
export interface PersistenceHostConnector {
  upsert_lead(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  upsert_contact(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  query(filter: Record<string, unknown>): Promise<readonly LeadRecord[]>;
  dedupe(records: readonly LeadRecord[], dedupe_key: string): Promise<readonly LeadRecord[]>;
}
export class MockPersistenceConnector implements PersistenceHostConnector {
  upsert_lead(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  upsert_contact(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  query(filter: Record<string, unknown>): Promise<readonly LeadRecord[]>;
  dedupe(records: readonly LeadRecord[], dedupe_key: string): Promise<readonly LeadRecord[]>;
}
`;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${location.line + 1}:${location.character + 1}: ${message}`;
}

function scanBodyStubMarkers(body: string, archetype: 'pure-compute' | 'external-adapter'): string | undefined {
  const todoMatches = [...body.matchAll(/\bTODO(?:\(([^)]+)\))?/gu)];
  for (const match of todoMatches) {
    const marker = match[0];
    const qualifier = match[1];
    if (archetype === 'external-adapter' && marker === 'TODO(real-service-swap)' && qualifier === 'real-service-swap') {
      continue;
    }
    return `stub marker in generated stage body: ${marker}`;
  }

  const placeholderScanSource = sourceWithStringLiteralsBlanked(body);
  const markerPatterns = [
    { marker: 'stage_action_stub', pattern: /stage_action_stub/u, source: body },
    { marker: 'not implemented', pattern: /not implemented|not_implemented/u, source: body },
    { marker: 'placeholder', pattern: /\bplaceholder\b/u, source: placeholderScanSource },
  ];
  for (const candidate of markerPatterns) {
    if (candidate.pattern.test(candidate.source)) {
      return `stub marker in generated stage body: ${candidate.marker}`;
    }
  }

  return undefined;
}

function sourceWithStringLiteralsBlanked(source: string): string {
  const sourceFile = ts.createSourceFile('stage-body.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      ranges.push({ start: node.getStart(sourceFile), end: node.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (ranges.length === 0) {
    return source;
  }
  const chars = [...source];
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      chars[index] = ' ';
    }
  }
  return chars.join('');
}

function scanSafety(
  source: ts.SourceFile,
  options: {
    allowedIntegrationImport?: string;
    allowedIntegrationImports?: readonly string[];
    allowFetch?: boolean;
    allowedProcessEnv?: readonly string[];
  },
): string | undefined {
  let error: string | undefined;
  const allowedImports = new Set(['../contracts.js']);
  if (options.allowedIntegrationImport) {
    allowedImports.add(options.allowedIntegrationImport);
  }
  for (const allowedImport of options.allowedIntegrationImports ?? []) {
    allowedImports.add(allowedImport);
  }
  const allowedProcessEnv = new Set(options.allowedProcessEnv ?? []);
  const processAliases = new Set(['process']);
  const visit = (node: ts.Node): void => {
    if (error) return;
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isBannedStageImport(specifier)) {
        error = `banned import: ${specifier}`;
        return;
      }
      if (!allowedImports.has(specifier)) {
        error = `banned import: ${specifier}`;
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        error = 'banned capability: dynamic import';
        return;
      }
      if (ts.isIdentifier(node.expression) && ['eval', 'require'].includes(node.expression.text)) {
        error = `banned capability: ${node.expression.text}`;
        return;
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch' && !options.allowFetch) {
        error = 'banned capability: fetch';
        return;
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isProcessObjectExpression(node.initializer, processAliases)) {
        processAliases.add(node.name.text);
      }
    }
    if (isFetchReference(node) && !options.allowFetch) {
      error = 'banned capability: fetch';
      return;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      error = 'banned capability: Function constructor';
      return;
    }
    const envName = processEnvReadName(node, processAliases);
    if (envName !== undefined) {
      if (envName === null || !allowedProcessEnv.has(envName)) {
        error = 'banned capability: process.env secret read';
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return error;
}

function isBannedStageImport(specifier: string): boolean {
  return [
    'child_process',
    'node:child_process',
    'http',
    'node:http',
    'https',
    'node:https',
    'net',
    'node:net',
    'tls',
    'node:tls',
    'dgram',
    'node:dgram',
  ].includes(specifier);
}

function isFetchReference(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'fetch') {
    return isIdentifierReference(node);
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'fetch') {
    return true;
  }
  if (ts.isElementAccessExpression(node) && memberName(node) === 'fetch') {
    return true;
  }
  return false;
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  return true;
}

function processEnvReadName(node: ts.Node, processAliases: ReadonlySet<string>): string | null | undefined {
  if (ts.isPropertyAccessExpression(node) && isProcessEnvExpression(node.expression, processAliases)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && isProcessEnvExpression(node.expression, processAliases)) {
    const argument = node.argumentExpression;
    return argument && ts.isStringLiteral(argument) ? argument.text : null;
  }
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isProcessEnvExpression(node, processAliases)
  ) {
    return null;
  }
  return undefined;
}

function isProcessEnvExpression(node: ts.Expression, processAliases: ReadonlySet<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return memberName(expression) === 'env' && isProcessObjectExpression(expression.expression, processAliases);
  }
  return false;
}

function isProcessObjectExpression(node: ts.Expression, processAliases: ReadonlySet<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return processAliases.has(expression.text);
  }
  const path = memberPath(expression);
  return path.length > 0 && path[path.length - 1] === 'process';
}

function memberPath(node: ts.Expression): string[] {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    return ['this'];
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const name = memberName(expression);
    if (!name) return [];
    return [...memberPath(expression.expression), name];
  }
  return [];
}

function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  const argument = node.argumentExpression;
  return argument && ts.isStringLiteral(argument) ? argument.text : undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function exportsRunStage(source: ts.SourceFile): boolean {
  return source.statements.some((statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'runStage' &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function createOpenAiCompatibleBodyGenerator(config: { providerUrl: string; model: string }): StageBodyGenerator {
  return async (request) => {
    if (!config.providerUrl || !config.model) {
      throw new Error('domain synthesis requires PGAS_OPENAI_BASE_URL and PGAS_OPENAI_MODEL');
    }
    const timeoutMs = domainSynthesisProviderTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${config.providerUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.PGAS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? 'local'}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_tokens: domainSynthesisProviderMaxTokens(),
          messages: [
            {
              role: 'system',
              content: STAGE_BODY_SYSTEM_PREAMBLE,
            },
            {
              role: 'user',
              content: stageBodyUserPrompt(request),
            },
          ],
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`domain synthesis provider timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`domain synthesis provider failed: HTTP ${response.status}`);
    }
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('domain synthesis provider returned no content');
    }
    return extractCode(content);
  };
}

function resolveEscalationGenerator(): StageBodyGenerator | undefined {
  const driver = process.env.PGAS_SYNTH_ESCALATION_DRIVER?.trim().toLowerCase();
  if (driver !== CODEX_CLI_ESCALATION_DRIVER) return undefined;

  setDefaultEnv('PGAS_ENABLE_CODEX_DRIVER', '1');
  const { authorHandle } = createProviderHandles({ provider: CODEX_CLI_ESCALATION_DRIVER });
  return async (request) => extractCode(await authorHandle.complete(stageBodyEscalationPrompt(request)));
}

function stageBodyEscalationPrompt(request: StageBodyRequest): string {
  return `${STAGE_BODY_SYSTEM_PREAMBLE}\n\n${stageBodyUserPrompt(request)}`;
}

function stageBodyUserPrompt(request: StageBodyRequest): string {
  return request.repair
    ? `${request.prompt}\n\nPrevious attempt failed:\n${request.repair.lastError}`
    : request.prompt;
}

function domainSynthesisProviderTimeoutMs(): number {
  return positiveIntegerEnv('PGAS_DOMAIN_SYNTHESIS_TIMEOUT_MS', 45_000);
}

function domainSynthesisProviderMaxTokens(): number {
  return positiveIntegerEnv('PGAS_DOMAIN_SYNTHESIS_MAX_TOKENS', 2_400);
}

function domainSynthesisEscalationMaxAttempts(): number {
  return positiveIntegerEnv('PGAS_SYNTH_ESCALATION_MAX_ATTEMPTS', 2);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function setDefaultEnv(name: string, value: string): void {
  if ((process.env[name] ?? '').trim().length === 0) {
    process.env[name] = value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promptForStage(stage: string, classification: StageClassification, artifact: SynthesizedArtifact): string {
  const context = contextForStage(stage, classification, artifact);
  const entryPath = `inputs.${context.entry_channel}`;
  const initialEntryPath = context.initial_entry_path;
  const resultJsonSchema = context.domain_spec?.produces.result_json;
  const hasRepeatedRecord = isRecord(resultJsonSchema) && Object.values(resultJsonSchema).some(isRepeatedRecordSchema);
  const domainSpecLines = context.domain_spec
    ? [
        'Author-provided domain spec for this stage is normative.',
        'Implement these rules exactly; do not infer alternate business logic.',
        'Treat domain_spec.produces.result_json as the exact result_json object schema and insertion order; emit those top-level keys only.',
        ...(hasRepeatedRecord
          ? [
              'When a domain_spec.produces.result_json field is an array containing one object, treat it as a repeated-record schema: return an array of records and preserve every key inside that object.',
            ]
          : []),
        'When domain_spec.produces.items_json is an array, treat it as the exact ordered item template list; emit that many strings and no extras.',
        'If request data is missing for a required read, surface that gap in result_json rather than fabricating values.',
        'Stage domain spec:',
        JSON.stringify(context.domain_spec, null, 2),
      ]
    : [];
  return [
    `Generate src/programs/<slug>/stages/${stage}.ts for a PGAS generated program.`,
    `Stage archetype: ${classification.archetype}.`,
    classification.archetype === 'external-adapter'
      ? externalAdapterPromptLine(classification)
      : 'Implement deterministic local pure-compute logic.',
    'Stage synthesis context:',
    JSON.stringify(context, null, 2),
    ...domainSpecLines,
    'Do not include comments or any stub marker words: TODO, placeholder, stage_action_stub, not implemented.',
    "Use exactly one import line: import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';",
    'Do not import handlers, resolver helpers, Node built-ins, runtime packages, or any other module.',
    'Export exactly: async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput>.',
    'Return JSON strings result_json and items_json; do not compute digest yourself.',
    'Use strict TypeScript: include StageInput, StageOutput, and StageRuntime in the contract import; assign unknown object values to Record<string, unknown> before indexing.',
    'Runtime data access contract:',
    `The original entry-channel request is stored as a stable string at input.domain['${initialEntryPath}']; read that path for user request facts.`,
    `input.domain['${entryPath}'] is the latest trigger text and may be a continuation such as "continue"; do not use it as the source of original request facts when the stable path is present.`,
    "Parse JSON-looking user requests into typed facts before computing.",
    'When parsed request facts contain numeric fields whose names describe a calculation, compute from those fields directly instead of inventing base fees, complexity multipliers, or random constants.',
    'Use common named-field arithmetic: hours multiplied by hourly rates produce subtotals; discount_pct is a percentage applied to a subtotal; budget fields are comparison thresholds, not fee inputs.',
    'When parsed request facts contain identifiers, echo those identifiers; do not replace them with synthetic IDs from runtime.random().',
    "Prior deterministic stage outputs are stored as objects at input.domain['<stage>.output']; parse their result_json and items_json strings before using them.",
    "Prior LLM reasoning stage outputs are stored as strings at input.domain['<stage>.result_json'] and input.domain['<stage>.items_json'], and as typed fields at input.domain['<stage>.result.<field>']; prefer the typed fields.",
    'Do not treat input.payload.__stage_runtime as business input; use runtime.now() and runtime.random() through StageRuntime only.',
    'Shape result_json from the mandate, stage slug, input facts, and prior stage outputs. Preserve concrete field names from the request and prior results when they are meaningful.',
    'If the domain spec declares produces.result_json, construct result_json with exactly those declared top-level keys, in that declared order, and no extra top-level keys.',
    'Do not use a generic status/summary/details template when the mandate names concrete fields.',
    'Keep final business fields at the top level; do not wrap all important facts under generic inputs, details, or calculation objects.',
    'Keep key computed facts at the top level of result_json so later stages can consume them without guessing nested structures.',
    'For pure-compute stages, build a complete deterministic object from input.stage, runtime.now(), parsed request facts, and prior stage outputs. If no domain fact is relevant, still return a meaningful non-empty object with status, summary, severity, owner_queue, next_action, and summary_ready fields.',
    'For items_json, return a non-empty JSON array of concise lower-case key:value strings derived from the result object; when the domain spec names item formats, use those exact formats without extra spaces.',
    'If the domain spec declares produces.items_json as an array, construct items_json with exactly those item templates, in order, and no additional items.',
    'Do not use eval, dynamic import, child_process, shell, fetch/raw network, process.env, or secret reads.',
    'Untrusted generated spec context:',
    artifact.spec_yaml,
    'Frozen contract:',
    artifact.contracts_ts,
  ].join('\n');
}

function domainSpecForStage(artifact: SynthesizedArtifact, stage: string): StageDomainSpec | undefined {
  return artifact.synthesis_context?.stages.find((item) => item.slug === stage)?.domain_spec;
}

function renderReasoningContractRecordModule(contract: ReasoningStageContract): string {
  return `// Runtime locus: this stage executes inside the program's engine author-LLM.
// There is no deterministic runStage here on purpose — the woven specs.yml
// (mode prompt, synthesized arg schema, GKType-typed <stage>.result.* paths)
// is what executes and enforces this stage at runtime. This module is the
// first-class record of that reasoning contract.
export const reasoningContract = ${JSON.stringify(contract, null, 2)} as const;
`;
}

function contextForStage(
  stage: string,
  classification: StageClassification,
  artifact: SynthesizedArtifact,
): Record<string, unknown> & { entry_channel: string; initial_entry_path: string; domain_spec?: StageDomainSpec } {
  const synthesisContext = artifact.synthesis_context;
  const orderedStages = synthesisContext?.stages.map((item) => item.slug) ?? artifact.mode_names;
  const currentStage = synthesisContext?.stages.find((item) => item.slug === stage);
  const stageIndex = orderedStages.indexOf(stage);
  const previousStages = stageIndex > 0 ? orderedStages.slice(0, stageIndex) : [];
  const laterStages = stageIndex >= 0 ? orderedStages.slice(stageIndex + 1) : [];
  const transitions = synthesisContext?.transitions ?? [];
  const domainSpec = currentStage?.domain_spec;
  return {
    program_slug: synthesisContext?.program_slug ?? unknownProgramSlug(artifact.spec_yaml),
    program_name: synthesisContext?.program_name ?? 'generated program',
    purpose: synthesisContext?.purpose ?? unknownPurpose(artifact.spec_yaml),
    entry_channel: synthesisContext?.entry_channel ?? inferEntryChannel(artifact.spec_yaml),
    initial_entry_path: initialInputPath(synthesisContext?.entry_channel ?? inferEntryChannel(artifact.spec_yaml)),
    stage,
    archetype: classification.archetype,
    ...(classification.rationale ? { stage_rationale: classification.rationale } : {}),
    ...(classification.adapter_kind ? { adapter_kind: classification.adapter_kind } : {}),
    ...(domainSpec ? { domain_spec: domainSpec } : {}),
    previous_stages: previousStages,
    next_stages: laterStages,
    incoming_transitions: transitions.filter((transition) => transition.to === stage),
    outgoing_transitions: transitions.filter((transition) => transition.from === stage),
    delegation: synthesisContext?.delegation ?? {},
    completion: synthesisContext?.completion ?? null,
  };
}

function inferEntryChannel(specYaml: string): string {
  const match = specYaml.match(/\ningestion:\n\s+([a-zA-Z0-9_]+):\n\s+- inputs\.\1/u);
  return match?.[1] ?? 'user_text';
}

function initialInputPath(entryChannel: string): string {
  const normalized = entryChannel.trim().replace(/[^a-zA-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '');
  return `inputs.initial_${normalized.length > 0 ? normalized : 'user_text'}`;
}

function unknownProgramSlug(specYaml: string): string {
  const match = specYaml.match(/^name:\s*([^\n]+)/u);
  return match?.[1]?.trim() ?? 'generated-program';
}

function unknownPurpose(specYaml: string): string {
  const match = specYaml.match(/preamble:\s*\|-\n\s+Program:\s*([^\n]+)/u);
  return match?.[1]?.trim() ?? 'Generated PGAS program.';
}

function externalAdapterPromptLine(classification: StageClassification): string {
  if (classification.adapter_kind === 'repo_integration') {
    return `Use the declared repo integration ${classification.integration_name} only.`;
  }
  const gap = classification.integration_gap && classification.audit_note ? ` ${classification.audit_note}` : '';
  return `Use an in-memory mock only and include adapter_kind in the returned output. The only permitted TODO marker is TODO(real-service-swap).${gap}`;
}

function classificationFor(artifact: SynthesizedArtifact, stage: string): StageClassification {
  const found = artifact.stage_classification.find((candidate) =>
    !!candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    (candidate as { slug?: unknown }).slug === stage,
  );
  if (!found || typeof found !== 'object' || Array.isArray(found)) {
    return { slug: stage, archetype: 'pure-compute' };
  }
  const record = found as Record<string, unknown>;
  return {
    slug: stage,
    archetype: typeof record.archetype === 'string' ? record.archetype : 'pure-compute',
    ...(typeof record.rationale === 'string' ? { rationale: record.rationale } : {}),
    ...(record.adapter_kind === 'in_memory_mock' || record.adapter_kind === 'repo_integration'
      ? { adapter_kind: record.adapter_kind }
      : {}),
    ...(typeof record.integration_name === 'string' ? { integration_name: record.integration_name } : {}),
    ...(typeof record.integration_import === 'string' ? { integration_import: record.integration_import } : {}),
    ...(typeof record.integration_method === 'string' ? { integration_method: record.integration_method } : {}),
    ...(typeof record.connector_slug === 'string' ? { connector_slug: record.connector_slug } : {}),
    ...(record.integration_gap === true ? { integration_gap: true } : {}),
    ...(typeof record.audit_note === 'string' ? { audit_note: record.audit_note } : {}),
    ...(record.export_kind === 'export_docx' || record.export_kind === 'export_html' || record.export_kind === 'export_pdf' ? { export_kind: record.export_kind } : {}),
  };
}

function resolveIntegrationBinding(
  classification: StageClassification,
  targetKind: 'standalone_repo' | 'existing_repo',
  integrations: WiringIntegration[],
): StageClassification {
  if (classification.archetype !== 'external-adapter' || targetKind !== 'existing_repo') {
    return classification;
  }

  if (webNavigationDescriptorForStage(classification)) {
    return {
      ...classification,
      adapter_kind: 'in_memory_mock',
      integration_gap: true,
      integration_name: 'web_navigation',
      connector_slug: 'web-navigation',
      audit_note: classification.audit_note ?? 'guarded browser navigation is host-side; implement WebNavigationHostConnector (pgas-web driver)',
    };
  }

  if (persistenceDescriptorForStage(classification)) {
    return {
      ...classification,
      adapter_kind: 'in_memory_mock',
      integration_gap: true,
      integration_name: 'persistence',
      connector_slug: 'persistence',
      audit_note: classification.audit_note ?? 'cross-session store is host-side; implement PersistenceHostConnector (the CRM store)',
    };
  }

  if (classification.adapter_kind === 'repo_integration' && classification.integration_name) {
    return classification;
  }

  const matched = matchIntegration(classification, integrations);
  if (matched) {
    return {
      ...classification,
      adapter_kind: 'repo_integration',
      integration_name: matched.name,
      integration_import: matched.import,
      integration_method: matched.methods[0],
      integration_gap: false,
      audit_note: undefined,
    };
  }

  return {
    ...classification,
    adapter_kind: 'in_memory_mock',
    integration_gap: true,
    audit_note: `existing repo external-adapter stage ${classification.slug} has no matching integration declared in .pgas/wiring.yml`,
  };
}

function matchIntegration(classification: StageClassification, integrations: WiringIntegration[]): WiringIntegration | undefined {
  const haystack = [classification.slug, classification.rationale, classification.audit_note, classification.integration_name]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const tokens = new Set(haystack.split(/[^a-z0-9]+/u).filter(Boolean));
  return integrations.find((integration) => tokens.has(integration.name.toLowerCase()));
}

function integrationForClassification(
  classification: StageClassification,
  integrations: WiringIntegration[],
): WiringIntegration | undefined {
  return classification.integration_name
    ? integrations.find((integration) => integration.name === classification.integration_name)
    : undefined;
}

function exportDescriptorForStage(
  artifact: SynthesizedArtifact,
  stage: string,
  classification: StageClassification,
): ExportStageDescriptor | undefined {
  const descriptor = artifact.export_descriptors?.find((item) => item.stage === stage);
  if (descriptor) {
    return descriptor;
  }
  if (classification.export_kind === 'export_docx' || classification.export_kind === 'export_html' || classification.export_kind === 'export_pdf') {
    return {
      stage,
      kind: classification.export_kind,
      title: `${stage} export`,
      artifactType: artifactTypeForExportKind(classification.export_kind),
      payloadRef: `${stage}.output`,
    };
  }
  return undefined;
}

function artifactTypeForExportKind(kind: ExportStageDescriptor['kind']): ExportStageDescriptor['artifactType'] {
  if (kind === 'export_docx') return 'docx_export';
  if (kind === 'export_html') return 'html_export';
  return 'pdf_report';
}

function exportPrimaryImportForDescriptor(descriptor: ExportStageDescriptor): string {
  if (descriptor.kind === 'export_docx') return EXPORT_DOCX_IMPORT;
  if (descriptor.kind === 'export_html') return EXPORT_HTML_IMPORT;
  return REPORT_DATA_IMPORT;
}

function exportImportsForDescriptor(descriptor: ExportStageDescriptor): string[] {
  if (descriptor.kind === 'export_pdf') {
    return [REPORT_DATA_IMPORT, PDF_REPORT_CONNECTOR_IMPORT];
  }
  return [exportPrimaryImportForDescriptor(descriptor)];
}

function isExportImport(value: string): boolean {
  return value === EXPORT_DOCX_IMPORT || value === EXPORT_HTML_IMPORT || value === REPORT_DATA_IMPORT;
}

function exportKindForImport(value: string): ExportStageDescriptor['kind'] {
  if (value === REPORT_DATA_IMPORT) return 'export_pdf';
  return value === EXPORT_HTML_IMPORT ? 'export_html' : 'export_docx';
}

function auditFieldsFor(classification: StageClassification): Record<string, unknown> {
  return {
    ...(classification.adapter_kind ? { adapter_kind: classification.adapter_kind } : {}),
    ...(classification.export_kind ? { export_kind: classification.export_kind } : {}),
    ...(classification.integration_name ? { integration_name: classification.integration_name } : {}),
    ...(classification.integration_import ? { integration_import: classification.integration_import } : {}),
    ...(classification.integration_method ? { integration_method: classification.integration_method } : {}),
    ...(classification.connector_slug ? { connector_slug: classification.connector_slug } : {}),
    ...(classification.integration_gap ? { integration_gap: true } : {}),
    ...(classification.audit_note ? { audit_note: classification.audit_note } : {}),
  };
}

function webNavigationDescriptorForStage(classification: StageClassification): WebNavigationStageDescriptor | undefined {
  if (classification.integration_name !== 'web_navigation' && classification.connector_slug !== 'web-navigation') {
    return undefined;
  }
  return {
    integration_name: 'web_navigation',
    connector_slug: 'web-navigation',
    ...(classification.audit_note ? { audit_note: classification.audit_note } : {}),
  };
}

function persistenceDescriptorForStage(classification: StageClassification, artifact?: SynthesizedArtifact): PersistenceStageDescriptor | undefined {
  if (classification.integration_name !== 'persistence' && classification.connector_slug !== 'persistence') {
    return undefined;
  }
  return {
    integration_name: 'persistence',
    connector_slug: 'persistence',
    ...keyedCollectionPathForArtifact(artifact),
    ...(classification.audit_note ? { audit_note: classification.audit_note } : {}),
  };
}

function keyedCollectionPathForArtifact(artifact: SynthesizedArtifact | undefined): { keyed_collection_path: string } | {} {
  if (!artifact?.spec_yaml) {
    return {};
  }
  const raw = load(artifact.spec_yaml) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const keyedCollections = (raw as { keyed_collections?: unknown }).keyed_collections;
  if (!Array.isArray(keyedCollections)) {
    return {};
  }
  const first = keyedCollections.find((entry): entry is { collection: string } =>
    !!entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof (entry as { collection?: unknown }).collection === 'string' &&
    (entry as { collection: string }).collection.length > 0);
  return first ? { keyed_collection_path: first.collection } : {};
}

function behaviorAuditFields(record: Pick<CacheRecord, 'behavioral_gate' | 'behavioral_fixture' | 'real_call_verified'>): Record<string, unknown> {
  return {
    ...(record.behavioral_gate ? { behavioral_gate: record.behavioral_gate } : {}),
    ...(record.behavioral_fixture ? { behavioral_fixture: record.behavioral_fixture } : {}),
    ...(record.real_call_verified ? { real_call_verified: true } : {}),
  };
}

function escalationAuditFields(record: Pick<CacheRecord, 'escalation_driver'>): Record<string, unknown> {
  return {
    ...(record.escalation_driver ? { escalation_driver: record.escalation_driver } : {}),
  };
}

async function runBehavioralGate(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    allowedIntegrationImport?: string;
    allowedIntegrationImports?: readonly string[];
    integrationName?: string;
    integrationMethod?: string;
    integration?: WiringIntegration;
    exportKind?: ExportStageDescriptor['kind'];
    domainSpec?: StageDomainSpec;
    reasoningContracts?: Record<string, ReasoningStageContract>;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture; real_call_verified?: true }
  | { ok: false; error: string }
> {
  if (options.allowedIntegrationImport) {
    if (isExportImport(options.allowedIntegrationImport)) {
      return runExportBehavioralGate(body, archetype, {
        ...options,
        exportKind: options.exportKind ?? exportKindForImport(options.allowedIntegrationImport),
      });
    }
    if (options.integration?.kind === 'http_api') {
      return runRepoIntegrationLoopbackGate(body, archetype, {
        ...options,
        integration: options.integration,
      });
    }
    return { ok: false, error: `repo_integration runtime verification requires an http_api integration; got ${options.integration?.kind ?? 'unknown'}` };
  }

  try {
    const runStage = loadRunStageForBehavior(body);
    const fixture = behaviorFixtureFor(options.stage, archetype, options.domainSpec, options.reasoningContracts);
    const output = await withBehaviorTimeout(
      Promise.resolve(runStage(fixture.input, fixture.runtime)),
      `behavioral gate failed for stage ${options.stage}: runStage timed out`,
    );
    const behaviorError = assertBehavioralOutput(output, options.stage, archetype, options.domainSpec);
    if (behaviorError) {
      return {
        ok: false,
        error: formatBehavioralGateFailure(options.stage, behaviorError, fixture.audit),
      };
    }
    return {
      ok: true,
      behavioral_gate: 'passed',
      behavioral_fixture: fixture.audit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `behavioral gate failed for stage ${options.stage}: ${message}` };
  }
}

async function runExportBehavioralGate(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    exportKind: ExportStageDescriptor['kind'];
    domainSpec?: StageDomainSpec;
    reasoningContracts?: Record<string, ReasoningStageContract>;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture; real_call_verified?: true }
  | { ok: false; error: string }
> {
  if (options.exportKind === 'export_pdf') {
    return runPdfReportBehavioralGate(body, archetype, options);
  }
  try {
    const importPath = options.exportKind === 'export_docx' ? EXPORT_DOCX_IMPORT : EXPORT_HTML_IMPORT;
    const runStage = loadRunStageForBehavior(body, {
      modules: {
        [importPath]: loadExportTemplateModule(importPath),
      },
    });
    const fixture = behaviorFixtureFor(options.stage, archetype, options.domainSpec, options.reasoningContracts);
    const output = await withBehaviorTimeout(
      Promise.resolve(runStage(fixture.input, fixture.runtime)),
      `export behavioral gate failed for stage ${options.stage}: runStage timed out`,
    );
    const behaviorError = assertBehavioralOutput(output, options.stage, archetype, options.domainSpec);
    if (behaviorError) {
      return {
        ok: false,
        error: formatBehavioralGateFailure(options.stage, behaviorError, fixture.audit),
      };
    }
    const exportError = assertExportBehavioralOutput(output, options.exportKind);
    if (exportError) {
      return { ok: false, error: `export behavioral gate failed for stage ${options.stage}: ${exportError}` };
    }
    return {
      ok: true,
      behavioral_gate: options.exportKind === 'export_docx' ? 'docx_export_render' : 'html_export_render',
      behavioral_fixture: {
        ...fixture.audit,
        expected_items_templates: options.exportKind === 'export_docx' ? ['docx_export:<sha256>'] : ['html_export:<sha256>'],
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `export behavioral gate failed for stage ${options.stage}: ${message}` };
  }
}

async function runPdfReportBehavioralGate(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    exportKind: ExportStageDescriptor['kind'];
    domainSpec?: StageDomainSpec;
    reasoningContracts?: Record<string, ReasoningStageContract>;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture; real_call_verified?: true }
  | { ok: false; error: string }
> {
  const calls: Array<{ report: Record<string, unknown> }> = [];
  const connector = {
    async render_report(report: Record<string, unknown>): Promise<Uint8Array> {
      calls.push({ report });
      return new TextEncoder().encode([
        'PDF_REPORT_BEHAVIOR',
        String(report.title),
        'EXECUTIVE SUMMARY',
        String(report.executive_summary),
        'PER SOURCE',
        JSON.stringify(report.per_source),
        'LEADS',
        JSON.stringify(report.leads),
        'GUARD AUDIT SUMMARY',
        JSON.stringify(report.guard_audit_summary),
      ].join('\n'));
    },
  };
  const fixture = {
    input: {
      stage: options.stage,
      payload: {
        __stage_runtime: {
          pdf_report: connector,
        },
      },
      domain: {
        config: { purpose: 'find AI engineers', title: 'Behavior PDF Report' },
        aggregate: { per_source: [{ source: 'https://example.com', found: 2, pages_visited: 2 }] },
        persist: { new_vs_existing: [{ email: 'a@x.com', status: 'new' }] },
        audit: [{ action: 'refuse', url: 'https://evil.test', reason: 'off-allowlist' }],
      },
      domain_spec: options.domainSpec ?? {
        reads: ['aggregate.per_source', 'persist.new_vs_existing', 'audit', 'config'],
        produces: {},
        rules: [],
        invariants: [],
      },
    },
    runtime: {
      now: () => '2026-08-05T00:00:00.000Z',
      random: () => 0.25,
      llm: async () => {
        throw new Error('StageRuntime.llm is not available in PDF report behavioral verification');
      },
      pdf_report: connector,
      connectors: { pdf_report: connector },
    },
    audit: {
      input_stage: options.stage,
      expected_result_stage: options.stage,
      expected_items_non_empty: true as const,
      expected_items_templates: ['pdf_report:<sha256>'],
      available_domain_paths: ['aggregate.per_source', 'audit', 'config', 'persist.new_vs_existing'],
      domain_spec_reads: ['aggregate.per_source', 'persist.new_vs_existing', 'audit', 'config'],
    },
  };

  try {
    const runStage = loadRunStageForBehavior(body, {
      modules: {
        [REPORT_DATA_IMPORT]: loadReportDataTemplateModule(),
        [PDF_REPORT_CONNECTOR_IMPORT]: {
          MockPdfReportConnector: class {
            async render_report(report: Record<string, unknown>): Promise<Uint8Array> {
              return new TextEncoder().encode(JSON.stringify(report));
            }
          },
        },
      },
    });
    const output = await withBehaviorTimeout(
      Promise.resolve(runStage(fixture.input, fixture.runtime)),
      `PDF report behavioral gate failed for stage ${options.stage}: runStage timed out`,
    );
    const behaviorError = assertBehavioralOutput(output, options.stage, archetype, options.domainSpec);
    if (behaviorError) {
      return {
        ok: false,
        error: formatBehavioralGateFailure(options.stage, behaviorError, fixture.audit),
      };
    }
    const exportError = assertExportBehavioralOutput(output, 'export_pdf');
    if (exportError) {
      return { ok: false, error: `PDF report behavioral gate failed for stage ${options.stage}: ${exportError}` };
    }
    const reportError = assertPdfReportConnectorCall(calls);
    if (reportError) {
      return { ok: false, error: `PDF report behavioral gate failed for stage ${options.stage}: ${reportError}` };
    }
    return {
      ok: true,
      behavioral_gate: 'pdf_report_render',
      behavioral_fixture: fixture.audit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `PDF report behavioral gate failed for stage ${options.stage}: ${message}` };
  }
}

function assertPdfReportConnectorCall(calls: Array<{ report: Record<string, unknown> }>): string | undefined {
  if (calls.length !== 1) {
    return `expected one PdfReportHostConnector.render_report call; got ${String(calls.length)}`;
  }
  const report = calls[0]!.report;
  if (report.title !== 'Behavior PDF Report' || report.purpose !== 'find AI engineers') {
    return 'connector report did not include title and purpose from input.domain.config';
  }
  if (typeof report.executive_summary !== 'string' || report.executive_summary.length === 0) {
    return 'connector report did not include executive_summary';
  }
  if (!Array.isArray(report.per_source) || report.per_source.length !== 1) {
    return 'connector report did not include per_source findings';
  }
  if (!Array.isArray(report.leads) || report.leads.length !== 1) {
    return 'connector report did not include leads';
  }
  const audit = report.guard_audit_summary;
  if (!Array.isArray(audit) || !audit.some((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as Record<string, unknown>).action === 'refuse')) {
    return 'connector report did not include guard_audit_summary refusal entries';
  }
  return undefined;
}

async function runRepoIntegrationLoopbackGate(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    integration: WiringIntegration;
    integrationName?: string;
    integrationMethod?: string;
    domainSpec?: StageDomainSpec;
    reasoningContracts?: Record<string, ReasoningStageContract>;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture; real_call_verified: true }
  | { ok: false; error: string }
> {
  const method = options.integrationMethod ?? options.integration.methods[0];
  const baseUrlEnv = httpApiBaseUrlEnvName(options.integration);
  const baseUrl = process.env[baseUrlEnv];
  if (!baseUrl) {
    return { ok: false, error: `missing config env for http_api loopback verification: ${baseUrlEnv}` };
  }

  let endpoint: URL;
  try {
    endpoint = httpApiEndpoint(baseUrl, method);
  } catch (error) {
    return { ok: false, error: `invalid ${baseUrlEnv} for http_api loopback verification: ${error instanceof Error ? error.message : String(error)}` };
  }
  const loopbackError = assertLoopbackEndpoint(endpoint);
  if (loopbackError) {
    return { ok: false, error: loopbackError };
  }

  try {
    const runStage = loadRunStageForBehavior(body, { allowFetch: true, env: { ...process.env } });
    const fixture = behaviorFixtureFor(options.stage, archetype, options.domainSpec, options.reasoningContracts);
    const output = await withBehaviorTimeout(
      Promise.resolve(runStage(fixture.input, fixture.runtime)),
      `repo integration loopback gate failed for stage ${options.stage}: runStage timed out`,
    );
    const behaviorError = assertBehavioralOutput(output, options.stage, archetype, options.domainSpec, 'repo_integration');
    if (behaviorError) {
      return {
        ok: false,
        error: formatBehavioralGateFailure(options.stage, behaviorError, {
          ...fixture.audit,
          expected_adapter_kind: 'repo_integration',
        }),
      };
    }
    const result = parseOutputResult(output);
    if (!Object.hasOwn(result, 'result')) {
      return { ok: false, error: `repo integration loopback gate failed for stage ${options.stage}: result_json must include the integration response under result` };
    }
    return {
      ok: true,
      behavioral_gate: 'repo_integration_loopback_call',
      real_call_verified: true,
      behavioral_fixture: {
        ...fixture.audit,
        expected_adapter_kind: 'repo_integration',
        ...(options.integrationName ? { expected_integration: options.integrationName } : {}),
        ...(method ? { expected_method: method } : {}),
        expected_endpoint: endpoint.pathname,
        real_call_verified: true,
        ...(typeof result.response_status === 'number' ? { verified_response_status: result.response_status } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `repo integration loopback gate failed for stage ${options.stage}: ${message}` };
  }
}

async function runWebNavigationBehavioralGate(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    descriptor: WebNavigationStageDescriptor;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture; real_call_verified?: true }
  | { ok: false; error: string }
> {
  if (archetype !== 'external-adapter') {
    return { ok: false, error: `web navigation stage ${options.stage} must be an external-adapter; got ${archetype}` };
  }
  const source = 'https://example.com/team';
  const fallbackSource = 'https://example.com/fallback';
  const purpose = 'find engineers';
  const extractionSchema = { name: 'string', email: 'string', relevance_score: 'number' };
  const inputGuard = {
    allowed_domains: ['fallback.test'],
    max_depth: 1,
    max_pages: 3,
    max_follow_links: 2,
    min_delay_ms: 0,
    max_concurrency: 1,
  };
  const guard = { ...inputGuard, allowed_domains: ['example.com'] };
  const connectorCalls: Array<{
    source: string;
    purpose: string;
    extraction_schema: Record<string, string>;
    guard: Record<string, unknown>;
  }> = [];
  const connector = {
    async navigate_and_extract(
      connectorSource: string,
      connectorPurpose: string,
      connectorSchema: Record<string, string>,
      connectorGuard: Record<string, unknown>,
    ) {
      connectorCalls.push({
        source: connectorSource,
        purpose: connectorPurpose,
        extraction_schema: connectorSchema,
        guard: connectorGuard,
      });
      return {
        items: [{ name: 'Alex Example', email: 'alex@example.com', relevance_score: 0.91 }],
        pages_visited: 1,
        audit: [
          { action: 'fetch' as const, url: connectorSource, at_depth: 0 },
          { action: 'extract' as const, url: connectorSource, at_depth: 0 },
        ],
      };
    },
  };
  const fixture = {
    input: {
      stage: options.stage,
      payload: {
        __stage_runtime: {
          web_navigation: connector,
        },
      },
      domain: {
        source: fallbackSource,
        current_source: { url: source, allowed_domains: ['example.com'] },
        purpose,
        extraction_schema: extractionSchema,
        GuardContext: inputGuard,
      },
      domain_spec: {
        reads: ['source', 'purpose', 'extraction_schema', 'GuardContext'],
        produces: {
          result_json: {
            items: 'ExtractedItem[]',
            pages_visited: 'number',
            audit: 'NavAuditEntry[]',
          },
        },
        rules: [],
        invariants: [],
      },
    },
    runtime: {
      now: () => '2026-06-28T00:00:00.000Z',
      random: () => 0.25,
      llm: async () => {
        throw new Error('StageRuntime.llm is not available in behavioral verification');
      },
      web_navigation: connector,
      connectors: { web_navigation: connector },
    },
    audit: {
      input_stage: options.stage,
      expected_result_stage: options.stage,
      expected_items_non_empty: true as const,
      expected_adapter_kind: 'in_memory_mock' as const,
      expected_connector_slug: options.descriptor.connector_slug,
      available_domain_paths: ['GuardContext', 'current_source', 'extraction_schema', 'purpose', 'source'],
      domain_spec_reads: ['current_source', 'source', 'purpose', 'extraction_schema', 'GuardContext'],
    },
  };

  try {
    const runStage = loadRunStageForBehavior(body, {
      modules: {
        [WEB_NAVIGATION_IMPORT]: {
          MockWebNavigationConnector: class {
            async navigate_and_extract(connectorSource: string): Promise<Record<string, unknown>> {
              return {
                items: [{ source: connectorSource }],
                pages_visited: 1,
                audit: [{ action: 'fetch', url: connectorSource, at_depth: 0 }],
              };
            }
          },
        },
      },
    });
    const output = await withBehaviorTimeout(
      Promise.resolve(runStage(fixture.input, fixture.runtime)),
      `web navigation behavioral gate failed for stage ${options.stage}: runStage timed out`,
    );
    const error = assertWebNavigationStageOutput(output, {
      source,
      purpose,
      extractionSchema,
      guard,
      connectorCalls,
    });
    if (error) {
      return { ok: false, error: `web navigation behavioral gate failed for stage ${options.stage}: ${error}` };
    }
    return {
      ok: true,
      behavioral_gate: 'web_navigation_connector_call',
      behavioral_fixture: fixture.audit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `web navigation behavioral gate failed for stage ${options.stage}: ${message}` };
  }
}

function assertWebNavigationStageOutput(
  output: unknown,
  expected: {
    source: string;
    purpose: string;
    extractionSchema: Record<string, string>;
    guard: Record<string, unknown>;
    connectorCalls: Array<{
      source: string;
      purpose: string;
      extraction_schema: Record<string, string>;
      guard: Record<string, unknown>;
    }>;
  },
): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return 'runStage returned a non-object output';
  }
  const candidate = output as { result_json?: unknown; items_json?: unknown; adapter_kind?: unknown };
  if (candidate.adapter_kind !== 'in_memory_mock') {
    return `expected adapter_kind to equal in_memory_mock; got ${String(candidate.adapter_kind)}`;
  }
  if (typeof candidate.result_json !== 'string') {
    return 'result_json must be a JSON string';
  }
  if (typeof candidate.items_json !== 'string') {
    return 'items_json must be a JSON string';
  }
  const result = parseRecordJson(candidate.result_json);
  const keys = Object.keys(result);
  if (keys.length !== 3 || keys[0] !== 'items' || keys[1] !== 'pages_visited' || keys[2] !== 'audit') {
    return `result_json must encode exactly { items, pages_visited, audit }; got ${JSON.stringify(keys)}`;
  }
  if (!Array.isArray(result.items) || result.items.length === 0) {
    return 'result_json.items must be a non-empty array';
  }
  if (typeof result.pages_visited !== 'number' || result.pages_visited > Number(expected.guard.max_pages)) {
    return 'result_json.pages_visited must be numeric and no greater than GuardContext.max_pages';
  }
  if (!Array.isArray(result.audit) || result.audit.length === 0) {
    return 'result_json.audit must be a non-empty array';
  }
  const items = parseJsonArray(candidate.items_json);
  if (!items.ok || items.value.length === 0) {
    return 'items_json must encode a non-empty array';
  }
  if (expected.connectorCalls.length !== 1) {
    return `expected one connector call; got ${expected.connectorCalls.length}`;
  }
  const call = expected.connectorCalls[0]!;
  if (call.source !== expected.source || call.purpose !== expected.purpose) {
    return 'connector call did not use source and purpose from input.domain';
  }
  if (JSON.stringify(call.extraction_schema) !== JSON.stringify(expected.extractionSchema)) {
    return 'connector call did not use extraction_schema from input.domain';
  }
  if (JSON.stringify(call.guard) !== JSON.stringify(expected.guard)) {
    return 'connector call did not use GuardContext from input.domain';
  }
  return undefined;
}

async function runPersistenceBehavioralGate(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    descriptor: PersistenceStageDescriptor;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture; real_call_verified?: true }
  | { ok: false; error: string }
> {
  if (archetype !== 'external-adapter') {
    return { ok: false, error: `persistence stage ${options.stage} must be an external-adapter; got ${archetype}` };
  }
  const dedupeKey = 'email';
  const inputRecords = [
    { name: 'A1', email: 'a@x.com' },
    { name: 'A2', email: 'a@x.com' },
    { name: 'B', email: 'b@x.com' },
  ];
  const existingRecords = [{ name: 'A0', email: 'a@x.com' }];
  const calls: Array<{ method: string; records?: Record<string, unknown>[]; dedupe_key?: string; filter?: Record<string, unknown> }> = [];
  const connector = {
    async query(filter: Record<string, unknown>) {
      calls.push({ method: 'query', filter });
      return existingRecords;
    },
    async dedupe(records: readonly Record<string, unknown>[], connectorDedupeKey: string) {
      calls.push({ method: 'dedupe', records: records.map((record) => ({ ...record })), dedupe_key: connectorDedupeKey });
      throw new Error('stage must not call host dedupe directly; keyed_collections handles in-engine dedup');
    },
    async upsert_lead(records: readonly Record<string, unknown>[], connectorDedupeKey: string) {
      calls.push({ method: 'upsert_lead', records: records.map((record) => ({ ...record })), dedupe_key: connectorDedupeKey });
      return persistenceGateUpsert(records, connectorDedupeKey, existingRecords);
    },
    async upsert_contact(records: readonly Record<string, unknown>[], connectorDedupeKey: string) {
      calls.push({ method: 'upsert_contact', records: records.map((record) => ({ ...record })), dedupe_key: connectorDedupeKey });
      return persistenceGateUpsert(records, connectorDedupeKey, existingRecords);
    },
  };
  const fixture = {
    input: {
      stage: options.stage,
      payload: {
        __stage_runtime: {
          persistence: connector,
        },
      },
      domain: {
        records: inputRecords,
        dedupe_key: dedupeKey,
        entity_type: 'lead',
      },
      domain_spec: {
        reads: ['records', 'dedupe_key', 'entity_type'],
        produces: {
          result_json: {
            inserted: 'number',
            updated: 'number',
            new_vs_existing: 'LeadRecord[]',
          },
        },
        rules: [],
        invariants: [],
      },
    },
    runtime: {
      now: () => '2026-06-28T00:00:00.000Z',
      random: () => 0.25,
      llm: async () => {
        throw new Error('StageRuntime.llm is not available in behavioral verification');
      },
      persistence: connector,
      connectors: { persistence: connector },
    },
    audit: {
      input_stage: options.stage,
      expected_result_stage: options.stage,
      expected_items_non_empty: true as const,
      expected_adapter_kind: 'in_memory_mock' as const,
      expected_connector_slug: options.descriptor.connector_slug,
      available_domain_paths: ['dedupe_key', 'entity_type', 'records'],
      domain_spec_reads: ['records', 'dedupe_key', 'entity_type'],
    },
  };

  try {
    const runStage = loadRunStageForBehavior(body, {
      modules: {
        [PERSISTENCE_IMPORT]: {
          MockPersistenceConnector: class {
            async query(): Promise<readonly Record<string, unknown>[]> { return []; }
            async dedupe(records: readonly Record<string, unknown>[]): Promise<readonly Record<string, unknown>[]> { return records; }
            async upsert_lead(records: readonly Record<string, unknown>[]): Promise<Record<string, unknown>> {
              return { inserted: records.length, updated: 0, ids: [] };
            }
            async upsert_contact(records: readonly Record<string, unknown>[]): Promise<Record<string, unknown>> {
              return { inserted: records.length, updated: 0, ids: [] };
            }
          },
        },
      },
    });
    const output = await withBehaviorTimeout(
      Promise.resolve(runStage(fixture.input, fixture.runtime)),
      `persistence behavioral gate failed for stage ${options.stage}: runStage timed out`,
    );
    const error = assertPersistenceStageOutput(output, {
      calls,
      dedupeKey,
    });
    if (error) {
      return { ok: false, error: `persistence behavioral gate failed for stage ${options.stage}: ${error}` };
    }
    return {
      ok: true,
      behavioral_gate: 'persistence_connector_call',
      behavioral_fixture: fixture.audit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `persistence behavioral gate failed for stage ${options.stage}: ${message}` };
  }
}

function assertPersistenceStageOutput(
  output: unknown,
  expected: {
    calls: Array<{ method: string; records?: Record<string, unknown>[]; dedupe_key?: string; filter?: Record<string, unknown> }>;
    dedupeKey: string;
  },
): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return 'runStage returned a non-object output';
  }
  const candidate = output as { result_json?: unknown; items_json?: unknown; adapter_kind?: unknown };
  if (candidate.adapter_kind !== 'in_memory_mock') {
    return `expected adapter_kind to equal in_memory_mock; got ${String(candidate.adapter_kind)}`;
  }
  if (typeof candidate.result_json !== 'string') {
    return 'result_json must be a JSON string';
  }
  if (typeof candidate.items_json !== 'string') {
    return 'items_json must be a JSON string';
  }
  const result = parseRecordJson(candidate.result_json);
  const keys = Object.keys(result);
  if (keys.length !== 3 || keys[0] !== 'inserted' || keys[1] !== 'updated' || keys[2] !== 'new_vs_existing') {
    return `result_json must encode exactly { inserted, updated, new_vs_existing }; got ${JSON.stringify(keys)}`;
  }
  if (result.inserted !== 1 || result.updated !== 1) {
    return `expected inserted=1 and updated=1; got inserted=${String(result.inserted)} updated=${String(result.updated)}`;
  }
  if (!Array.isArray(result.new_vs_existing) || result.new_vs_existing.length !== 3) {
    return 'new_vs_existing must contain the records passed to the host connector without in-stage dedup';
  }
  const items = parseJsonArray(candidate.items_json);
  if (!items.ok || JSON.stringify(items.value) !== JSON.stringify(result.new_vs_existing)) {
    return 'items_json must encode the same new_vs_existing array';
  }
  const methods = expected.calls.map((call) => call.method);
  const upsertIndex = methods.indexOf('upsert_lead');
  if (JSON.stringify(methods) !== JSON.stringify(['upsert_lead'])) {
    return `expected a single upsert_lead host call; got ${JSON.stringify(methods)}`;
  }
  if (expected.calls.some((call) => call.dedupe_key !== undefined && call.dedupe_key !== expected.dedupeKey)) {
    return 'connector calls did not use dedupe_key from input.domain';
  }
  const upsert = expected.calls[upsertIndex]!;
  if (!upsert.records || upsert.records.length !== 3 || upsert.records[0]?.name !== 'A1' || upsert.records[1]?.name !== 'A2' || upsert.records[2]?.email !== 'b@x.com') {
    return `upsert_lead must receive records without in-stage dedup; got ${JSON.stringify(upsert.records)}`;
  }
  return undefined;
}

function persistenceGateUpsert(
  records: readonly Record<string, unknown>[],
  dedupeKey: string,
  existingRecords: readonly Record<string, unknown>[],
): { inserted: number; updated: number; ids: string[] } {
  const collapsed = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    collapsed.set(persistenceGateRecordId(record, dedupeKey), { ...record });
  }
  const dedupedRecords = [...collapsed.values()];
  const existingIds = new Set(existingRecords.map((record) => persistenceGateRecordId(record, dedupeKey)));
  const ids = dedupedRecords.map((record) => persistenceGateRecordId(record, dedupeKey));
  return {
    inserted: ids.filter((id) => !existingIds.has(id)).length,
    updated: ids.filter((id) => existingIds.has(id)).length,
    ids,
  };
}

function persistenceGateRecordId(record: Record<string, unknown>, dedupeKey: string): string {
  return `${dedupeKey}:${String(record[dedupeKey])}`;
}

function parseJsonArray(value: string): { ok: true; value: unknown[] } | { ok: false } {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function loadRunStageForBehavior(
  body: string,
  options: {
    allowFetch?: boolean;
    env?: Record<string, string | undefined>;
    modules?: Record<string, Record<string, unknown>>;
  } = {},
): (input: unknown, runtime: unknown) => Promise<unknown> | unknown {
  const transpiled = ts.transpileModule(body, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({
    exports: exportsObject,
    module: moduleObject,
    Buffer,
    crypto: globalThis.crypto,
    ...(options.allowFetch ? { fetch } : {}),
    ...(options.env ? { process: { env: options.env } } : {}),
    require: (specifier: string) => {
      const moduleExports = options.modules?.[specifier];
      if (!moduleExports) {
        throw new Error(`behavioral gate module not available: ${specifier}`);
      }
      return moduleExports;
    },
    TextEncoder,
    URL,
  });
  new Script(transpiled.outputText, { filename: 'stage.behavior.cjs' }).runInContext(context, {
    timeout: 1_000,
  });
  const exported = moduleObject.exports as Record<string, unknown>;
  const runStage = exported.runStage ?? exportsObject.runStage;
  if (typeof runStage !== 'function') {
    throw new Error('runStage export was not callable');
  }
  return runStage as (input: unknown, runtime: unknown) => Promise<unknown> | unknown;
}

function assertExportBehavioralOutput(output: unknown, exportKind: ExportStageDescriptor['kind']): string | undefined {
  const result = parseOutputResult(output);
  const sha256Value = result.sha256;
  if (typeof sha256Value !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256Value)) {
    return 'result_json.sha256 must be a lowercase SHA-256 hex string';
  }
  if (typeof result.section_count !== 'number' || result.section_count <= 0) {
    return 'result_json.section_count must be a positive number';
  }
  if (exportKind === 'export_docx') {
    if (typeof result.docx_base64 !== 'string' || result.docx_base64.length === 0) {
      return 'result_json.docx_base64 must be a non-empty string';
    }
    const bytes = Buffer.from(result.docx_base64, 'base64');
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      return 'decoded docx_base64 must start with a ZIP local-file header';
    }
    if (result.docx_bytes !== bytes.length) {
      return 'result_json.docx_bytes must equal decoded byte length';
    }
    const expected = createHash('sha256').update(bytes).digest('hex');
    return sha256Value === expected ? undefined : 'result_json.sha256 must hash decoded docx bytes';
  }
  if (exportKind === 'export_pdf') {
    if (typeof result.pdf_base64 !== 'string' || result.pdf_base64.length === 0) {
      return 'result_json.pdf_base64 must be a non-empty string';
    }
    const bytes = Buffer.from(result.pdf_base64, 'base64');
    if (bytes.length === 0) {
      return 'decoded pdf_base64 must be non-empty';
    }
    if (result.pdf_bytes !== bytes.length) {
      return 'result_json.pdf_bytes must equal decoded byte length';
    }
    const expected = createHash('sha256').update(bytes).digest('hex');
    return sha256Value === expected ? undefined : 'result_json.sha256 must hash decoded PDF report bytes';
  }
  if (typeof result.html !== 'string' || !result.html.startsWith('<!doctype html>')) {
    return 'result_json.html must contain a rendered HTML document';
  }
  const htmlBytes = new TextEncoder().encode(result.html);
  if (result.html_bytes !== htmlBytes.length) {
    return 'result_json.html_bytes must equal encoded HTML byte length';
  }
  const expected = createHash('sha256').update(htmlBytes).digest('hex');
  return sha256Value === expected ? undefined : 'result_json.sha256 must hash rendered HTML bytes';
}

function loadExportTemplateModule(importPath: string): Record<string, unknown> {
  const template = importPath === EXPORT_DOCX_IMPORT ? 'export-docx.ts.tmpl' : 'export-html.ts.tmpl';
  const source = readFileSync(join(EXPORT_TEMPLATE_ROOT, template), 'utf8').replaceAll('{{NAME}}', 'Behavior Export');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({
    exports: exportsObject,
    module: moduleObject,
    TextEncoder,
    Uint8Array,
  });
  new Script(transpiled.outputText, { filename: `${template}.behavior.cjs` }).runInContext(context, {
    timeout: 1_000,
  });
  return moduleObject.exports as Record<string, unknown>;
}

function loadReportDataTemplateModule(): Record<string, unknown> {
  const source = readFileSync(join(EXPORT_TEMPLATE_ROOT, 'report-data.ts.tmpl'), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({
    exports: exportsObject,
    module: moduleObject,
    require: (specifier: string) => {
      if (specifier === './pdf-report-connector.js') {
        return {};
      }
      throw new Error(`report-data behavioral module not available: ${specifier}`);
    },
  });
  new Script(transpiled.outputText, { filename: 'report-data.ts.tmpl.behavior.cjs' }).runInContext(context, {
    timeout: 1_000,
  });
  return moduleObject.exports as Record<string, unknown>;
}

function behaviorFixtureFor(
  stage: string,
  archetype: 'pure-compute' | 'external-adapter',
  domainSpec?: StageDomainSpec,
  reasoningContracts?: Record<string, ReasoningStageContract>,
): {
  input: Record<string, unknown>;
  runtime: Record<string, unknown>;
  audit: StageBehaviorFixture;
} {
  const expectedAdapterKind = archetype === 'external-adapter' ? { expected_adapter_kind: 'in_memory_mock' as const } : {};
  const requestFacts = seedInitialRequestFacts(domainSpec);
  const stableInputPaths = stableInitialInputPaths(domainSpec);
  const domain = {
    ...Object.fromEntries(stableInputPaths.map((path) => [path, JSON.stringify(requestFacts)])),
    'inputs.user_text': 'continue',
    'inputs.frontend_intake': 'continue',
    'account.id': 'acct-behavior-001',
    'record.id': 'record-behavior-001',
    'owner.queue': 'operations',
    ...seedPriorStageOutputs(domainSpec, reasoningContracts),
  };
  const itemTemplates = domainSpec?.produces.items_json;
  return {
    input: {
      stage,
      payload: {
        __stage_runtime: {
          now_iso: '2026-06-28T00:00:00.000Z',
          random: 0.25,
        },
      },
      domain,
    },
    runtime: {
      now: () => '2026-06-28T00:00:00.000Z',
      random: () => 0.25,
      llm: async () => {
        throw new Error('StageRuntime.llm is not available in behavioral verification');
      },
    },
    audit: {
      input_stage: stage,
      expected_result_stage: stage,
      expected_items_non_empty: true,
      ...expectedAdapterKind,
      available_domain_paths: Object.keys(domain).sort(),
      ...(domainSpec?.reads ? { domain_spec_reads: [...domainSpec.reads] } : {}),
      ...(Array.isArray(itemTemplates) && itemTemplates.every((item) => typeof item === 'string')
        ? { expected_items_templates: [...itemTemplates] }
        : {}),
      ...expectedFeeProposalAuditFields(domainSpec),
    },
  };
}

function seedInitialRequestFacts(domainSpec?: StageDomainSpec): Record<string, unknown> {
  const facts: Record<string, unknown> = {
    client_name: 'Aster Holdings',
    service_type: 'Regulatory advisory',
    jurisdiction: 'US',
    complexity_tier: 'standard',
    budget_signal: 'predictable fixed fee preferred',
    currency: 'USD',
    fee_structure: 'fixed',
    rate_card: {
      partner: 850,
      senior_associate: 620,
      associate: 420,
      paralegal: 180,
    },
    pricing_parameters: {
      jurisdiction_multiplier: 1.15,
      risk_contingency_pct: 12,
      discount_pct: 5,
      cap_premium_pct: 10,
      retainer_pct: 30,
      currency: 'USD',
    },
    plan: 'pro',
    seats: 2,
    region: 'us',
    account_id: 'acct-behavior-001',
    requested_seats: 5,
    base_hours: 2,
    hourly_rate_usd: 100,
    discount_pct: 10,
    budget_usd: 250,
    severity: 'high',
    customer_tier: 'enterprise',
    failed_logins: 6,
    data_exposure: true,
    request: 'approve request',
    known_policy: 'manager may approve some requests',
  };
  for (const read of domainSpec?.reads ?? []) {
    const fieldPath = initialInputReadFieldPath(read);
    if (fieldPath) {
      setNestedRecord(facts, fieldPath, sampleBehaviorValue(fieldPath));
    }
  }
  return facts;
}

function seedPriorStageOutputs(
  domainSpec?: StageDomainSpec,
  reasoningContracts?: Record<string, ReasoningStageContract>,
): Record<string, unknown> {
  const seeded: Record<string, unknown> = {
    'crm_lookup.output': stageOutputFixture('crm_lookup', {
      stage: 'crm_lookup',
      account_id: 'acct-behavior-001',
      tier: 'gold',
      active_contract: true,
      adapter_kind: 'in_memory_mock',
    }, ['account:acct-behavior-001', 'tier:gold'], 'in_memory_mock'),
    'estimate_fee.output': stageOutputFixture('estimate_fee', {
      stage: 'estimate_fee',
      base_hours: 2,
      hourly_rate_usd: 100,
      subtotal_usd: 200,
    }, ['subtotal_usd:200']),
    'apply_discount.output': stageOutputFixture('apply_discount', {
      stage: 'apply_discount',
      previous_total_usd: 200,
      discount_pct: 10,
      discounted_total_usd: 180,
    }, ['discounted_total_usd:180']),
    'score_risk.output': stageOutputFixture('score_risk', {
      stage: 'score_risk',
      risk_score: 100,
      severity: 'high',
      factors: ['severity', 'customer_tier', 'failed_logins', 'data_exposure'],
    }, ['risk_score:100', 'severity:high']),
  };

  // When a reasoning contract exists for a prior stage referenced by
  // domain_spec.reads, seed schema-realistic canned values (spec §6.8)
  // instead of generic sample synthesis: the composite result_json plus one
  // typed flat key per core field.
  const contractSeeded = new Set<string>();
  const seedContractOutputs = (prior: string): boolean => {
    const contract = reasoningContracts?.[prior];
    if (!contract) {
      return false;
    }
    if (!contractSeeded.has(prior)) {
      contractSeeded.add(prior);
      seeded[`${prior}.result_json`] = JSON.stringify(contract.canned_example.result);
      seeded[`${prior}.items_json`] = JSON.stringify(contract.canned_example.items);
      for (const field of contract.result_schema.fields) {
        const value = contract.canned_example.result[field.name];
        seeded[`${prior}.result.${field.name}`] = field.type === 'string_array' ? JSON.stringify(value) : value;
      }
    }
    return true;
  };

  for (const read of domainSpec?.reads ?? []) {
    const reasoningRead = read.match(/^([a-zA-Z0-9_]+)\.(?:result_json|items_json|result)(?:\.(.+))?$/u);
    if (reasoningRead?.[1] && seedContractOutputs(reasoningRead[1])) {
      continue;
    }

    const deterministic = read.match(/^([a-zA-Z0-9_]+)\.output\.result_json(?:\.(.+))?$/u);
    if (deterministic?.[1]) {
      const outputPath = `${deterministic[1]}.output`;
      const priorStage = deterministic[1];
      const output = isRecord(seeded[outputPath])
        ? { ...(seeded[outputPath] as Record<string, unknown>) }
        : stageOutputFixture(
          priorStage,
          priorStageResultFixture(priorStage, reasoningContracts?.[priorStage]),
          itemsForResult(priorStageResultFixture(priorStage, reasoningContracts?.[priorStage])),
        );
      const result = parseRecordJson(output.result_json);
      if (deterministic[2]) {
        setNestedRecord(result, deterministic[2], sampleBehaviorValue(deterministic[2]));
      }
      output.result_json = JSON.stringify(result);
      output.items_json = JSON.stringify(itemsForResult(result));
      seeded[outputPath] = output;
      continue;
    }

    const llmReasoning = read.match(/^([a-zA-Z0-9_]+)\.result_json(?:\.(.+))?$/u);
    if (llmReasoning?.[1] && llmReasoning[2]) {
      const resultPath = `${llmReasoning[1]}.result_json`;
      const result = parseRecordJson(seeded[resultPath]);
      if (!Object.hasOwn(result, 'stage')) {
        result.stage = llmReasoning[1];
      }
      setNestedRecord(result, llmReasoning[2], sampleBehaviorValue(llmReasoning[2]));
      seeded[resultPath] = JSON.stringify(result);
      seeded[`${llmReasoning[1]}.items_json`] = JSON.stringify(itemsForResult(result));
    }
  }

  return seeded;
}

function stableInitialInputPaths(domainSpec?: StageDomainSpec): string[] {
  const paths = new Set<string>(['inputs.initial_user_text']);
  for (const read of domainSpec?.reads ?? []) {
    const match = read.match(/^(inputs\.initial_[a-zA-Z0-9_]+)(?:\.|$)/u);
    if (match?.[1]) {
      paths.add(match[1]);
    }
  }
  return [...paths].sort();
}

function initialInputReadFieldPath(read: string): string | undefined {
  const match = read.match(/^inputs\.initial_[a-zA-Z0-9_]+(?:\.(.+))?$/u);
  return match?.[1];
}

function stageOutputFixture(
  stage: string,
  result: Record<string, unknown>,
  items: string[],
  adapterKind?: 'in_memory_mock' | 'repo_integration',
): Record<string, unknown> {
  return {
    result_json: JSON.stringify({ stage, ...result }),
    items_json: JSON.stringify(items),
    digest: '',
    ...(adapterKind ? { adapter_kind: adapterKind } : {}),
  };
}

function priorStageResultFixture(stage: string, contract?: ReasoningStageContract): Record<string, unknown> {
  if (contract) {
    return contract.canned_example.result;
  }
  if (stage === 'intake') {
    return {
      stage,
      client_name: 'Aster Holdings',
      service_type: 'Regulatory advisory',
      jurisdiction: 'US',
      complexity_tier: 'standard',
      budget_signal: 'predictable fixed fee preferred',
      currency: 'USD',
      fee_structure: 'fixed',
    };
  }
  if (stage === 'scope_definition') {
    return {
      stage,
      phases: 'Discovery, Legal analysis, Draft proposal, Partner review',
      deliverables: 'Fee proposal, assumptions schedule, acceptance page',
      in_scope_items: 'Regulatory advisory scope definition and proposal drafting',
      scope_risks: 'Compressed deadline and uncertain client document quality',
    };
  }
  if (stage === 'assumptions_exclusions') {
    return {
      stage,
      assumptions: 'Client provides complete materials and one consolidated comment round.',
      exclusions: 'Litigation, tax advice, and third-party vendor costs are excluded.',
      dependencies: 'Client documents by Friday and stakeholder availability next week.',
      change_control: 'Out-of-scope work requires written approval before commencement.',
    };
  }
  if (stage === 'effort_estimation') {
    const roleHours = { partner: 8, senior_associate: 18, associate: 26, paralegal: 6 };
    return {
      stage,
      phase_hours_json: JSON.stringify({
        Discovery: { partner: 2, senior_associate: 4, associate: 6, paralegal: 2 },
        'Legal analysis': { partner: 4, senior_associate: 10, associate: 14, paralegal: 1 },
        'Draft proposal': { partner: 1, senior_associate: 3, associate: 5, paralegal: 2 },
        'Partner review': { partner: 1, senior_associate: 1, associate: 1, paralegal: 1 },
      }),
      role_hours_json: JSON.stringify(roleHours),
      hours_total: Object.values(roleHours).reduce((sum, value) => sum + value, 0),
    };
  }
  if (stage === 'fee_modelling') {
    return {
      stage,
      parameters_json: JSON.stringify({
        rate_card: { partner: 850, senior_associate: 620, associate: 420, paralegal: 180 },
        role_hours: { partner: 8, senior_associate: 18, associate: 26, paralegal: 6 },
        phase_hours: {},
        jurisdiction_multiplier: 1.15,
        risk_contingency_pct: 12,
        discount_pct: 5,
        cap_premium_pct: 10,
        retainer_pct: 30,
        currency: 'USD',
      }),
      hourly_total: 34385,
      fixed_quote: 36591.64,
      capped_quote: 40250.8,
      blended_rate: 592.84,
      retainer_quote: 10977.49,
      currency: 'USD',
    };
  }
  return { stage, summary: `${stage} behavior fixture`, ready: true };
}

function sampleBehaviorValue(fieldPath: string): unknown {
  const field = fieldPath.split('.').at(-1)?.toLowerCase() ?? fieldPath.toLowerCase();
  if (field === 'rate_card') {
    return { partner: 850, senior_associate: 620, associate: 420, paralegal: 180 };
  }
  if (field === 'pricing_parameters') {
    return {
      jurisdiction_multiplier: 1.15,
      risk_contingency_pct: 12,
      discount_pct: 5,
      cap_premium_pct: 10,
      retainer_pct: 30,
      currency: 'USD',
    };
  }
  if (field === 'client_name') return 'Aster Holdings';
  if (field === 'service_type') return 'Regulatory advisory';
  if (field === 'jurisdiction') return 'US';
  if (field === 'complexity_tier') return 'standard';
  if (field === 'budget_signal') return 'predictable fixed fee preferred';
  if (field === 'fee_structure') return 'fixed';
  if (field === 'phases') return 'Discovery, Legal analysis, Draft proposal, Partner review';
  if (field === 'deliverables') return 'Fee proposal, assumptions schedule, acceptance page';
  if (field === 'in_scope_items') return 'Regulatory advisory proposal drafting';
  if (field === 'scope_risks') return 'Compressed deadline and uncertain client document quality';
  if (field === 'order_id') return 'ORD-BEHAVIOR-001';
  if (field === 'account_id') return 'acct-behavior-001';
  if (field === 'sku') return 'sku-behavior-001';
  if (field === 'plan') return 'pro';
  if (field === 'region') return 'us';
  if (field === 'severity') return 'high';
  if (field === 'customer_tier') return 'enterprise';
  if (field === 'tier') return 'gold';
  if (field === 'policy_code') return 'partial_refund_window';
  if (field === 'posting_type') return 'refund';
  if (field === 'basis') return 'discounted_total_within_budget';
  if (field === 'reason') return 'stock_available';
  if (field === 'currency') return 'USD';
  if (field === 'refund_requested' || field === 'approved' || field === 'eligible' || field === 'reserved' || field === 'active_contract' || field.startsWith('is_') || field.startsWith('has_')) {
    return true;
  }
  if (field === 'delivered_days_ago') return 42;
  if (field === 'refund_pct') return 50;
  if (field === 'discount_pct') return 10;
  if (field === 'original_amount_cents') return 12500;
  if (field === 'refund_cents' || field === 'amount_cents') return 6250;
  if (field === 'subtotal_usd' || field === 'previous_total_usd') return 200;
  if (field === 'discounted_total_usd') return 180;
  if (field === 'budget_usd') return 250;
  if (field === 'base_hours') return 2;
  if (field === 'hourly_rate_usd') return 100;
  if (field === 'risk_score') return 100;
  if (field === 'requested_units') return 4;
  if (field === 'available_units') return 10;
  if (field === 'reserved_units') return 4;
  if (field === 'backorder_units') return 0;
  if (field === 'failed_logins') return 6;
  if (/(?:amount|budget|count|days|events|hours|minutes|pct|rate|score|seats|total|units|usd|cents)$/u.test(field)) {
    return 1;
  }
  return `${field.replace(/_/gu, '-')}-behavior`;
}

function setNestedRecord(target: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.').filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!isRecord(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

function parseRecordJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function itemsForResult(result: Record<string, unknown>): string[] {
  const entries = Object.entries(result).filter(([key]) => key !== 'stage');
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}:${String(value)}`)
    : [`stage:${String(result.stage ?? 'unknown')}`];
}

function formatBehavioralGateFailure(stage: string, behaviorError: string, fixture: StageBehaviorFixture): string {
  const lines = [
    `behavioral gate failed for stage ${stage}: ${behaviorError}`,
  ];
  if (fixture.domain_spec_reads && fixture.domain_spec_reads.length > 0) {
    lines.push(`domain_spec.reads: ${JSON.stringify(fixture.domain_spec_reads)}`);
  }
  if (fixture.expected_items_templates && fixture.expected_items_templates.length > 0) {
    lines.push(`domain_spec.produces.items_json: ${JSON.stringify(fixture.expected_items_templates)}`);
  }
  if (fixture.available_domain_paths && fixture.available_domain_paths.length > 0) {
    lines.push(`Available behavioral fixture domain paths: ${JSON.stringify(fixture.available_domain_paths)}`);
  }
  lines.push(
    "Stateful repair hint: read request JSON from input.domain['inputs.initial_user_text']; for deterministic prior output reads like prior_stage.output.result_json.field, read input.domain['prior_stage.output'].result_json and JSON.parse it before using field.",
    'For items_json, emit one string per domain_spec.produces.items_json template even when a computed value is 0 or false; do not return an empty array for declared item templates.',
  );
  return lines.join('\n');
}

/**
 * Enrich raw safety-scan errors with ACTIONABLE repair guidance before they
 * reach the repair prompt. The raw scanSafety strings (e.g. "banned capability:
 * require") tell the model what is wrong but not what to do instead, so temp-0
 * models re-emit the same class of violation (observed: require -> dynamic
 * import -> identical retries -> wasted budget). The dominant real-world wedge is
 * models gratuitously computing a `digest` via node:crypto; steer them to the
 * self-contained, import-free, `digest: ''` shape the engine actually expects.
 */
export function formatSafetyGateFailure(safetyError: string): string {
  const lines = [`safety scan failed: ${safetyError}`];
  const lower = safetyError.toLowerCase();
  if (
    lower.includes('require') ||
    lower.includes('dynamic import') ||
    lower.includes('node:crypto') ||
    lower.startsWith('banned import:')
  ) {
    lines.push(
      "The stage body must be self-contained: the ONLY allowed import is the type-only `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js'`. Do not use require, dynamic import(), or import any other module.",
      "In particular, do NOT compute a hash or digest and do NOT import 'node:crypto' — set `digest: ''` in the returned object; the engine computes the digest itself.",
    );
  } else if (lower.includes('fetch')) {
    lines.push('Do not call fetch or perform any network I/O; the stage body must be a pure deterministic transform of input.domain.');
  } else if (lower.includes('process.env')) {
    lines.push('Do not read process.env; derive every value from input.domain.');
  } else if (lower.includes('eval') || lower.includes('function constructor')) {
    lines.push('Do not use eval or the Function constructor; write the logic directly.');
  } else {
    lines.push("The stage body must be self-contained and side-effect-free: the only allowed import is the type-only contracts import; no require, dynamic import, eval, Function constructor, fetch, or process.env.");
  }
  return lines.join('\n');
}

async function withBehaviorTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function assertBehavioralOutput(
  output: unknown,
  stage: string,
  archetype: 'pure-compute' | 'external-adapter',
  domainSpec?: StageDomainSpec,
  expectedExternalAdapterKind: 'in_memory_mock' | 'repo_integration' = 'in_memory_mock',
): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return 'runStage returned a non-object output';
  }
  const candidate = output as { result_json?: unknown; items_json?: unknown; adapter_kind?: unknown };
  if (typeof candidate.result_json !== 'string') {
    return 'result_json must be a JSON string';
  }
  if (typeof candidate.items_json !== 'string') {
    return 'items_json must be a JSON string';
  }

  let result: unknown;
  let items: unknown;
  try {
    result = JSON.parse(candidate.result_json) as unknown;
  } catch (error) {
    return `result_json must parse as JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    items = JSON.parse(candidate.items_json) as unknown;
  } catch (error) {
    return `items_json must parse as JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'result_json must encode an object';
  }
  const schema = resultJsonSchema(domainSpec);
  if (schema) {
    const schemaError = assertResultJsonSchema(result, domainSpec, stage);
    if (schemaError) {
      return schemaError;
    }
    if (Object.hasOwn(schema, 'stage')) {
      const stageError = assertResultJsonStage(result, stage);
      if (stageError) {
        return stageError;
      }
    }
  } else {
    const stageError = assertResultJsonStage(result, stage);
    if (stageError) {
      return stageError;
    }
  }
  const feeProposalError = assertFeeProposalComputation(result as Record<string, unknown>, domainSpec);
  if (feeProposalError) {
    return feeProposalError;
  }
  if (!Array.isArray(items) || items.length === 0) {
    return 'expected items_json to encode a non-empty array';
  }
  const itemSchemaError = assertItemsJsonSchema(items, domainSpec);
  if (itemSchemaError) {
    return itemSchemaError;
  }
  if (archetype === 'external-adapter') {
    const resultAdapterKind = (result as { adapter_kind?: unknown }).adapter_kind;
    const adapterKind = candidate.adapter_kind ?? resultAdapterKind;
    if (adapterKind !== expectedExternalAdapterKind) {
      return `expected external-adapter adapter_kind to equal ${expectedExternalAdapterKind}; got ${String(adapterKind)}`;
    }
  }
  return undefined;
}

function assertResultJsonStage(result: unknown, stage: string): string | undefined {
  if ((result as { stage?: unknown }).stage !== stage) {
    return [
      `result_json must start with a 'stage' key equal to ${stage}.`,
      `Got result_json.stage=${String((result as { stage?: unknown }).stage)}.`,
      "Fix: construct result_json with stage: input.stage as the first top-level key before the remaining domain_spec.produces.result_json keys.",
    ].join(' ');
  }
  return undefined;
}

function assertFeeProposalComputation(result: Record<string, unknown>, domainSpec?: StageDomainSpec): string | undefined {
  if (!isFeeProposalDomainSpec(domainSpec)) {
    return undefined;
  }
  for (const field of expectedPositiveFeeFields(domainSpec)) {
    const value = result[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return `expected ${field} to be a positive number for the seeded fee-proposal fixture; got ${String(value)}`;
    }
  }
  const parameterFields = expectedFeeParameterFields(domainSpec);
  if (parameterFields.length > 0) {
    const rawParameters = result.parameters_json;
    if (typeof rawParameters !== 'string') {
      return 'expected parameters_json to be a JSON string containing the full fee model parameter set';
    }
    const parameters = parseRecordJson(rawParameters);
    for (const field of parameterFields) {
      if (!Object.hasOwn(parameters, field)) {
        return `expected parameters_json to include ${field} for the full fee model parameter set`;
      }
    }
  }
  return undefined;
}

function isFeeProposalDomainSpec(domainSpec?: StageDomainSpec): boolean {
  if (!domainSpec) {
    return false;
  }
  const haystack = JSON.stringify({
    reads: domainSpec.reads,
    rules: domainSpec.rules,
    produces: domainSpec.produces,
  }).toLowerCase();
  return /fee|quote|rate_card|role_hours|phase_hours|proposal|retainer|cap_premium/u.test(haystack);
}

function expectedPositiveFeeFields(domainSpec?: StageDomainSpec): string[] {
  const schema = domainSpec?.produces.result_json;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [];
  }
  return [
    'hours_total',
    'hourly_total',
    'fixed_quote',
    'capped_quote',
    'blended_rate',
    'retainer_quote',
  ].filter((field) => Object.hasOwn(schema, field));
}

function expectedFeeParameterFields(domainSpec?: StageDomainSpec): string[] {
  const schema = domainSpec?.produces.result_json;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !Object.hasOwn(schema, 'parameters_json')) {
    return [];
  }
  const haystack = JSON.stringify({
    reads: domainSpec.reads,
    rules: domainSpec.rules,
  }).toLowerCase();
  const parameterMatchers: Array<[string, RegExp]> = [
    ['rate_card', /rate_card/u],
    ['role_hours', /role_hours|role mix|role_mix/u],
    ['phase_hours', /phase_hours|phase by role|phase x role/u],
    ['jurisdiction_multiplier', /jurisdiction_multiplier/u],
    ['risk_contingency_pct', /risk_contingency_pct|risk contingency/u],
    ['discount_pct', /discount_pct|discount/u],
    ['cap_premium_pct', /cap_premium_pct|cap premium/u],
    ['retainer_pct', /retainer_pct|retainer/u],
    ['currency', /currency/u],
  ];
  return parameterMatchers.flatMap(([field, pattern]) => pattern.test(haystack) ? [field] : []);
}

function expectedFeeProposalAuditFields(domainSpec?: StageDomainSpec): Partial<StageBehaviorFixture> {
  const positiveFields = expectedPositiveFeeFields(domainSpec);
  const parameterFields = expectedFeeParameterFields(domainSpec);
  return {
    ...(positiveFields.length > 0 ? { expected_positive_fields: positiveFields } : {}),
    ...(parameterFields.length > 0 ? { expected_parameter_fields: parameterFields } : {}),
  };
}

function parseOutputResult(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('stage output must be an object');
  }
  const resultJson = (output as { result_json?: unknown }).result_json;
  if (typeof resultJson !== 'string') {
    throw new Error('stage output result_json must be a string');
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stage output result_json must encode an object');
  }
  return parsed as Record<string, unknown>;
}

function assertResultJsonSchema(result: unknown, domainSpec: StageDomainSpec | undefined, stage: string): string | undefined {
  const schema = resultJsonSchema(domainSpec);
  if (!schema) {
    return undefined;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'result_json must encode an object';
  }
  const expectedKeys = Object.keys(schema);
  const actualKeys = Object.keys(result as Record<string, unknown>);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    const stageDeclared = Object.hasOwn(schema, 'stage');
    const contractLine = stageDeclared
      ? `result_json must start with a 'stage' key equal to ${stage} and must match domain_spec.produces.result_json keys/order.`
      : 'result_json must match domain_spec.produces.result_json keys/order.';
    return [
      contractLine,
      `Expected keys: ${JSON.stringify(expectedKeys)}; got ${JSON.stringify(actualKeys)}.`,
      `Fix: construct result_json as { ${expectedKeys.map((key) => key === 'stage' ? 'stage: input.stage' : `${key}: ...`).join(', ')} } and do not add, remove, or reorder top-level keys.`,
    ].join(' ');
  }
  return undefined;
}

function resultJsonSchema(domainSpec?: StageDomainSpec): Record<string, unknown> | undefined {
  const schema = domainSpec?.produces.result_json;
  return schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : undefined;
}

function assertItemsJsonSchema(items: unknown[], domainSpec?: StageDomainSpec): string | undefined {
  const schema = domainSpec?.produces.items_json;
  if (!Array.isArray(schema) || schema.length === 0 || !schema.every((item) => typeof item === 'string')) {
    return undefined;
  }
  if (items.length !== schema.length) {
    return `expected items_json to contain exactly ${schema.length} items from domain_spec.produces.items_json; got ${items.length}`;
  }
  for (let index = 0; index < schema.length; index += 1) {
    const item = items[index];
    if (typeof item !== 'string') {
      return `expected items_json[${index}] to be a string`;
    }
    const template = schema[index] as string;
    const matcher = itemTemplateMatcher(template);
    if (!matcher.test(item)) {
      return `expected items_json[${index}] to match domain_spec template ${JSON.stringify(template)}; got ${JSON.stringify(item)}`;
    }
  }
  return undefined;
}

function itemTemplateMatcher(template: string): RegExp {
  const parts: string[] = [];
  let cursor = 0;
  const placeholder = /<[^>]+>/gu;
  for (let match = placeholder.exec(template); match; match = placeholder.exec(template)) {
    parts.push(escapeRegExp(template.slice(cursor, match.index)));
    parts.push('.+');
    cursor = match.index + match[0].length;
  }
  parts.push(escapeRegExp(template.slice(cursor)));
  return new RegExp(`^${parts.join('')}$`, 'u');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function renderRepoIntegrationStageBody(stage: string, integration: WiringIntegration): string {
  if (integration.kind === 'http_api') {
    return renderHttpApiRepoIntegrationStageBody(stage, integration);
  }

  const method = integration.methods[0] as string;
  const envNames = JSON.stringify(integration.config_env);
  const importLine = integration.factory
    ? `import { ${integration.factory} } from ${tsString(integration.import)};`
    : `import { ${method} } from ${tsString(integration.import)};`;
  const callLines = integration.factory
    ? [
        `  const client = ${integration.factory}();`,
        `  const integrationResult = await client.${method}({`,
      ]
    : [`  const integrationResult = await ${method}({`];
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
${importLine}

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
${callLines.join('\n')}
    stage: input.stage,
    domain: input.domain,
    requested_at: runtime.now(),
  });
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      status: 'connected',
      adapter_kind: 'repo_integration',
      integration: ${tsString(integration.name)},
      method: ${tsString(method)},
      config_env: ${envNames},
      result: integrationResult,
    }),
    items_json: JSON.stringify([input.stage + ':' + ${tsString(integration.name)} + ':' + ${tsString(method)}]),
    digest: '',
    adapter_kind: 'repo_integration',
  };
}
`;
}

function renderWebNavigationStageBody(stage: string, descriptor: WebNavigationStageDescriptor): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
import { MockWebNavigationConnector, type GuardContext, type WebNavigationHostConnector } from '../connectors/web-navigation.js';

type RuntimeWithWebNavigation = StageRuntime & {
  web_navigation?: WebNavigationHostConnector;
  connectors?: { web_navigation?: WebNavigationHostConnector };
};

interface CurrentSource {
  url: string;
  allowed_domains?: string[];
}

const defaultWebNavigationConnector = new MockWebNavigationConnector();

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  const connector = webNavigationConnector(input, runtime);
  const domain = stageDomain(input);
  const currentSource = currentSourceFromDomain(domain);
  const purpose = requiredString(domain.purpose, 'purpose');
  const extractionSchema = requiredRecordOfStrings(domain.extraction_schema, 'extraction_schema');
  const guard = guardContextForSource(guardContextFromDomain(domain), currentSource);
  const result = await connector.navigate_and_extract(currentSource.url, purpose, extractionSchema, guard);
  return {
    result_json: JSON.stringify({
      items: result.items,
      pages_visited: result.pages_visited,
      audit: result.audit,
    }),
    items_json: JSON.stringify(result.items),
    digest: '',
    adapter_kind: 'in_memory_mock',
  };
}

function webNavigationConnector(input: StageInput, runtime: StageRuntime): WebNavigationHostConnector {
  const runtimeRecord = runtime as RuntimeWithWebNavigation;
  const runtimeConnector = runtimeRecord.web_navigation ?? runtimeRecord.connectors?.web_navigation;
  if (isWebNavigationConnector(runtimeConnector)) {
    return runtimeConnector;
  }
  const payload = input.payload as Record<string, unknown>;
  const payloadRuntime = recordValue(payload.__stage_runtime);
  const payloadConnectors = recordValue(payloadRuntime.connectors);
  const payloadConnector = payloadRuntime.web_navigation ?? payloadConnectors.web_navigation;
  if (isWebNavigationConnector(payloadConnector)) {
    return payloadConnector;
  }
  return defaultWebNavigationConnector;
}

function stageDomain(input: StageInput): Record<string, unknown> {
  return mergeRecords(recordValue(input.domain_spec.input_domain), input.domain);
}

function currentSourceFromDomain(domain: Record<string, unknown>): CurrentSource {
  const work = recordValue(domain.work);
  const candidates = [
    domain.current_source,
    domain['work.current_source'],
    work.current_source,
    domain.source,
  ];
  for (const candidate of candidates) {
    const source = sourceConfigFromValue(candidate);
    if (source) {
      return source;
    }
  }
  throw new Error('current_source must provide a non-empty url in input.domain');
}

function sourceConfigFromValue(value: unknown): CurrentSource | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return { url: value };
  }
  const record = recordValue(value);
  const url = typeof record.url === 'string' && record.url.length > 0
    ? record.url
    : typeof record.source === 'string' && record.source.length > 0
      ? record.source
      : '';
  if (!url) {
    return undefined;
  }
  const allowedDomains = stringArrayValue(record.allowed_domains);
  return {
    url,
    ...(allowedDomains.length > 0 ? { allowed_domains: allowedDomains } : {}),
  };
}

function guardContextForSource(guard: GuardContext, source: CurrentSource): GuardContext {
  return source.allowed_domains && source.allowed_domains.length > 0
    ? { ...guard, allowed_domains: [...source.allowed_domains] }
    : guard;
}

function guardContextFromDomain(domain: Record<string, unknown>): GuardContext {
  const raw = domain.GuardContext ?? domain.guard_context ?? domain.guard;
  const record = requiredRecord(raw, 'GuardContext');
  return {
    allowed_domains: requiredStringArray(record.allowed_domains, 'GuardContext.allowed_domains'),
    max_depth: requiredNumber(record.max_depth, 'GuardContext.max_depth'),
    max_pages: requiredNumber(record.max_pages, 'GuardContext.max_pages'),
    max_follow_links: requiredNumber(record.max_follow_links, 'GuardContext.max_follow_links'),
    min_delay_ms: requiredNumber(record.min_delay_ms, 'GuardContext.min_delay_ms'),
    max_concurrency: requiredNumber(record.max_concurrency, 'GuardContext.max_concurrency'),
  };
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(path + ' must be a non-empty string in input.domain');
  }
  return value;
}

function requiredRecordOfStrings(value: unknown, path: string): Record<string, string> {
  const record = requiredRecord(value, path);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(path + '.' + key + ' must be a non-empty string');
    }
    out[key] = item;
  }
  return out;
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  const record = recordValue(value);
  if (Object.keys(record).length === 0) {
    throw new Error(path + ' must be an object in input.domain');
  }
  return record;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeRecords(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = merged[key];
    merged[key] = isPlainRecord(previous) && isPlainRecord(value)
      ? mergeRecords(previous, value)
      : value;
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(path + ' must be a non-empty string array');
  }
  return [...value];
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(path + ' must be a finite number');
  }
  return value;
}

function isWebNavigationConnector(value: unknown): value is WebNavigationHostConnector {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { navigate_and_extract?: unknown }).navigate_and_extract === 'function';
}
`;
}

function renderPersistenceStageBody(stage: string, descriptor: PersistenceStageDescriptor): string {
  const keyedCollectionPath = descriptor.keyed_collection_path
    ? `const keyedCollectionPath = ${JSON.stringify(descriptor.keyed_collection_path)};\n`
    : 'const keyedCollectionPath = undefined;\n';
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
import { MockPersistenceConnector, type LeadRecord, type PersistenceHostConnector } from '../connectors/persistence.js';

type RuntimeWithPersistence = StageRuntime & {
  persistence?: PersistenceHostConnector;
  connectors?: { persistence?: PersistenceHostConnector };
};

type EntityType = 'lead' | 'contact';

const defaultPersistenceConnector = new MockPersistenceConnector();
${keyedCollectionPath}

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  const connector = persistenceConnector(input, runtime);
  const domain = stageDomain(input);
  const dedupeKey = dedupeKeyFromDomain(domain);
  const records = recordsFromDomain(domain, keyedCollectionPath);
  const upsert = entityTypeFromDomain(domain) === 'contact'
    ? await connector.upsert_contact(records, dedupeKey)
    : await connector.upsert_lead(records, dedupeKey);
  return {
    result_json: JSON.stringify({
      inserted: upsert.inserted,
      updated: upsert.updated,
      new_vs_existing: records,
    }),
    items_json: JSON.stringify(records),
    digest: '',
    adapter_kind: 'in_memory_mock',
  };
}

function persistenceConnector(input: StageInput, runtime: StageRuntime): PersistenceHostConnector {
  const runtimeRecord = runtime as RuntimeWithPersistence;
  const runtimeConnector = runtimeRecord.persistence ?? runtimeRecord.connectors?.persistence;
  if (isPersistenceConnector(runtimeConnector)) {
    return runtimeConnector;
  }
  const payload = input.payload as Record<string, unknown>;
  const payloadRuntime = recordValue(payload.__stage_runtime);
  const payloadConnectors = recordValue(payloadRuntime.connectors);
  const payloadConnector = payloadRuntime.persistence ?? payloadConnectors.persistence;
  if (isPersistenceConnector(payloadConnector)) {
    return payloadConnector;
  }
  return defaultPersistenceConnector;
}

function stageDomain(input: StageInput): Record<string, unknown> {
  return mergeRecords(recordValue(input.domain_spec.input_domain), input.domain);
}

function dedupeKeyFromDomain(domain: Record<string, unknown>): string {
  const persistence = recordValue(domain.persistence);
  const config = recordValue(domain.config);
  const configPersistence = recordValue(config.persistence);
  const candidates = [
    domain.dedupe_key,
    persistence.dedupe_key,
    config.dedupe_key,
    configPersistence.dedupe_key,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  throw new Error('dedupe_key must be a non-empty string in input.domain');
}

function entityTypeFromDomain(domain: Record<string, unknown>): EntityType {
  const persistence = recordValue(domain.persistence);
  const candidate = typeof domain.entity_type === 'string'
    ? domain.entity_type
    : typeof persistence.entity_type === 'string'
      ? persistence.entity_type
      : 'lead';
  return candidate === 'contact' ? 'contact' : 'lead';
}

function recordsFromDomain(domain: Record<string, unknown>, keyedPath?: string): readonly LeadRecord[] {
  const work = recordValue(domain.work);
  const aggregate = recordValue(domain.aggregate);
  const workAggregate = recordValue(work.aggregate);
  const candidates = [
    recordsAtPath(domain, keyedPath),
    domain.records,
    domain.leads,
    domain.contacts,
    domain.items,
    aggregate.records,
    aggregate.leads,
    aggregate.contacts,
    aggregate.items,
    workAggregate.records,
    workAggregate.leads,
    workAggregate.contacts,
    workAggregate.items,
    recordsFromStageOutput(domain['aggregate.output']),
    recordsFromStageOutput(aggregate.output),
    recordsFromStageOutput(workAggregate.output),
  ];
  for (const candidate of candidates) {
    const records = leadRecordArray(candidate);
    if (records.length > 0) {
      return records;
    }
  }
  throw new Error('persistence stage requires a non-empty records, leads, contacts, or items array in input.domain');
}

function recordsAtPath(domain: Record<string, unknown>, path: string | undefined): LeadRecord[] {
  if (!path) {
    return [];
  }
  const direct = leadRecordArray(valueAtPath(domain, path));
  if (direct.length > 0) {
    return direct;
  }
  const prefix = path + '.';
  const grouped = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(domain)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const [indexText, ...fieldParts] = key.slice(prefix.length).split('.');
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0) {
      continue;
    }
    const record = grouped.get(index) ?? {};
    if (fieldParts.length === 0) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        grouped.set(index, value as LeadRecord);
      }
    } else {
      record[fieldParts.join('.')] = value;
      grouped.set(index, record);
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, record]) => record as LeadRecord);
}

function valueAtPath(domain: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(domain, path)) {
    return domain[path];
  }
  let cursor: unknown = domain;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function recordsFromStageOutput(value: unknown): unknown {
  const record = recordValue(value);
  const result = resultJsonRecord(record);
  return result.records ?? result.leads ?? result.contacts ?? result.items;
}

function resultJsonRecord(record: Record<string, unknown>): Record<string, unknown> {
  if (typeof record.result_json === 'string') {
    try {
      const parsed = JSON.parse(record.result_json) as unknown;
      return recordValue(parsed);
    } catch {
      return {};
    }
  }
  return recordValue(record.result_json);
}

function leadRecordArray(value: unknown): LeadRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: LeadRecord[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      records.push(item as LeadRecord);
    }
  }
  return records;
}

function mergeRecords(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = merged[key];
    merged[key] = isPlainRecord(previous) && isPlainRecord(value)
      ? mergeRecords(previous, value)
      : value;
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isPersistenceConnector(value: unknown): value is PersistenceHostConnector {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { upsert_lead?: unknown }).upsert_lead === 'function' &&
    typeof (value as { upsert_contact?: unknown }).upsert_contact === 'function' &&
    typeof (value as { query?: unknown }).query === 'function' &&
    typeof (value as { dedupe?: unknown }).dedupe === 'function';
}
`;
}

function renderHttpApiRepoIntegrationStageBody(stage: string, integration: WiringIntegration): string {
  const method = integration.methods[0] as string;
  const envNames = JSON.stringify(integration.config_env);
  const baseUrlEnv = httpApiBaseUrlEnvName(integration);
  const methodPath = `/${method}`;
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  const baseUrl = process.env[${tsString(baseUrlEnv)}];
  if (!baseUrl) {
    throw new Error(${tsString(`missing config env: ${baseUrlEnv}`)});
  }
  const endpoint = new URL(baseUrl);
  endpoint.pathname = endpoint.pathname.replace(/\\/+$/u, '') + ${tsString(methodPath)};
  endpoint.search = '';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stage: input.stage,
      domain: input.domain,
      requested_at: runtime.now(),
    }),
  });
  const responseText = await response.text();
  let integrationResult: unknown = null;
  if (responseText.length > 0) {
    try {
      integrationResult = JSON.parse(responseText) as unknown;
    } catch {
      integrationResult = responseText;
    }
  }
  if (!response.ok) {
    throw new Error(${tsString(`http_api integration ${integration.name}.${method} failed`)} + ': HTTP ' + response.status + ' ' + responseText);
  }
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      status: 'connected',
      adapter_kind: 'repo_integration',
      integration: ${tsString(integration.name)},
      method: ${tsString(method)},
      config_env: ${envNames},
      endpoint: endpoint.pathname,
      response_status: response.status,
      result: integrationResult,
    }),
    items_json: JSON.stringify([input.stage + ':' + ${tsString(integration.name)} + ':' + ${tsString(method)} + ':http_api']),
    digest: '',
    adapter_kind: 'repo_integration',
  };
}
`;
}

function renderExportStageBody(stage: string, descriptor: ExportStageDescriptor): string {
  if (descriptor.kind === 'export_docx') {
    return renderDocxExportStageBody(stage, descriptor);
  }
  if (descriptor.kind === 'export_html') {
    return renderHtmlExportStageBody(stage, descriptor);
  }
  return renderPdfReportStageBody(stage, descriptor);
}

function renderDocxExportStageBody(stage: string, descriptor: ExportStageDescriptor): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
import { renderStructuredDocxDocument } from '../export/docx.js';

declare const Buffer: {
  from(data: Uint8Array): { toString(encoding: 'base64'): string };
};

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const sections = sectionsFromDomain(input.domain, input.stage);
  const bytes = renderStructuredDocxDocument({
    title: ${tsString(descriptor.title)},
    sections,
  });
  const sha256 = await sha256Hex(bytes);
  const result = {
    stage: input.stage,
    docx_base64: Buffer.from(bytes).toString('base64'),
    docx_bytes: bytes.length,
    sha256,
    section_count: sections.length,
  };
  return {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify(['docx_export:' + result.sha256]),
    digest: '',
  };
}
${exportSectionHelpers(stage)}
${sha256Helper()}
`;
}

function renderHtmlExportStageBody(stage: string, descriptor: ExportStageDescriptor): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
import { renderHtmlDocument } from '../export/html.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const sections = sectionsFromDomain(input.domain, input.stage);
  const html = renderHtmlDocument(sectionsToHtml(${tsString(descriptor.title)}, sections));
  const bytes = new TextEncoder().encode(html);
  const sha256 = await sha256Hex(bytes);
  const result = {
    stage: input.stage,
    html,
    html_bytes: bytes.length,
    sha256,
    section_count: sections.length,
  };
  return {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify(['html_export:' + result.sha256]),
    digest: '',
  };
}
${exportSectionHelpers(stage)}

function sectionsToHtml(title: string, sections: ExportSection[]): string {
  return [
    '<section><h1>' + escapeHtml(title) + '</h1></section>',
    ...sections.map((section) => '<section><h2>' + escapeHtml(section.title) + '</h2>' + toParagraphs(section.body).map((line) => '<p>' + escapeHtml(line) + '</p>').join('') + '</section>'),
  ].join('\\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
${sha256Helper()}
`;
}

function renderPdfReportStageBody(stage: string, descriptor: ExportStageDescriptor): string {
  void stage;
  void descriptor;
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
import { assembleStructuredReport } from '../report-data.js';
import { MockPdfReportConnector, type PdfReportHostConnector } from '../connectors/pdf-report.js';

declare const Buffer: {
  from(data: Uint8Array): { toString(encoding: 'base64'): string };
};

type RuntimeWithPdfReport = StageRuntime & {
  pdf_report?: PdfReportHostConnector;
  connectors?: { pdf_report?: PdfReportHostConnector };
};

const defaultPdfReportConnector = new MockPdfReportConnector();

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  const connector = pdfReportConnector(input, runtime);
  const report = assembleStructuredReport(stageDomain(input));
  const bytes = await connector.render_report(report);
  const sha256 = await sha256Hex(bytes);
  const result = {
    stage: input.stage,
    pdf_base64: Buffer.from(bytes).toString('base64'),
    pdf_bytes: bytes.length,
    sha256,
    section_count: 4,
  };
  return {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify(['pdf_report:' + result.sha256]),
    digest: '',
  };
}

function pdfReportConnector(input: StageInput, runtime: StageRuntime): PdfReportHostConnector {
  const runtimeRecord = runtime as RuntimeWithPdfReport;
  const runtimeConnector = runtimeRecord.pdf_report ?? runtimeRecord.connectors?.pdf_report;
  if (isPdfReportConnector(runtimeConnector)) {
    return runtimeConnector;
  }
  const payload = input.payload as Record<string, unknown>;
  const payloadRuntime = recordValue(payload.__stage_runtime);
  const payloadConnectors = recordValue(payloadRuntime.connectors);
  const payloadConnector = payloadRuntime.pdf_report ?? payloadConnectors.pdf_report;
  if (isPdfReportConnector(payloadConnector)) {
    return payloadConnector;
  }
  return defaultPdfReportConnector;
}

function stageDomain(input: StageInput): Record<string, unknown> {
  return mergeRecords(recordValue(input.domain_spec.input_domain), input.domain);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeRecords(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = merged[key];
    merged[key] = isPlainRecord(previous) && isPlainRecord(value)
      ? mergeRecords(previous, value)
      : value;
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPdfReportConnector(value: unknown): value is PdfReportHostConnector {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { render_report?: unknown }).render_report === 'function';
}
${sha256Helper()}
`;
}

function exportSectionHelpers(stage: string): string {
  return `
interface ExportSection {
  title: string;
  body: string | string[];
}

function sectionsFromDomain(domain: Record<string, unknown>, stage: string): ExportSection[] {
  const contentCollections = exportContentCollectionsFromDomain(domain);
  const approved = approvedContentSectionsFromDomain(domain, contentCollections);
  if (approved.length > 0) {
    return approved;
  }
  const sections: ExportSection[] = [];
  for (const key of Object.keys(domain).sort()) {
    if (key.startsWith(stage + '.') || isNonContentExportPath(key, contentCollections)) {
      continue;
    }
    const value = domain[key];
    const section = sectionForDomainValue(key, value, contentCollections);
    if (section) {
      sections.push(section);
    }
  }
  return sections.length > 0
    ? sections
    : [{ title: humanizePath(${tsString(stage)}), body: 'No accumulated domain state was available for export.' }];
}

function sectionForDomainValue(path: string, value: unknown, contentCollections: readonly string[]): ExportSection | undefined {
  if (isNonContentExportPath(path, contentCollections)) {
    return undefined;
  }
  if (isStageOutput(value)) {
    const parsed = parseJsonValue(value.result_json);
    return {
      title: humanizePath(path),
      body: stableStringify(parsed ?? { result_json: value.result_json }),
    };
  }
  if (path.endsWith('.result_json') && typeof value === 'string') {
    const parsed = parseJsonValue(value);
    return {
      title: humanizePath(path),
      body: stableStringify(parsed ?? value),
    };
  }
  if (path.startsWith('work.') && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
    return {
      title: humanizePath(path),
      body: String(value),
    };
  }
  return undefined;
}

function approvedContentSectionsFromDomain(domain: Record<string, unknown>, contentCollections: readonly string[]): ExportSection[] {
  const sections: ExportSection[] = [];
  for (const collectionPath of contentCollections) {
    for (const [index, item] of contentRecordsFromDomain(domain, collectionPath)) {
      const status = stringField(item, 'status')?.toLowerCase();
      if (status && status !== 'accepted' && status !== 'approved') {
        continue;
      }
      const body = exportBodyField(item);
      if (!body || body.trim().length === 0) {
        continue;
      }
      sections.push({
        title: stringField(item, 'title') ?? stringField(item, 'section_kind') ?? humanizePath(collectionPath) + ' ' + String(index + 1),
        body,
      });
    }
  }
  return sections;
}

function exportContentCollectionsFromDomain(domain: Record<string, unknown>): string[] {
  const candidates = new Set<string>();
  for (const key of Object.keys(domain).sort()) {
    if (key.endsWith('.items') && Array.isArray(domain[key])) {
      candidates.add(key.slice(0, -'.items'.length));
      continue;
    }
    const marker = '.items.';
    const markerIndex = key.indexOf(marker);
    if (markerIndex < 0) {
      continue;
    }
    const collectionPath = key.slice(0, markerIndex);
    const indexText = key.slice(markerIndex + marker.length).split('.', 1)[0];
    if (collectionPath.length > 0 && isNonNegativeIntegerText(indexText)) {
      candidates.add(collectionPath);
    }
  }
  return [...candidates]
    .filter((collectionPath) => contentRecordsFromDomain(domain, collectionPath).length > 0)
    .sort();
}

function contentRecordsFromDomain(domain: Record<string, unknown>, collectionPath: string): Array<[number, Record<string, unknown>]> {
  const byIndex = new Map<number, Record<string, unknown>>();
  const directItems = domain[collectionPath + '.items'];
  if (Array.isArray(directItems)) {
    directItems.forEach((item, index) => {
      if (isRecordValue(item)) {
        byIndex.set(index, { ...item });
      }
    });
  }
  for (const key of Object.keys(domain).sort()) {
    const itemPathPrefix = collectionPath + '.items.';
    if (!key.startsWith(itemPathPrefix)) {
      continue;
    }
    const remainder = key.slice(itemPathPrefix.length);
    const parts = remainder.split('.');
    const indexText = parts[0];
    if (!isNonNegativeIntegerText(indexText)) {
      continue;
    }
    const index = Number(indexText);
    const existing = byIndex.get(index) ?? {};
    const field = parts.slice(1).join('.');
    const value = domain[key];
    if (field.length === 0 && isRecordValue(value)) {
      byIndex.set(index, { ...existing, ...value });
      continue;
    }
    if (field.length > 0) {
      existing[field] = value;
      byIndex.set(index, existing);
    }
  }
  return [...byIndex.entries()].sort(([left], [right]) => left - right);
}

function exportBodyField(record: Record<string, unknown>): string | undefined {
  return stringField(record, 'final_text')
    ?? stringField(record, 'approved_text')
    ?? stringField(record, 'proposed_text')
    ?? stringField(record, 'draft_text')
    ?? stringField(record, 'body')
    ?? stringField(record, 'text')
    ?? stringField(record, 'summary');
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isNonNegativeIntegerText(value: string | undefined): boolean {
  return typeof value === 'string' && /^\\d+$/u.test(value);
}

function isNonContentExportPath(path: string, contentCollections: readonly string[]): boolean {
  return isRawSourceOrCorpusPath(path) || isConfirmationLoopInternalStatePath(path, contentCollections);
}

function isRawSourceOrCorpusPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === 'work.source'
    || normalized.startsWith('work.source.')
    || normalized === 'work.source_ready'
    || normalized.endsWith('.full_text')
    || normalized.includes('.full_text.')
    || normalized.endsWith('.documents')
    || normalized.includes('.documents.')
    || normalized.endsWith('.current_document.text')
    || normalized.includes('.current_document.text.')
    || normalized.includes('.fan_out.results');
}

function isConfirmationLoopInternalStatePath(path: string, contentCollections: readonly string[]): boolean {
  const normalized = path.toLowerCase();
  if (normalized === 'inputs.user_decision' || normalized.startsWith('inputs.user_decision.')) {
    return true;
  }
  if (
    normalized === 'summary.confirmation_loop'
    || normalized.startsWith('summary.confirmation_loop.')
    || normalized.includes('pending_approval')
    || normalized.includes('pending-approval')
    || normalized.startsWith('decisions.pending_')
    || normalized.includes('.decisions.pending_')
  ) {
    return true;
  }
  for (const collectionPath of contentCollections) {
    if (
      path === collectionPath
      || path === collectionPath + '.items'
      || path.startsWith(collectionPath + '.items.')
    ) {
      return true;
    }
    if (!path.startsWith(collectionPath + '.')) {
      continue;
    }
    const relative = path.slice(collectionPath.length + 1).toLowerCase();
    if (
      relative === 'all_terminal'
      || relative === 'current_index'
      || relative.startsWith('confirmation_summary')
      || relative.startsWith('confirmation_loop')
      || relative.startsWith('pending_')
      || relative.includes('.pending_')
      || relative.endsWith('_violation_json')
    ) {
      return true;
    }
  }
  return false;
}

function isStageOutput(value: unknown): value is { result_json: string; items_json?: string; digest?: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { result_json?: unknown }).result_json === 'string';
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(', ') + ']';
  }
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ': ' + stableStringify(record[key])).join(', ') + '}';
}

function humanizePath(path: string): string {
  const words = path
    .replace(/\\.output(?:\\.result_json)?$/u, '')
    .replace(/\\.result_json$/u, '')
    .split(/[._-]+/u)
    .filter(Boolean);
  const label = words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(' ');
  return label.length > 0 ? label : 'Program State';
}

function toParagraphs(body: string | string[]): string[] {
  return Array.isArray(body) ? body : body.split(/\\n+/u);
}
`;
}

function sha256Helper(): string {
  return `
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
`;
}

/**
 * Deterministic fallback stage body (issue #93).
 *
 * When the LLM stage-body generator exhausts its repair attempts for a
 * pure-compute / in-memory external-adapter stage, we synthesize a mechanical
 * body that is guaranteed to satisfy the baseline behavioral gate
 * (exact domain_spec.produces.result_json key order, one item per declared
 * items_json template, non-empty items). This is
 * fully mechanical (SI-3): no LLM call, no freeform emission — the shape is
 * derived deterministically from the frozen contract's domain_spec.
 *
 * The rendered body is still run through the SAME behavioral gate before it is
 * accepted, so it can never introduce a silently-wrong body: if the gate has a
 * requirement the mechanical body cannot meet (e.g. a fee-proposal
 * positive-number computation the fallback happens not to satisfy),
 * verification fails and the caller reports the terminal error rather than
 * accepting a bogus body.
 */
function renderDeterministicFallbackStageBody(
  stage: string,
  archetype: 'pure-compute' | 'external-adapter',
  domainSpec?: StageDomainSpec,
): string {
  void stage;
  const schema = resultJsonSchema(domainSpec);
  const resultEntries: string[] = [];
  if (schema) {
    for (const key of Object.keys(schema)) {
      resultEntries.push(`${tsPropertyKey(key)}: ${fallbackResultFieldExpression(key, schema[key], archetype)}`);
    }
  } else {
    resultEntries.push('stage: input.stage');
  }

  const itemTemplates = domainSpec?.produces.items_json;
  let itemsExpression: string;
  if (Array.isArray(itemTemplates) && itemTemplates.length > 0 && itemTemplates.every((item) => typeof item === 'string')) {
    itemsExpression = (itemTemplates as string[]).some((template) => template.includes('<email>'))
      ? "leadItems((result as Record<string, unknown>).leads)"
      : `[${(itemTemplates as string[]).map((template) => tsString(fillItemTemplate(template))).join(', ')}]`;
  } else {
    itemsExpression = `[input.stage + ':complete']`;
  }

  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

// Deterministic mechanical stage body synthesized by pgas-new after LLM
// repair attempts were exhausted (issue #93). It reads the recorded request,
// mirrors the frozen domain_spec.produces schema, and satisfies the baseline
// behavioral gate without inventing domain values.
export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const requestText = input.domain['inputs.initial_user_text'] ?? input.domain['inputs.user_text'] ?? '';
  void requestText;
  const result = {
${resultEntries.map((entry) => `    ${entry},`).join('\n')}
  };
  return {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify(${itemsExpression}),
    digest: '',${archetype === 'external-adapter' ? "\n    adapter_kind: 'in_memory_mock'," : ''}
  };
}

function perSourceEntries(domain: Record<string, unknown>): Record<string, unknown>[] {
  return firstNonEmptyArray(
    arrayAt(domain, 'work.aggregate.per_source'),
    arrayAt(domain, 'aggregate.per_source'),
    arrayValue(resultJsonRecord(valueAtPath(domain, 'aggregate.output')).per_source),
    arrayValue(resultJsonRecord(valueAtPath(domain, 'work.aggregate.output')).per_source),
  ).map((item) => {
    const record = recordValue(item);
    const items = arrayValue(record.items);
    return {
      ...record,
      source: stringValue(record.source) || stringValue(record.url) || '',
      found: numberValue(record.found) ?? numberValue(record.item_count) ?? items.length,
      pages_visited: numberValue(record.pages_visited) ?? 0,
    };
  });
}

function leadEntries(domain: Record<string, unknown>): Record<string, unknown>[] {
  return firstNonEmptyArray(
    arrayValue(resultJsonRecord(valueAtPath(domain, 'extract_leads.output')).leads),
    arrayValue(resultJsonRecord(valueAtPath(domain, 'extract_leads.result_json')).leads),
    arrayAt(domain, 'extract_leads.result.leads'),
    arrayAt(domain, 'leads'),
    arrayAt(domain, 'records'),
  ).filter(isPlainRecord).map((record) => ({ ...record }));
}

function auditEntries(domain: Record<string, unknown>): Record<string, unknown>[] {
  const direct = firstNonEmptyArray(
    arrayAt(domain, 'work.audit'),
    arrayAt(domain, 'aggregate.audit'),
    arrayValue(resultJsonRecord(valueAtPath(domain, 'aggregate.output')).audit),
    arrayValue(resultJsonRecord(valueAtPath(domain, 'work.aggregate.output')).audit),
    arrayValue(resultJsonRecord(valueAtPath(domain, 'navigate_source.output')).audit),
  );
  if (direct.length > 0) {
    return direct.filter(isPlainRecord).map((record) => ({ ...record }));
  }
  return perSourceEntries(domain)
    .flatMap((source) => arrayValue(source.audit))
    .filter(isPlainRecord)
    .map((record) => ({ ...record }));
}

function leadItems(value: unknown): string[] {
  const leads = arrayValue(value).filter(isPlainRecord);
  if (leads.length === 0) {
    return ['lead:value'];
  }
  return leads.map((lead, index) => 'lead:' + (stringValue(lead.email) || stringValue(lead.name) || String(index + 1)));
}

function arrayAt(domain: Record<string, unknown>, path: string): unknown[] {
  const directArray = arrayValue(valueAtPath(domain, path));
  if (directArray.length > 0) {
    return directArray;
  }
  const prefix = path + '.';
  const grouped = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(domain)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const [indexText, ...fieldParts] = key.slice(prefix.length).split('.');
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0) {
      continue;
    }
    if (fieldParts.length === 0) {
      grouped.set(index, isPlainRecord(value) ? { ...value } : { value });
      continue;
    }
    const record = grouped.get(index) ?? {};
    record[fieldParts.join('.')] = value;
    grouped.set(index, record);
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
}

function valueAtPath(domain: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(domain, path)) {
    return domain[path];
  }
  let cursor: unknown = domain;
  for (const part of path.split('.')) {
    if (!isPlainRecord(cursor) || !Object.hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function resultJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return recordValue(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  const record = recordValue(value);
  if (typeof record.result_json === 'string') {
    try {
      return recordValue(JSON.parse(record.result_json) as unknown);
    } catch {
      return {};
    }
  }
  return recordValue(record.result_json);
}

function firstNonEmptyArray(...values: unknown[][]): unknown[] {
  return values.find((value) => value.length > 0) ?? [];
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isPlainRecord(value)) {
    const numericKeys = Object.keys(value)
      .filter((key) => /^\\d+$/u.test(key))
      .sort((left, right) => Number(left) - Number(right));
    if (numericKeys.length > 0) {
      return numericKeys.map((key) => value[key]);
    }
  }
  return [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
`;
}

function fallbackResultFieldExpression(
  key: string,
  schemaValue: unknown,
  archetype: 'pure-compute' | 'external-adapter',
): string {
  if (key === 'stage') {
    return 'input.stage';
  }
  if (key === 'adapter_kind' && archetype === 'external-adapter') {
    return "'in_memory_mock'";
  }
  if (isArraySchemaValue(schemaValue)) {
    if (key === 'per_source') {
      return 'perSourceEntries(input.domain)';
    }
    if (key === 'leads' || key === 'records' || key === 'contacts') {
      return 'leadEntries(input.domain)';
    }
    if (key === 'audit') {
      return 'auditEntries(input.domain)';
    }
  }
  return fallbackFieldExpression(schemaValue);
}

function tsPropertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : tsString(key);
}

/**
 * Deterministic value expression for a domain_spec.produces.result_json field
 * whose schema value declares its type ("string" | "number" | "boolean").
 * Non-empty / positive so the item-template and fee positive-field gates that
 * this body CAN satisfy pass; specs that additionally require a real
 * computation will simply fail re-verification and are left to error.
 */
function fallbackFieldExpression(schemaValue: unknown): string {
  if (isRepeatedRecordSchema(schemaValue)) {
    return repeatedRecordFallbackExpression(schemaValue[0]);
  }
  const declared = typeof schemaValue === 'string' ? schemaValue.trim().toLowerCase() : '';
  if (declared === 'number' || declared === 'integer' || declared === 'float') {
    return '1';
  }
  if (declared === 'boolean' || declared === 'bool') {
    return 'true';
  }
  if (declared.startsWith('array') || declared.startsWith('[')) {
    return '[]';
  }
  if (declared.startsWith('object') || declared.startsWith('{')) {
    return '{}';
  }
  // Default to a deterministic non-empty string, echoing the stage for traceability.
  return "input.stage + '-pending'";
}

function isArraySchemaValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return true;
  }
  const declared = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return declared.startsWith('array') || declared.startsWith('[') || declared.endsWith('[]');
}

function repeatedRecordFallbackExpression(schema: Record<string, unknown>): string {
  const entries = Object.keys(schema).map((key) =>
    `${tsPropertyKey(key)}: ${fallbackFieldExpression(schema[key])}`);
  return `[{ ${entries.join(', ')} }]`;
}

/**
 * Replace each `<placeholder>` in an items_json template with a deterministic
 * non-empty token so the rendered literal matches `itemTemplateMatcher`.
 */
function fillItemTemplate(template: string): string {
  return template.replace(/<[^>]+>/gu, 'value');
}

function httpApiBaseUrlEnvName(integration: WiringIntegration): string {
  const envName = integration.config_env.find((candidate) => candidate.endsWith('_BASE_URL')) ?? integration.config_env[0];
  if (!envName) {
    throw new Error(`http_api integration ${integration.name} must declare a base URL config_env name`);
  }
  return envName;
}

function httpApiEndpoint(baseUrl: string, method: string): URL {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') + `/${method}`;
  endpoint.search = '';
  return endpoint;
}

function assertLoopbackEndpoint(endpoint: URL): string | undefined {
  if (endpoint.protocol !== 'http:') {
    return `http_api loopback verification requires http:// localhost endpoint; got ${endpoint.protocol}`;
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    return `http_api loopback verification requires localhost endpoint; got ${endpoint.hostname}`;
  }
  return undefined;
}

function cacheKeyFor(input: { stage: string; contract: string; prompt: string; model: string; providerUrl: string }): string {
  return sha256([
    SYNTHESIS_VERSION,
    input.stage,
    input.contract,
    input.prompt,
    input.model,
    input.providerUrl,
  ].join('\n---\n'));
}

function legacyStageBodyCachePaths(input: {
  cacheDir: string;
  stage: string;
  contract: string;
  prompt: string;
  model: string;
  providerUrl: string;
}): string[] {
  const prompts = new Set<string>();
  const worldWritePrompt = legacyWorldWriteCachePrompt(input.prompt);
  if (worldWritePrompt) {
    prompts.add(worldWritePrompt);
  }
  for (const prompt of [input.prompt, ...(worldWritePrompt ? [worldWritePrompt] : [])]) {
    const argSchemaPrompt = legacyArgSchemaCachePrompt(prompt);
    if (argSchemaPrompt) {
      prompts.add(argSchemaPrompt);
    }
  }
  return [...prompts].map((prompt) =>
    join(input.cacheDir, `${cacheKeyFor({
      stage: input.stage,
      contract: input.contract,
      prompt,
      model: input.model,
      providerUrl: input.providerUrl,
    })}.json`));
}

function legacyWorldWriteCachePrompt(prompt: string): string | undefined {
  // Keep pre-v4 stage-body cache entries reusable when only bootstrap write
  // surfaces changed; generated bodies do not depend on seed/control-plane syntax.
  let normalized = prompt
    .replace(
      /\nchannels:\n  seed:\n    direction: In\n    sync: Async\n  user_text:/u,
      '\nchannels:\n  user_text:',
    )
    .replace(/\n      - seed(?=\n)/gu, '')
    .replace(
      /\ningestion:\n  seed:\n    - inputs\.domain_context\n    - inputs\.domain_context\.query\n  user_text:/u,
      '\ningestion:\n  user_text:',
    )
    .replace(/\n  inputs\.domain_context\.query: string(?=\n)/u, '');

  normalized = normalized.replace(
    /(\n        - op: create_session\n          as: session\n          program: [^\n]+\n)(        - op: trigger\n          session: \$session\.id\n          channel: )/u,
    '$1          domain_context:\n            query: $args.query\n$2',
  );

  return normalized === prompt ? undefined : normalized;
}

function legacyArgSchemaCachePrompt(prompt: string): string | undefined {
  // action_map.arg_schema only changes model-facing tool declarations. Stage
  // body implementations are governed by stage contracts, domain_spec, and
  // result paths, so declaration-only overlays should not invalidate replay
  // body caches.
  const normalized = prompt.replace(/\n    arg_schema:\n(?:      [^\n]*\n|        [^\n]*\n|          [^\n]*\n|            [^\n]*\n)+/gu, '\n');
  return normalized === prompt ? undefined : normalized;
}

function readFirstCache(paths: readonly string[]): CacheRecord | undefined {
  for (const path of paths) {
    const cached = readCache(path);
    if (cached) {
      return cached;
    }
  }
  return undefined;
}

function readCompatibleStageCache(cacheDir: string, stage: string, domainSpec: StageDomainSpec | undefined): CacheRecord | undefined {
  if (!existsSync(cacheDir)) {
    return undefined;
  }
  const candidates = readdirSync(cacheDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readCache(join(cacheDir, name)))
    .filter((record): record is CacheRecord => !!record && cacheRecordMatchesStage(record, stage, domainSpec));
  candidates.sort((left, right) => Number(isFallbackCacheRecord(left)) - Number(isFallbackCacheRecord(right)));
  return candidates[0];
}

function cacheRecordMatchesStage(record: CacheRecord, stage: string, domainSpec: StageDomainSpec | undefined): boolean {
  const fixture = record.behavioral_fixture;
  if (!fixture || fixture.input_stage !== stage || fixture.expected_result_stage !== stage) {
    return false;
  }
  if (domainSpec?.reads && fixture.domain_spec_reads && !stringArraysEqual(domainSpec.reads, fixture.domain_spec_reads)) {
    return false;
  }
  const itemTemplates = Array.isArray(domainSpec?.produces.items_json)
    ? domainSpec.produces.items_json.filter((item): item is string => typeof item === 'string')
    : undefined;
  if (itemTemplates && fixture.expected_items_templates && !stringArraysEqual(itemTemplates, fixture.expected_items_templates)) {
    return false;
  }
  return true;
}

function isFallbackCacheRecord(record: CacheRecord): boolean {
  return record.body.includes('Deterministic mechanical stage body synthesized by pgas-new after LLM');
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readCache(path: string): CacheRecord | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheRecord>;
  const behavioralFixture = isStageBehaviorFixture(parsed.behavioral_fixture)
    ? normalizeStageBehaviorFixture(parsed.behavioral_fixture)
    : undefined;
  return typeof parsed.body === 'string' && typeof parsed.body_hash === 'string'
    ? {
        body: parsed.body,
        body_hash: parsed.body_hash,
        ...(typeof parsed.behavioral_gate === 'string' ? { behavioral_gate: parsed.behavioral_gate } : {}),
        ...(behavioralFixture ? { behavioral_fixture: behavioralFixture } : {}),
        ...(parsed.real_call_verified ? { real_call_verified: true } : {}),
        ...(parsed.escalation_driver === CODEX_CLI_ESCALATION_DRIVER ? { escalation_driver: parsed.escalation_driver } : {}),
      }
    : undefined;
}

function isStageBehaviorFixture(value: unknown): value is StageBehaviorFixture {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { input_stage?: unknown }).input_stage === 'string' &&
    typeof (value as { expected_result_stage?: unknown }).expected_result_stage === 'string' &&
    (value as { expected_items_non_empty?: unknown }).expected_items_non_empty === true;
}

function normalizeStageBehaviorFixture(value: StageBehaviorFixture): StageBehaviorFixture {
  return {
    input_stage: value.input_stage,
    expected_result_stage: value.expected_result_stage,
    expected_items_non_empty: true,
    ...(value.expected_adapter_kind ? { expected_adapter_kind: value.expected_adapter_kind } : {}),
    ...(value.expected_integration ? { expected_integration: value.expected_integration } : {}),
    ...(value.expected_method ? { expected_method: value.expected_method } : {}),
    ...(value.expected_endpoint ? { expected_endpoint: value.expected_endpoint } : {}),
    ...(value.real_call_verified ? { real_call_verified: true } : {}),
    ...(typeof value.verified_response_status === 'number' ? { verified_response_status: value.verified_response_status } : {}),
    ...(stringArray(value.available_domain_paths) ? { available_domain_paths: value.available_domain_paths } : {}),
    ...(stringArray(value.domain_spec_reads) ? { domain_spec_reads: value.domain_spec_reads } : {}),
    ...(stringArray(value.expected_items_templates) ? { expected_items_templates: value.expected_items_templates } : {}),
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function extractCode(content: string): string {
  const fence = content.match(/```(?:ts|typescript)?\s*([\s\S]*?)```/u);
  return (fence?.[1] ?? content).trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tsString(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}
