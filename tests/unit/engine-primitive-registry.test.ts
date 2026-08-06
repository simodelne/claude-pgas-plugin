import { describe, it, expect } from 'vitest';
import { primitiveForConstruct, ENGINE_PRIMITIVE_REGISTRY } from '../../src/foundry-program/engine-primitive-registry.js';

describe('engine-primitive-registry', () => {
  it('maps compute_dedup to the keyed/idempotent-collection active ask', () => {
    const e = primitiveForConstruct('compute_dedup');
    expect(e).toBeDefined();
    expect(e!.primitive_name).toBe('keyed_idempotent_collection');
    expect(e!.status).toBe('active_ask');
    expect(e!.request_ref).toContain('keyed-idempotent-collection');
  });
  it('every entry references an existing curator-request doc path', () => {
    for (const e of ENGINE_PRIMITIVE_REGISTRY) expect(e.request_ref).toMatch(/^docs\/curator-requests\/.+\.md$/);
  });
});
