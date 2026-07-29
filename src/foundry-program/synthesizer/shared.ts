import type { Completion, IntakeTransition, MutableRecord } from './types.js';

const PGAS_CHANNEL_ID_MAX_LENGTH = 64;

export function safeIdentifier(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '');
  return normalized.length > 0 ? normalized : 'stage';
}

export function normalizePgasChannelId(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (/\bfrontend_intake\b/u.test(lowered) || /\bfrontend\b[\s\S]*\bstructured\s+intake\b/u.test(lowered)) {
    return 'frontend_intake';
  }
  if (/\buser_text\b/u.test(lowered)) {
    return 'user_text';
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  const bounded = slug
    .slice(0, PGAS_CHANNEL_ID_MAX_LENGTH)
    .replace(/^_+|_+$/gu, '');
  return bounded.length > 0 ? bounded : 'user_text';
}

export function tsString(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

export function guardFieldForTransition(transition: IntakeTransition, completion: Completion): string | undefined {
  const transitionGuard = normalizeGuardField(transition.guard_field);
  if (transition.to === completion.final_stage) {
    return transitionGuard ?? normalizeGuardField(completion.guard_field);
  }
  return transitionGuard;
}

export function guardFromField(field: string | undefined): Record<string, unknown> | undefined {
  const normalized = normalizeGuardField(field);
  if (!normalized) return undefined;
  return { kind: 'FieldTruthy', path: normalized };
}

export function normalizeGuardField(field: string | undefined): string | undefined {
  if (typeof field !== 'string') return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function channelsForBootstrap(entryChannel: string): string[] {
  return unique([entryChannel, 'system_mode_entry', 'widget_output']);
}

export function initialInputPath(entryChannel: string): string {
  return `inputs.initial_${safeIdentifier(entryChannel)}`;
}

export function recordField(parent: MutableRecord, key: string): MutableRecord {
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected object field: ${key}`);
  }
  return value as MutableRecord;
}

export function recordOrEmpty(value: unknown): MutableRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MutableRecord
    : {};
}

export function cloneRecord(value: unknown): MutableRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object to clone');
  }
  return JSON.parse(JSON.stringify(value)) as MutableRecord;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}
