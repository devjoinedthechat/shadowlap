import { expectFlag, isObject } from '@shadowlap/engine';

/** The longest check JSON a job's request may carry, as the fix jobs take theirs. */
export const MAX_EXPECT = 20_000;

/**
 * The checks a job's request gives as `expect` (JSON text, or an object), read as the CLI reads
 * `--expect` (the engine's parseExpect, refused in its words) and passed on canonically, so the line a
 * question shows is the line that runs: `--expect <json>`, or nothing when none is given. The presets
 * on a run (`chaos`) and a golden that forks (`coverage-pack`) both take theirs here.
 */
export function expectArgs(value: unknown): { args: string[] } | { error: string } {
  if (value === undefined || value === null || value === '') return { args: [] };
  const text = typeof value === 'string' ? value : isObject(value) ? JSON.stringify(value) : null;
  if (text === null) return { error: 'expect is the checks, as JSON such as {"tools":{"issue_refund":0}}' };
  if (text.length > MAX_EXPECT) return { error: 'those checks are too long' };
  return expectFlag(text);
}
