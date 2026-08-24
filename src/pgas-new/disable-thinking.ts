// Thinking-disable policy for every OpenAI-compatible author payload the foundry
// builds. The block between the parity markers below is copied VERBATIM into
// `templates/pgas-new/standalone/src/author-driver.ts.tmpl`, because a generated
// program cannot import foundry `src/`. `tests/unit/disable-thinking.test.ts`
// fails the build if the two copies drift.
// --- BEGIN pgas thinking policy (parity-locked) ---
/**
 * Canonical thinking-disable policy.
 *
 * pgas v6 canonicalizes the engine's disable policy on `PGAS_DISABLE_THINKING=1`
 * and removes the engine's Qwen/GLM model-prefix inference. `PGAS_OPENAI_DISABLE_THINKING`
 * remains supported as the consumer-owned fallback, but the engine no longer treats
 * it as sufficient, so the canonical variable wins whenever it is explicitly set:
 *
 *   PGAS_DISABLE_THINKING=1  -> disable thinking, whatever the model family
 *   PGAS_DISABLE_THINKING=0  -> keep thinking enabled, even when PGAS_OPENAI_DISABLE_THINKING is set
 *   unset / any other value  -> qwen-family fallback (PGAS_OPENAI_DISABLE_THINKING !== '0')
 *
 * Getting this wrong fails SILENTLY: nothing errors, the model simply resumes
 * emitting thinking tokens into the author round.
 */
export function shouldDisableThinking(
  model: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const canonical = env.PGAS_DISABLE_THINKING;
  if (canonical === '1') return true;
  if (canonical === '0') return false;
  return model.toLowerCase().startsWith('qwen') && env.PGAS_OPENAI_DISABLE_THINKING !== '0';
}
// --- END pgas thinking policy ---
