export interface LeadRecord { readonly [key: string]: unknown } // shaped by extraction_schema; dedupe_key must be present
export interface UpsertResult { readonly inserted: number; readonly updated: number; readonly ids: readonly string[] }
export interface PersistenceHostConnector {
  upsert_lead(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  upsert_contact(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult>;
  query(filter: Record<string, unknown>): Promise<readonly LeadRecord[]>;
  dedupe(records: readonly LeadRecord[], dedupe_key: string): Promise<readonly LeadRecord[]>;
}
