import type { LeadRecord, PersistenceHostConnector, UpsertResult } from './persistence-connector.js';

type StoreKind = 'lead' | 'contact';

export class MockPersistenceConnector implements PersistenceHostConnector {
  private readonly stores = new Map<string, Map<string, LeadRecord>>();

  async upsert_lead(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult> {
    return this.upsert('lead', records, dedupe_key);
  }

  async upsert_contact(records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult> {
    return this.upsert('contact', records, dedupe_key);
  }

  async query(filter: Record<string, unknown>): Promise<readonly LeadRecord[]> {
    const records = [...this.stores.values()].flatMap((store) => [...store.values()]);
    const entries = Object.entries(filter);
    if (entries.length === 0) {
      return records.map(cloneRecord);
    }
    return records
      .filter((record) => entries.every(([key, value]) => Object.is(record[key], value)))
      .map(cloneRecord);
  }

  async dedupe(records: readonly LeadRecord[], dedupe_key: string): Promise<readonly LeadRecord[]> {
    const collapsed = new Map<string, LeadRecord>();
    for (const record of records) {
      collapsed.set(recordId(record, dedupe_key), cloneRecord(record));
    }
    return [...collapsed.values()];
  }

  private async upsert(kind: StoreKind, records: readonly LeadRecord[], dedupe_key: string): Promise<UpsertResult> {
    const store = this.storeFor(kind, dedupe_key);
    const deduped = await this.dedupe(records, dedupe_key);
    let inserted = 0;
    let updated = 0;
    const ids: string[] = [];

    for (const record of deduped) {
      const id = recordId(record, dedupe_key);
      if (store.has(id)) {
        updated += 1;
      } else {
        inserted += 1;
      }
      store.set(id, cloneRecord(record));
      ids.push(id);
    }

    return { inserted, updated, ids };
  }

  private storeFor(kind: StoreKind, dedupe_key: string): Map<string, LeadRecord> {
    const key = `${kind}:${dedupe_key}`;
    const existing = this.stores.get(key);
    if (existing) {
      return existing;
    }
    const created = new Map<string, LeadRecord>();
    this.stores.set(key, created);
    return created;
  }
}

function recordId(record: LeadRecord, dedupe_key: string): string {
  if (!dedupe_key) {
    throw new Error('dedupe_key must be a non-empty string');
  }
  if (!Object.hasOwn(record, dedupe_key)) {
    throw new Error(`record is missing dedupe_key field ${dedupe_key}`);
  }
  const value = record[dedupe_key];
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error(`record dedupe_key field ${dedupe_key} must be a string, number, or boolean`);
  }
  return `${dedupe_key}:${String(value)}`;
}

function cloneRecord(record: LeadRecord): LeadRecord {
  return { ...record };
}
