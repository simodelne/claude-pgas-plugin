import type { WiringAvailableProgram, WiringIntegration } from '../../pgas-new/wiring-manifest.js';
import type {
  CapabilityGap,
  DocumentExtractionSurfaces,
  DocumentsDescriptor,
  ExportStageDescriptor,
  ExportSurfaces,
  SynthesisContext,
} from '../synthesizer-store.js';
import type { ClassifiedStage, StageArchetype } from '../stage-classifier.js';
import type { ReasoningStageContract } from '../reasoning-contract.js';

export type CollectionStorageRepresentation = 'json_string' | 'indexed_array';

export interface Stage {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
  archetype?: string;
  kind?: string;
  export_kind?: string;
  domain_spec?: StageDomainSpec;
  emit_artifact?: StageArtifactDescriptorInput | StageArtifactDescriptorInput[];
  tools?: unknown;
  engine_tools?: unknown;
}

export type StageInput = Stage | string;

export interface StageDomainSpec {
  reads: string[];
  produces: Record<string, unknown>;
  rules: string[];
  invariants: string[];
}

export interface StageArtifactDescriptorInput {
  type?: unknown;
  title?: unknown;
  summary?: unknown;
  payload_ref?: unknown;
}

export interface StageArtifactDescriptor {
  stage: string;
  artifactType: string;
  title: string;
  summary: string;
  payloadRef: string;
}

export interface IntakeTransition {
  from: string;
  to: string;
  trigger?: string;
  guard?: Record<string, unknown>;
  guard_field?: string;
}

export interface Completion {
  final_stage: string;
  guard_field: string;
  collection_lifecycle?: CollectionLifecycleDescriptor;
}

export interface Interaction {
  confirmation_loops: ConfirmationLoopDescriptor[];
}

export interface DelegationChildrenValidationContext {
  programSlug: string;
  programName: string;
  stages: Array<{
    slug: string;
    is_bootstrap?: boolean;
    is_terminal?: boolean;
    domain_spec?: StageDomainSpec;
  }>;
  actionNames: Iterable<string>;
  channelNames: Iterable<string>;
  schemaPaths: Iterable<string>;
  documents?: DocumentsDescriptor;
}

export interface DocumentsValidationContext {
  stages: Array<{
    slug: string;
    is_bootstrap?: boolean;
    is_terminal?: boolean;
  }>;
  delegation?: Record<string, unknown>;
}

export interface CollectionLifecycleDescriptor {
  version: number;
  name: string;
  item_label: string;
  storage: {
    items_path: string;
    event_path: string;
    violation_path: string;
    representation: CollectionStorageRepresentation;
  };
  item: {
    id_field: string;
    status_field: string;
    schema: Record<string, unknown>;
  };
  statuses: Array<{
    name: string;
    initial?: boolean;
    terminal?: boolean;
  }>;
  transitions: Array<{
    from: string;
    to: string;
    stage: string;
    action: string;
    managed_by: 'llm' | 'reaction';
    trigger?: string;
    guard_field?: string;
  }>;
  aggregate: {
    guard_field: string;
    terminal_statuses: string[];
    require_non_empty: boolean;
  };
}

export interface ConfirmationLoopDecisionDescriptor {
  to: string;
  requires_instruction?: boolean;
  instruction_path?: string;
  re_propose?: boolean;
}

export interface ConfirmationLoopSeedDescriptor {
  source_stage: string;
  id_prefix?: string;
}

export interface ConfirmationLoopDescriptor {
  collection: string;
  proposed_status: string;
  seed: ConfirmationLoopSeedDescriptor;
  item_id_field?: string;
  item_title_field?: string;
  decisions: Record<string, ConfirmationLoopDecisionDescriptor>;
  one_proposed_at_a_time: true;
  aggregate: {
    guard_field: string;
    terminal_statuses: string[];
  };
  stage: string;
  summary_path?: string;
  violation_path?: string;
  pending_action_path?: string;
}

export interface SynthesizedSpec {
  spec_yaml: string;
  mode_names: string[];
  sha256: string;
  registration_ts?: string;
  contracts_ts: string;
  handlers_ts: string;
  handlers_index_ts: string;
  tools_ts: string;
  smoke_test_ts: string;
  stage_sources?: Record<string, string>;
  capability_gaps?: CapabilityGap[];
  export_surfaces?: ExportSurfaces;
  document_extraction_surfaces?: DocumentExtractionSurfaces;
  export_descriptors?: ExportStageDescriptor[];
  child_artifacts?: SynthesizedChildArtifact[];
  stage_classification: ClassifiedStage[];
  body_stage_slugs: string[];
  synthesis_context: SynthesisContext;
}

export interface SynthesizedChildArtifact extends Omit<SynthesizedSpec, 'child_artifacts' | 'synthesis_context'> {
  slug: string;
  name: string;
  synthesis_context: SynthesisContext;
}

export interface SynthesizeProgramSpecOptions {
  targetKind?: 'standalone_repo' | 'existing_repo';
  integrations?: WiringIntegration[];
  availablePrograms?: WiringAvailableProgram[];
  reasoningContracts?: Record<string, ReasoningStageContract>;
}

export type MutableRecord = Record<string, unknown>;

export interface TransitionAction {
  name: string;
  source: string;
  target: string;
  guardField?: string;
  archetype: StageArchetype;
  adapter_kind?: 'in_memory_mock' | 'repo_integration';
  export_kind?: 'export_docx' | 'export_html';
  integration_name?: string;
  integration_import?: string;
  integration_method?: string;
  integration_gap?: boolean;
  audit_note?: string;
}

export interface TerminalActionDescriptor {
  name: string;
  channel: string;
  payloadExample?: Record<string, string>;
}

export interface PlannedTransitionAction {
  name: string;
  source: string;
  target: string;
  guardField?: string;
}
