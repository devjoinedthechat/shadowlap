import type { LookAdvice } from './row.js';

/**
 * Needs a look's advice: the rows that only advise (behaviours no golden covers, runs only on this
 * machine, a model the goldens use that retires), worked out here so the page never decides what is
 * advice. Each has a key, the same for as long as it is the same advice, and the facts it states
 * now. Its owner may put it away (Dismiss): it stays put away while every fact it states was among
 * those kept (the engine's stillDismissed, dismissals.ts), so only a fact it didn't state then brings
 * it back. A failure is never advice.
 *
 * A later kind joins with a line in KINDS and `advice: adviceOf(key, facts)` in its source. It
 * states at least one fact: advice stating none would stay put away for good.
 */

/** Each kind: its key's form, and Dismiss's hover, which says what brings it back. */
const KINDS: ReadonlyArray<{ is: (key: string) => boolean; until: string }> = [
  { is: (key) => key === 'coverage', until: 'Until another behaviour has no golden' },
  { is: (key) => key === 'local', until: 'Until another run is only on this machine' },
  // `retire <model>`. Until a migration's checked line is one of its facts (port/migrate), only a date or a golden brings it back.
  { is: (key) => /^retire \S+$/.test(key), until: 'Until a new date or golden' },
];

/** The longest key or fact the dashboard keeps: a model's name, a run's id, a golden's path. */
export const ADVICE_TEXT_MAX = 1024;

/** Whether `key` names advice: `coverage`, `local` or `retire <model>`, the engine's key forms. */
export function isAdviceKey(key: unknown): boolean {
  return typeof key === 'string' && key.length <= ADVICE_TEXT_MAX && KINDS.some((k) => k.is(key));
}

/** A row's advice under `key`, stating `facts` (each once, sorted), not put away until withDismissals says so. */
export function adviceOf(key: string, facts: Iterable<string>): LookAdvice {
  const kind = KINDS.find((k) => k.is(key));
  if (!kind) throw new Error(`Needs a look has no advice under "${key}"`);
  return { key, facts: [...new Set(facts)].sort(), until: kind.until, dismissed: false };
}
