/**
 * pgas#993 keyed-extraction scenario — SHARED by the hermetic proof
 * (tests/integration/keyed-collection-live-scenario.test.ts) and the env-gated
 * live drive (tests/integration/generated-live-drive.test.ts), so the two can
 * never drift apart.
 *
 * Why this shape: `keyedCollectionsForPersistence` only declares a keyed
 * collection when (a) some stage declares persistence, (b) the domain carries a
 * `dedupe_key`, and (c) an llm-reasoning stage's contract has a `record_array`
 * field whose `record_fields` contain that key. This domain satisfies all three
 * with the smallest honest workflow: intake → extract_records (llm-reasoning,
 * keyed record_array) → persist_records (external-adapter, persistence) →
 * complete.
 *
 * The drive input is a catalogue listing that RE-STATES one entry under the same
 * record id with corrected values. That is what makes the upsert-by-key property
 * testable at all: without a genuine re-append, "the same key twice yields one
 * element" is never exercised. The correction is part of the DOMAIN MATERIAL —
 * it is not an instruction to the model about which action to call, and the
 * drive's continuation text stays neutral.
 */

export const KEYED_COLLECTION_SLUG = 'keyed-extraction-live';
export const KEYED_COLLECTION_NAME = 'Keyed Extraction Live';
export const KEYED_COLLECTION_STAGE = 'extract_records';
export const KEYED_COLLECTION_PERSIST_STAGE = 'persist_records';
export const KEYED_COLLECTION_FIELD = 'records';
export const KEYED_COLLECTION_KEY = 'record_id';
export const KEYED_COLLECTION_PATH = `${KEYED_COLLECTION_STAGE}.result.${KEYED_COLLECTION_FIELD}`;
export const KEYED_COLLECTION_APPEND_ACTION = `append_${KEYED_COLLECTION_STAGE}_${KEYED_COLLECTION_FIELD}`;
export const KEYED_COLLECTION_TERMINAL_ACTION = `complete_${KEYED_COLLECTION_STAGE}`;

/** The record id the listing re-states under corrected values. */
export const KEYED_COLLECTION_SUPERSEDED_ID = 'R-1001';
/** Every record id the listing states, in listing order (the superseded id twice). */
export const KEYED_COLLECTION_LISTED_IDS = ['R-1001', 'R-1002', 'R-1003', 'R-1001'] as const;
/** Distinct record ids — the collection size a working keyed upsert must land on. */
export const KEYED_COLLECTION_DISTINCT_IDS = ['R-1001', 'R-1002', 'R-1003'] as const;

/**
 * The drive input. The correction is stated as source material ("re-issued …
 * supersedes"), never as a steering instruction naming an action, a call count,
 * or the keyed mechanism.
 */
export const KEYED_COLLECTION_INITIAL_TEXT = [
  'Q3 archive catalogue listing. Record every catalogue entry stated below.',
  '',
  '  R-1001  Halogen Lamp Assembly    unit price 42',
  '  R-1002  Copper Bus Bar           unit price 17',
  '  R-1003  Ceramic Insulator Set    unit price 9',
  '',
  'Correction notice attached to the same listing: entry R-1001 was re-issued.',
  'Its label is now "Halogen Lamp Assembly (Rev B)" and its unit price is now 46.',
  'The re-issued values supersede the originals for record id R-1001.',
].join('\n');

const REASONING_PROMPT = [
  'Record every catalogue entry that appears in the supplied listing under the stable record id the listing',
  'states for it. Read the listing from top to bottom and treat each stated entry as a record carrying its own',
  'record_id, label and unit_price. When the listing re-states or corrects an entry under a record id you have',
  'already recorded, record it again under that SAME record id with the corrected values, because the corrected',
  'values supersede the earlier ones for that record id. Never invent a record the listing does not state, and',
  'never omit one that it does. Finally report how many distinct record ids you recorded and a short note about',
  'the recording pass.',
].join(' ');

const RECORD_FIELDS = {
  record_id: 'string',
  label: 'string',
  unit_price: 'number',
} as const;

export const keyedCollectionDomain: Record<string, unknown> = {
  'program.slug': KEYED_COLLECTION_SLUG,
  'program.name': KEYED_COLLECTION_NAME,
  'program.target_dir': `/tmp/${KEYED_COLLECTION_SLUG}`,
  'program.design_path': 'design',
  'intake.purpose':
    'Record every catalogue entry from a supplied listing under its stated record id, then persist the recorded set and complete.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    {
      slug: KEYED_COLLECTION_STAGE,
      archetype: 'llm-reasoning',
      domain_spec: {
        reads: ['inputs.user_text', 'inputs.initial_user_text', 'config.persistence.dedupe_key'],
        produces: {
          result_json: {
            [KEYED_COLLECTION_FIELD]: [RECORD_FIELDS],
            record_count: 'number',
            extraction_notes: 'string',
          },
          items_json: [`record:<${KEYED_COLLECTION_KEY}>`],
        },
        rules: ['Record every catalogue entry the listing states, under the record id the listing gives it.'],
        invariants: [
          `Every recorded entry carries the ${KEYED_COLLECTION_KEY} the listing states for it.`,
          'A re-stated record id carries the corrected values, which supersede the earlier ones.',
        ],
      },
    },
    {
      slug: KEYED_COLLECTION_PERSIST_STAGE,
      archetype: 'external-adapter',
      integration: 'persistence',
      connector_slug: 'persistence',
      domain_spec: {
        reads: [KEYED_COLLECTION_PATH, 'config.persistence.dedupe_key'],
        produces: {
          result_json: { inserted: 'number', updated: 'number' },
          items_json: [`persisted:<${KEYED_COLLECTION_KEY}>`],
        },
        rules: ['Upsert the recorded catalogue entries through PersistenceHostConnector only.'],
        invariants: ['Never dedupe in stage code; the declared keyed collection owns dedupe.'],
      },
    },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: KEYED_COLLECTION_STAGE, trigger: 'started', guard_field: 'intake.started' },
    {
      from: KEYED_COLLECTION_STAGE,
      to: KEYED_COLLECTION_PERSIST_STAGE,
      trigger: 'recorded',
      guard_field: `${KEYED_COLLECTION_STAGE}.done`,
    },
    {
      from: KEYED_COLLECTION_PERSIST_STAGE,
      to: 'complete',
      trigger: 'persisted',
      guard_field: `${KEYED_COLLECTION_PERSIST_STAGE}.ready`,
    },
  ]),
  'intake.delegation_json': JSON.stringify({
    stages: {
      [KEYED_COLLECTION_STAGE]: { kind: 'llm-reasoning', reasoning_per_turn: true },
      [KEYED_COLLECTION_PERSIST_STAGE]: {
        kind: 'external-adapter',
        integration: 'persistence',
        connector_slug: 'persistence',
      },
    },
  }),
  'intake.completion_json': JSON.stringify({
    final_stage: 'complete',
    guard_field: `${KEYED_COLLECTION_PERSIST_STAGE}.ready`,
  }),
  config: {
    persistence: { entity_type: 'catalogue_record', dedupe_key: KEYED_COLLECTION_KEY },
  },
};

/**
 * HERMETIC-ONLY canned reasoning contract. The live drive must NOT use this — it
 * runs under PGAS_REASONING_CONTRACT_REQUIRE_LLM=1 so the real meta-LLM authors
 * the contract, and `deriveKeyedCollectionScript` refuses the drive if that
 * contract failed to produce the keyed record_array.
 */
export function keyedCollectionReasoningContractJson(stage: string): string {
  return JSON.stringify({
    stage,
    reasoning_prompt: REASONING_PROMPT,
    result_schema: {
      fields: [
        {
          name: KEYED_COLLECTION_FIELD,
          type: 'record_array',
          description: 'The catalogue records stated by the listing.',
          record_fields: RECORD_FIELDS,
        },
        { name: 'record_count', type: 'number', description: 'How many distinct record ids were recorded.' },
        { name: 'extraction_notes', type: 'string', description: 'A short note about the recording pass.' },
      ],
      allow_extra_fields: true,
    },
    items_schema: {
      templates: [`record:<${KEYED_COLLECTION_KEY}>`],
      description: 'One item string per recorded catalogue entry.',
    },
    canned_example: {
      result: {
        [KEYED_COLLECTION_FIELD]: [{ record_id: 'R-0001', label: 'Example Part', unit_price: 1 }],
        record_count: 1,
        extraction_notes: 'one record recorded',
      },
      items: ['record:R-0001'],
    },
  });
}
