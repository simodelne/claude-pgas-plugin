import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { isRecord } from '../../util/guards.js';
import { assertConfirmationPairingTerminals } from '../composite-checks.js';

export function validateSynthesizedSpec(specYaml: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-synth-'));
  try {
    const specPath = join(dir, 'specs.yml');
    writeFileSync(specPath, specYaml);
    loadSpecWithPatterns(specPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const parsed = load(specYaml);
  assertPreconditionVocabularyAlignment(parsed);
  assertConfirmationPairingTerminals(parsed);
}

/**
 * Locks the precondition-vocabulary invariant on every synthesized spec: each
 * mode's `preconditions` keys must be a subset of that mode's `vocabulary`.
 * A precondition keyed on an action the mode cannot emit is dead — the engine
 * warns on dead preconditions today and will reject them as ERRORS in a
 * future release (pgas#620). Synthesized specs currently emit no
 * `preconditions` at all, so this holds by construction; the assertion exists
 * to fail synthesis loudly if a future generator change regresses that.
 */
export function assertPreconditionVocabularyAlignment(spec: unknown): void {
  if (!isRecord(spec)) {
    throw new Error('precondition vocabulary alignment requires a parsed spec object');
  }
  const modes = spec.modes;
  if (!isRecord(modes)) {
    throw new Error('precondition vocabulary alignment requires spec.modes to be a mapping');
  }
  for (const [modeName, mode] of Object.entries(modes)) {
    if (!isRecord(mode)) {
      throw new Error(`synthesized mode "${modeName}" must be a mapping`);
    }
    const vocabulary = new Set(
      Array.isArray(mode.vocabulary)
        ? (mode.vocabulary as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
    const preconditions = mode.preconditions;
    if (preconditions === undefined || preconditions === null) {
      continue;
    }
    if (!isRecord(preconditions)) {
      throw new Error(`synthesized mode "${modeName}" preconditions must be a mapping of action name to predicates`);
    }
    for (const actionName of Object.keys(preconditions)) {
      if (!vocabulary.has(actionName)) {
        throw new Error(
          `synthesized mode "${modeName}" declares a precondition for action "${actionName}" that is not in the mode's vocabulary — dead preconditions become engine errors (pgas#620)`,
        );
      }
    }
  }
}
