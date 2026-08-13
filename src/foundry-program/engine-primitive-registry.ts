import type { GovernedConstructKind } from './governance-gate.js';

export type PrimitiveIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export type PrimitiveStatus = 'landed' | 'shipped' | 'building' | 'asked';
export type FoundryEnforcement = 'active' | 'pending';
export type EngineDeclarationAwarenessStatus = 'emitted' | 'available_unused' | 'held' | 'adopt_backlog';
export type EnginePrimitiveConstructKind = GovernedConstructKind | 'arg_schema' | 'no_action_escape';

export interface EnginePrimitiveEntry {
  readonly computation_class: EnginePrimitiveConstructKind;
  readonly primitive_index: PrimitiveIndex;
  readonly primitive_name: string;
  readonly primitive_status: PrimitiveStatus;
  readonly pgas_ref: string;
  readonly request_ref: string;
  readonly foundry_enforcement: FoundryEnforcement;
  readonly since_engine_version?: string;
  readonly build_order_note?: string;
}

export interface EngineDeclarationAwarenessEntry {
  readonly construct: string;
  readonly status: EngineDeclarationAwarenessStatus;
  readonly note: string;
}

const CONVERGENCE_ALIGNMENT_REQUEST =
  'docs/curator-requests/2026-08-07-declarative-consumer-convergence-alignment.md';

export const ENGINE_DECLARATION_AWARENESS: readonly EngineDeclarationAwarenessEntry[] = [
  { construct: 'Specification.name', status: 'emitted', note: 'Generated specs set the program slug as the spec name.' },
  { construct: 'Specification.termination', status: 'emitted', note: 'The skeleton declares BoundedSession.' },
  { construct: 'Specification.topology', status: 'emitted', note: 'The skeleton declares CyclicTopology.' },
  { construct: 'Specification.preamble', status: 'emitted', note: 'The synthesizer writes a program-specific invariant preamble.' },
  { construct: 'Specification.modes', status: 'emitted', note: 'Synthesized mode records are emitted from the intake stage graph.' },
  { construct: 'Specification.initial', status: 'emitted', note: 'The first synthesized mode is assigned as initial.' },
  { construct: 'Specification.terminal', status: 'emitted', note: 'Terminal modes are derived from the synthesized topology.' },
  { construct: 'Specification.status_on_terminal', status: 'available_unused', note: 'No generator input selects terminal Failed/Completed overrides yet.' },
  { construct: 'Specification.channels', status: 'emitted', note: 'Generated specs declare input, output, document, delegation, and tool channels as needed.' },
  { construct: 'Specification.schema', status: 'emitted', note: 'The synthesizer declares durable schema paths for inputs, outputs, notebook state, delegation, documents, and verification.' },
  { construct: 'Specification.ingestion', status: 'emitted', note: 'Generated specs map trigger channels to declared input paths.' },
  { construct: 'Specification.ingestion_guidance', status: 'available_unused', note: 'Current generated programs use mode guidance, prompts, and recovery_steers instead.' },
  { construct: 'Specification.ingestion_root_passthrough', status: 'available_unused', note: 'No generated channel currently needs root passthrough wildcard ingestion.' },
  { construct: 'Specification.action_map', status: 'emitted', note: 'Every generated mode vocabulary action is backed by an action_map entry.' },
  { construct: 'Specification.repair_bound', status: 'emitted', note: 'The skeleton declares the global repair bound.' },
  { construct: 'Specification.fallback', status: 'emitted', note: 'The skeleton declares the fallback output channel and payload.' },
  { construct: 'Specification.guidance', status: 'emitted', note: 'The synthesizer emits mode guidance and toolkit guidance.' },
  { construct: 'Specification.prompts', status: 'emitted', note: 'The synthesizer emits per-mode prompt text.' },
  { construct: 'Specification.projection', status: 'emitted', note: 'The synthesizer emits mode-specific include/exclude projection profiles.' },
  { construct: 'Specification.view', status: 'adopt_backlog', note: 'Phase B backlog: v4.4 view: / ViewProfile replaces projection.ts-style builders; public anchors are node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:5235-5270 and node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:5691-5710.' },
  { construct: 'Specification.render', status: 'adopt_backlog', note: 'Phase C backlog: v4.5 render: / RenderProfile replaces report-data.ts-style renderer declarations; public anchors are node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:5310-5508 and node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:5743-5755.' },
  { construct: 'Specification.integrations', status: 'emitted', note: 'Export decision-only stages emit integration hooks when needed.' },
  { construct: 'Specification.reactions', status: 'emitted', note: 'Generated specs emit declarative reactions with write scopes.' },
  { construct: 'Specification.features', status: 'emitted', note: 'The synthesizer emits required feature flags from generated capabilities.' },
  { construct: 'Specification.policies', status: 'adopt_backlog', note: 'Phase E backlog (blueprint block 11): declarative policies are acknowledged from v4.5 public policy interfaces RetryBudget/RoundBudget/Query/DenialTracking/ContentScan/Risk/ProgramQuery in node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:3212-3366, node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:4768-4801, and node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:5520-5523; Phase A emits no policies block.' },
  { construct: 'Specification.finalization_requires', status: 'available_unused', note: 'Completion is currently expressed through transition guards and schema facts, not finalization_requires.' },
  { construct: 'Specification.finalization_gated_actions', status: 'available_unused', note: 'No generated action opts into finalization_requires as implicit preconditions yet.' },
  { construct: 'Specification.artifact_bundle', status: 'available_unused', note: 'The generator currently emits ProgramEntry artifactPolicy for exports instead of spec artifact_bundle.' },
  { construct: 'Specification.schema_invariants', status: 'emitted', note: 'Document fidelity emits record-level content invariants.' },
  { construct: 'Specification.bounded_rework', status: 'available_unused', note: 'Available in v4.2.0; no generated per-loop regress action/counter contract uses it yet.' },
  { construct: 'Specification.keyed_collections', status: 'emitted', note: 'Persistence-oriented generated programs emit keyed_collections for engine-owned upsert dedupe.' },
  { construct: 'Specification.recovery_steers', status: 'emitted', note: 'Confirmation loops emit recovery steers, including set/template_paths variants.' },
  { construct: 'Specification.merge_collections', status: 'available_unused', note: 'Registered as primitive index 10, but no content-key reducer emitter exists yet.' },
  { construct: 'Specification.no_action_escapes', status: 'emitted', note: 'Confirmation-loop synthesis emits no_action_escapes at src/foundry-program/synthesizer.ts with engine-owned counter/arm paths, no_action_escape feature flag, and blocked-route guards/preconditions.' },
  { construct: 'Specification.mandatory_delegations', status: 'adopt_backlog', note: 'Phase D backlog: v4.4 compiled mandatory_delegations is derived from mode requires_delegations and gated by mandatory_delegation; public type anchor node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:1838-1846.' },
  { construct: 'Specification.confirmation_pairing', status: 'emitted', note: 'Confirmation loops emit pairing prefixes, policy, and terminal actions.' },
  { construct: 'Specification.proceed_to', status: 'emitted', note: 'Generated transition actions emit proceed_to targets.' },
  { construct: 'Specification.notice_terminal_exemptions', status: 'available_unused', note: 'No generated action currently needs notice-terminal rewrite exemption.' },
  { construct: 'Specification.derived_paths', status: 'emitted', note: 'Collection lifecycles and confirmation loops emit derived path rules.' },
  { construct: 'Specification.derived_state_machines', status: 'available_unused', note: 'No generated stage currently uses engine-owned state-machine derivation.' },
  { construct: 'Specification.collection_finalizers', status: 'available_unused', note: 'No generator surface maps collection cleanup pipelines to finalizers yet.' },
  { construct: 'Specification.collections', status: 'available_unused', note: 'The foundry emits scattered primitives directly rather than the aggregate collections sugar.' },
  { construct: 'Specification.collection', status: 'available_unused', note: 'The foundry emits scattered primitives directly rather than PGAS-L collection blocks.' },
  { construct: 'Specification.tools', status: 'emitted', note: 'Registered web_search tool declarations are emitted from stage tool descriptors.' },
  { construct: 'EngineCapability.web_search', status: 'adopt_backlog', note: 'Phase D/E backlog: v4.5 WebSearchProvider is exported from plugin.js for engine-capability search; foundry still emits per-program registered web_search tool adapters and does not wire the engine capability in Phase A (anchors _shared-types.d.ts:8212-8231 and plugin.d.ts:114).' },
  { construct: 'Specification.pure', status: 'emitted', note: 'Generated specs start from the pure skeleton and can set pure=false for decision-only export stages.' },
  { construct: 'Specification.pure:strict', status: 'adopt_backlog', note: 'Phase F backlog: strict pure contract requires the pure_strict feature and forbids handler-style reactions per node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:1906-1920; adoption is per-program-gated, with fan-out programs blocked on the per-item delegation-fan-out engine ask.' },
  { construct: 'Feature.pure_strict', status: 'adopt_backlog', note: 'Phase F backlog: v4.5 Feature includes pure_strict at node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:141; per-program gating is required and fan-out programs wait for the per-item delegation-fan-out engine ask.' },
  { construct: 'Feature.merge_collection', status: 'available_unused', note: 'v4.5 Feature includes merge_collection at node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:141, but foundry uses keyed_collections and has no content-key merge emitter.' },
  { construct: 'Specification.disallow_raw_mutation_authoring', status: 'available_unused', note: 'No generated program opts into the stricter raw mutation authoring policy yet.' },
  { construct: 'Specification.command_grammar', status: 'available_unused', note: 'Generated programs use control_plane vocabulary rather than command_grammar.' },
  { construct: 'Specification.control_plane', status: 'emitted', note: 'The skeleton declares the control plane and the synthesizer rewrites the entry trigger channel.' },
  { construct: 'Specification.ephemeral', status: 'available_unused', note: 'Generated specs use durable schema/projection rather than ephemeral state cells.' },
  { construct: 'Specification.advisory_schema', status: 'emitted', note: 'Skill catalog synthesis emits advisory paths for activation bodies.' },
  { construct: 'Specification.activation_providers', status: 'emitted', note: 'Skill catalog synthesis emits activation provider targets.' },
  { construct: 'Specification.decision_schema', status: 'emitted', note: 'Skill triage emits a decision-zone schema path.' },
  { construct: 'Specification.agent_nodes', status: 'available_unused', note: 'No generated program declares agent-network nodes yet.' },
  { construct: 'Specification.schedule', status: 'available_unused', note: 'No generated program declares scheduled background ticks yet.' },
  { construct: 'Specification.initial_crystallize', status: 'available_unused', note: 'No generator surface currently selects session-creation cache crystallization.' },
  { construct: 'Specification.initial_trigger', status: 'available_unused', note: 'Create-time route sugar exists in v4.2.0; generated scaffolds seed sessions through ordinary triggers today.' },
  { construct: 'Mode.requires_delegations', status: 'adopt_backlog', note: 'Phase D backlog: v4.4 raw mode requires_delegations gates mode exit on real delegation dispatch; public anchors are node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:2488-2503 and node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:969-1081.' },
  { construct: 'Channel.direction', status: 'emitted', note: 'All generated channels declare In or Out direction.' },
  { construct: 'Channel.sync', status: 'emitted', note: 'All generated channels declare Sync or Async synchronicity.' },
  { construct: 'Channel.structured_decision', status: 'emitted', note: 'User confirmation channels declare structured_decision for approval loops.' },
  { construct: 'Channel.decision_targeting', status: 'emitted', note: 'Confirmation loops emit decision targeting over the active collection item.' },
  { construct: 'Channel.durable', status: 'emitted', note: 'Conversational hub entry channels opt into durable delivery.' },
  { construct: 'Channel.durability', status: 'emitted', note: 'Durable conversational hub channels declare retry and ordering policy.' },
  { construct: 'Channel.target_spec', status: 'emitted', note: 'Delegation channels declare child target specs.' },
  { construct: 'Channel.delegation_mode', status: 'available_unused', note: 'The foundry currently emits blocking delegation and rejects continue-mode delegation.' },
  { construct: 'DelegationMode.conversational', status: 'adopt_backlog', note: 'Phase D backlog: v4.4 DelegationMode includes conversational and caller inbox fields for bidirectional child questions; public anchors are node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:443-454 and node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:519-532.' },
  { construct: 'Channel.result_path', status: 'emitted', note: 'Delegation channels declare where child results land.' },
  { construct: 'Channel.result_schema', status: 'available_unused', note: 'Generated delegation schema is declared in Specification.schema, not Channel.result_schema.' },
  { construct: 'Channel.dynamic_target_arg', status: 'available_unused', note: 'Dynamic delegation targets are rejected by the current v1 delegation validator.' },
  { construct: 'Channel.max_delegated_rounds', status: 'emitted', note: 'Delegation children may emit per-child max delegated rounds.' },
  { construct: 'Channel.reacquire_timeout_ms', status: 'available_unused', note: 'No generator input exposes parent lock reacquire timeout overrides.' },
  { construct: 'Channel.round_timeout_ms', status: 'emitted', note: 'Delegation children may emit per-child round timeout.' },
  { construct: 'Channel.optional', status: 'emitted', note: 'Generated delegation channels are optional/degrade-only.' },
  { construct: 'Channel.mcp_connector', status: 'available_unused', note: 'Registered tools use the tool registry path, not mcp_connector channel declarations.' },
  { construct: 'Channel.message_type', status: 'available_unused', note: 'No generated agent-network or typed-channel fabric uses message_type yet.' },
  { construct: 'Channel.delivery_policy', status: 'available_unused', note: 'No generated typed-channel fabric uses delivery_policy yet.' },
  { construct: 'Channel.capabilities', status: 'available_unused', note: 'No generated typed-channel fabric declares channel capability tokens yet.' },
  { construct: 'Channel.ttl_ms', status: 'available_unused', note: 'No generated channel currently declares TTL.' },
  { construct: 'Channel.max_subscribers', status: 'available_unused', note: 'No generated broadcast/subscription channel declares subscriber caps.' },
  { construct: 'Predicate.FieldTruthy', status: 'emitted', note: 'Generated guards and preconditions use truthy checks.' },
  { construct: 'Predicate.FieldFalsy', status: 'emitted', note: 'Generated guards and preconditions use falsy checks.' },
  { construct: 'Predicate.FieldEquals', status: 'emitted', note: 'The foundry spec and generated specs use equality guards.' },
  { construct: 'Predicate.FieldEqualsField', status: 'available_unused', note: 'No generator descriptor emits cross-field equality yet.' },
  { construct: 'Predicate.FieldLessThan', status: 'emitted', note: 'Numeric aggregate predicates can emit this kind from collection lifecycle descriptors.' },
  { construct: 'Predicate.FieldLessOrEqual', status: 'emitted', note: 'Numeric aggregate predicates can emit this kind from collection lifecycle descriptors.' },
  { construct: 'Predicate.FieldGreaterThan', status: 'emitted', note: 'Numeric aggregate predicates can emit this kind from collection lifecycle descriptors.' },
  { construct: 'Predicate.FieldGreaterOrEqual', status: 'emitted', note: 'Document fidelity and numeric aggregate predicates emit this kind.' },
  { construct: 'Predicate.FieldContainsAll', status: 'emitted', note: 'Document fidelity emits token-coverage predicates.' },
  { construct: 'Predicate.FieldMatchesPattern', status: 'emitted', note: 'Document schema invariants emit required-pattern predicates.' },
  { construct: 'Predicate.FieldNotMatchesPattern', status: 'emitted', note: 'Document schema invariants emit forbidden-pattern predicates.' },
  { construct: 'Predicate.FieldSourceGrounded', status: 'emitted', note: 'Document schema invariants emit source-grounding predicates.' },
  { construct: 'Predicate.FieldInCollection', status: 'available_unused', note: 'No generator descriptor emits collection membership predicates yet.' },
  { construct: 'Predicate.CollectionSubset', status: 'available_unused', note: 'No generator descriptor emits subset predicates yet.' },
  { construct: 'Predicate.PreviousItemFieldEquals', status: 'emitted', note: 'Confirmation-loop cursor preconditions emit previous-item predicates.' },
  { construct: 'Predicate.AllNodesStatus', status: 'available_unused', note: 'No generated agent-network workflow emits node-status predicates yet.' },
  { construct: 'Predicate.AllItemsStatus', status: 'emitted', note: 'Collection lifecycle completion preconditions emit all-items status predicates.' },
  { construct: 'Predicate.EventEmitted', status: 'available_unused', note: 'Generated transitions currently use field and trigger predicates instead.' },
  { construct: 'Predicate.TriggerType', status: 'emitted', note: 'The foundry spec uses trigger-type preconditions for confirmation and system-entry rounds.' },
  { construct: 'Predicate.All', status: 'emitted', note: 'Document fidelity and recovery steers compose predicates with All.' },
  { construct: 'Predicate.Any', status: 'emitted', note: 'Optional document upload guards compose skip/upload alternatives with Any.' },
  { construct: 'Predicate.Implies', status: 'emitted', note: 'Confirmation-loop cursor preconditions emit Implies.' },
  { construct: 'Predicate.FieldIn', status: 'available_unused', note: 'Legacy raw predicate compatibility exists, but generated specs use the typed PredicateKind vocabulary.' },
  { construct: 'Predicate.FieldNe', status: 'held', note: 'Not present in the v4.2.0 PredicateKind type surface; do not emit unless the engine adds it.' },
  { construct: 'Predicate.Not', status: 'held', note: 'Not present in the v4.2.0 PredicateKind type surface; use shipped combinators only.' },
  { construct: 'action_map.mutations', status: 'emitted', note: 'Generated action_map entries emit declared mutations.' },
  { construct: 'action_map.mutations.from_arg', status: 'emitted', note: 'Generated actions source values from named tool-call args.' },
  { construct: 'action_map.mutations.from_state', status: 'emitted', note: 'Document-slice and delegated child specs source values from projected state.' },
  { construct: 'action_map.mutations.coerce', status: 'available_unused', note: 'No generated mutation currently needs declared value coercion.' },
  { construct: 'action_map.bounds', status: 'available_unused', note: 'ActionSemantics supports bounds, but generated YAML does not declare bounds today.' },
  { construct: 'action_map.channel', status: 'emitted', note: 'Generated action_map entries declare terminal effect channels.' },
  { construct: 'action_map.result_path', status: 'emitted', note: 'Stage, artifact-plan, verification, collection, document, and delegation actions emit result paths when needed.' },
  { construct: 'action_map.query_path', status: 'available_unused', note: 'Available for fixed-path query actions; generated specs rely on ProgramEntry queryPolicy instead.' },
  { construct: 'action_map.is_query', status: 'available_unused', note: 'Available for dynamic query actions; no generated action maps to QueryAction today.' },
  { construct: 'action_map.description', status: 'emitted', note: 'Generated action_map entries include tool-facing descriptions.' },
  { construct: 'action_map.arg_descriptions', status: 'emitted', note: 'Generated LLM reasoning, notebook, verification, and delegation actions emit arg descriptions.' },
  { construct: 'action_map.arg_schema', status: 'emitted', note: 'Contracted reasoning action args emit arg_schema at src/foundry-program/synthesizer/topology.ts:283; notebook pin/unpin key args emit arg_schema at src/foundry-program/synthesizer.ts:2542; confirmation-loop proposal content args emit arg_schema at src/foundry-program/synthesizer.ts:3789.' },
  { construct: 'action_map.continues', status: 'available_unused', note: 'No generated terminal action opts into forced auto-continue metadata.' },
  { construct: 'action_map.awaits_user_decision', status: 'emitted', note: 'Artifact planning, document upload, and confirmation loops park automation for user decisions.' },
  { construct: 'derived_paths.first_item_where_field_ne', status: 'emitted', note: 'Confirmation loops emit first-not-done cursor derivation.' },
  { construct: 'derived_paths.all_items_field_eq', status: 'emitted', note: 'Collection lifecycle completion emits universal equality derivation.' },
  { construct: 'derived_paths.any_item_field_eq', status: 'emitted', note: 'Confirmation loops emit existential proposed-item flags.' },
  { construct: 'derived_paths.items_where_field_eq', status: 'emitted', note: 'Confirmation loops emit status bucket partitions.' },
  { construct: 'derived_paths.sum_of', status: 'emitted', note: 'Collection lifecycle numeric sums emit sum_of derivation.' },
  { construct: 'derived_paths.from_predicate', status: 'available_unused', note: 'Generated specs compose predicates directly in guards/steers rather than deriving predicate truth into state.' },
  { construct: 'derived_paths.count_of', status: 'available_unused', note: 'No generated descriptor needs collection length derivation yet.' },
  { construct: 'derived_paths.concat', status: 'available_unused', note: 'No generated descriptor needs string concatenation derivation yet.' },
  { construct: 'derived_paths.field_value', status: 'available_unused', note: 'No generated descriptor needs field copy derivation yet.' },
  { construct: 'derived_paths.now_iso', status: 'available_unused', note: 'Generated programs currently use handlers/runtime values for timestamps.' },
  { construct: 'derived_paths.current_round', status: 'available_unused', note: 'Generated programs do not persist the current round via derived_paths yet.' },
  { construct: 'ProgramEntry.delegationPolicy', status: 'emitted', note: 'Generated registrations emit delegationPolicy for child routing and input enrichment.' },
  { construct: 'ProgramEntry.artifactPolicy', status: 'emitted', note: 'Generated registrations emit artifactPolicy for export surfaces.' },
  { construct: 'ProgramEntry.queryPolicy', status: 'emitted', note: 'Generated registrations emit an enforce-mode query policy over declared projection paths.' },
  { construct: 'ProgramEntry.reliabilityPolicy', status: 'adopt_backlog', note: 'Phase E backlog: v4.5 ProgramEntry can carry ProgramReliabilityPolicy retry/round/denial budgets at node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:5660-5681; Phase A emits no policies.' },
  { construct: 'ProgramEntry.reactionHandlers', status: 'emitted', note: 'Generated registrations wire generated reaction handlers.' },
  { construct: 'ProgramEntry.syncOutContinuationPolicy', status: 'emitted', note: 'Registered tool channels emit sync-out continuation policy.' },
  { construct: 'registerProgramByConvention', status: 'adopt_backlog', note: 'Phase E/F backlog: intended replacement for generated registration.ts, but the installed 4.5.0 public create-server/plugin declaration exports do not yet include registerProgramByConvention (checked create-server.d.ts:6-18 and plugin.d.ts:6-150); do not adopt until the public export is present.' },
] as const;

export const ENGINE_PRIMITIVE_REGISTRY: readonly EnginePrimitiveEntry[] = [
  {
    computation_class: 'iteration_cursor',
    primitive_index: 1,
    primitive_name: 'first_item_where_field_ne',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#829',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.28.0',
    build_order_note: 'Adopted after #3 keyed_by landed; confirmation-loop indexed collections keep status and terminal marker on the scanned collection.',
  },
  {
    computation_class: 'completion_guard',
    primitive_index: 2,
    primitive_name: 'all_items_field_eq',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831',
    request_ref: 'docs/curator-requests/2026-08-06-completion-predicate.md',
    foundry_enforcement: 'active',
    since_engine_version: '3.29.0',
    build_order_note: 'Narrow completion_guard class split from broad domain_shape_branch to avoid refusing ordinary domain branching while enforcing all-items completion equality.',
  },
  {
    computation_class: 'compute_dedup',
    primitive_index: 3,
    primitive_name: 'keyed_by',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831 roadmap',
    request_ref: 'docs/curator-requests/2026-08-06-keyed-idempotent-collection.md',
    foundry_enforcement: 'active',
    since_engine_version: '3.29.0',
    build_order_note: 'Linchpin primitive; foundry keeps compute_dedup enforcement active and emits keyed_collections instead of imperative dedup.',
  },
  {
    computation_class: 'numeric_validation',
    primitive_index: 4,
    primitive_name: 'numeric_comparison_predicate',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.30.0',
    build_order_note: 'Narrowed from broad adhoc_validation_throw to numeric threshold/coherence validation only; structural validation remains detected but has no landed primitive.',
  },
  {
    computation_class: 'recovery_steer',
    primitive_index: 5,
    primitive_name: 'recovery_steer',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#831',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.30.0',
    build_order_note: 'Confirmation-loop per-round recovery guidance emits recovery_steers; 3.32.0 enrichment now uses idempotent set and template_paths for derived active-item cursor guidance.',
  },
  {
    computation_class: 'existential_completion_guard',
    primitive_index: 6,
    primitive_name: 'any_item_field_eq',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow existential completion flag over collection field equality; emitted from the same derived-path helper as all_items_field_eq.',
  },
  {
    computation_class: 'partition_by_verdict',
    primitive_index: 7,
    primitive_name: 'items_where_field_eq',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow partition-by-verdict buckets for approval flows; broad filter/group reshaping remains outside this class.',
  },
  {
    computation_class: 'numeric_aggregate',
    primitive_index: 8,
    primitive_name: 'sum_of',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow numeric sum aggregation over indexed collection item fields; non-sum grouping/aggregation remains refused as compute_aggregate.',
  },
  {
    computation_class: 'token_coverage_validation',
    primitive_index: 9,
    primitive_name: 'FieldContainsAll',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.32.0',
    build_order_note: 'Narrow authored-text required-token coverage validation; other structural validation throws remain outside this primitive.',
  },
  {
    computation_class: 'content_key_merge',
    primitive_index: 10,
    primitive_name: 'merge_collections',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#844',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'pending',
    since_engine_version: '3.32.0',
    build_order_note: 'Register-only adoption: no foundry content-key merge emitter exists today; keyed persistence continues to use keyed_collections, so merge_collections enforcement stays pending until a content-key reducer emitter is introduced.',
  },
  {
    computation_class: 'regex_validation',
    primitive_index: 11,
    primitive_name: 'FieldMatchesPattern/FieldNotMatchesPattern',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#862',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.34.0',
    build_order_note: 'Narrow regex-pattern validation over extracted document record text; foundry emits FieldMatchesPattern/FieldNotMatchesPattern in schema_invariants and refuses imperative RegExp validation in stage bodies.',
  },
  {
    computation_class: 'source_grounding_validation',
    primitive_index: 12,
    primitive_name: 'FieldSourceGrounded',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#862',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '3.34.0',
    build_order_note: 'Narrow anti-fabrication validation for extracted document records; foundry emits FieldSourceGrounded in schema_invariants with engine-owned token extractors and source allowlist paths.',
  },
  {
    computation_class: 'arg_schema',
    primitive_index: 13,
    primitive_name: 'arg_schema',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#891',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '4.2.0',
    build_order_note: 'Generated contracted reasoning actions, notebook pin/unpin actions, and confirmation-loop proposal actions emit action_map.arg_schema from existing contract/lifecycle/sentinel arg constraints; free-form reasoning and wildcard notebook actions remain unconstrained.',
  },
  {
    computation_class: 'no_action_escape',
    primitive_index: 14,
    primitive_name: 'no_action_escapes',
    primitive_status: 'landed',
    pgas_ref: 'simodelne/pgas#889',
    request_ref: CONVERGENCE_ALIGNMENT_REQUEST,
    foundry_enforcement: 'active',
    since_engine_version: '4.2.0',
    build_order_note: 'Confirmation-loop authoring modes emit no_action_escapes with engine-owned counter/arm paths; the arm gates a blocked terminal route and disables further proposal attempts rather than auto-approving unresolved items. Complements recovery_steers: recovery_steers arm on predicates, no_action_escapes arm on fallback-round count, both arm-only.',
  },
] as const;

export function primitiveForConstruct(kind: EnginePrimitiveConstructKind): EnginePrimitiveEntry | undefined {
  return ENGINE_PRIMITIVE_REGISTRY.find((entry) => entry.computation_class === kind);
}

export function activeEnforcedConstructs(
  registry: readonly EnginePrimitiveEntry[] = ENGINE_PRIMITIVE_REGISTRY,
): ReadonlySet<GovernedConstructKind> {
  return new Set(
    registry
      .filter((entry): entry is EnginePrimitiveEntry & { computation_class: GovernedConstructKind } =>
        entry.foundry_enforcement === 'active' && isGovernedConstructKind(entry.computation_class))
      .map((entry) => entry.computation_class),
  );
}

export function refusedConstructs(
  registry: readonly EnginePrimitiveEntry[] = ENGINE_PRIMITIVE_REGISTRY,
): ReadonlySet<GovernedConstructKind> {
  return new Set(
    registry
      .filter((entry): entry is EnginePrimitiveEntry & { computation_class: GovernedConstructKind } =>
        entry.foundry_enforcement === 'active' &&
        entry.primitive_status !== 'landed' &&
        isGovernedConstructKind(entry.computation_class))
      .map((entry) => entry.computation_class),
  );
}

function isGovernedConstructKind(kind: EnginePrimitiveConstructKind): kind is GovernedConstructKind {
  return kind !== 'arg_schema' && kind !== 'no_action_escape';
}
