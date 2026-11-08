/**
 * What a call was, as a recording's strip, its key and its Timeline draw it (the page's
 * ui/run/kinds.ts): one character per call in a run's `kinds` string, m a model call, r a read, w a
 * write, e an error. A call that went wrong is an error whatever it was, but not one the fence
 * answered (blocked or stubbed), which is named by what it would have done; a tool with no declared
 * effect, a clock or random read and a person's input are reads. run-summary.ts says the same in SQL
 * (`KIND`). No store and no DOM here: the page imports it.
 */

export type KindCode = 'm' | 'r' | 'w' | 'e';

export function kindCode(c: { kind: string; effect: string | null; origin: string; outcome: string | null | undefined }): KindCode {
  if (c.outcome === 'error' && c.origin !== 'blocked' && c.origin !== 'stubbed') return 'e';
  if (c.kind === 'api') return 'm';
  return c.kind === 'tool' && c.effect === 'write' ? 'w' : 'r';
}
