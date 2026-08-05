import { describe, expect, it } from 'vitest';

import { MockPersistenceConnector } from '../fixtures/persistence-mock.js';

const KEY = 'email';
const s1 = [{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'b@x.com' }];

describe('PersistenceHostConnector mock (cross-session)', () => {
  it('P-1 upsert inserts new records', async () => {
    const c = new MockPersistenceConnector();
    const r = await c.upsert_lead(s1, KEY);
    expect(r.inserted).toBe(2);
    expect(r.updated).toBe(0);
  });

  it('P-2 cross-session dedupe: re-running with an overlapping record updates, not duplicates', async () => {
    const c = new MockPersistenceConnector();
    await c.upsert_lead(s1, KEY);
    const r = await c.upsert_lead([{ name: 'A2', email: 'a@x.com' }, { name: 'C', email: 'c@x.com' }], KEY);
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(1);
    const all = await c.query({});
    expect(all.length).toBe(3);
  });

  it('P-3 dedupe() within a batch collapses same-key rows before upsert', async () => {
    const c = new MockPersistenceConnector();
    const deduped = await c.dedupe([{ email: 'z@x.com' }, { email: 'z@x.com' }], KEY);
    expect(deduped.length).toBe(1);
  });
});
