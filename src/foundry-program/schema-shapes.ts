import { isRecord } from '../util/guards.js';

export function isRepeatedRecordSchema(value: unknown): value is [Record<string, unknown>] {
  return Array.isArray(value) && value.length === 1 && isRecord(value[0]);
}
