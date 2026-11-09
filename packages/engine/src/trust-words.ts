/**
 * Injection tests' words that the dashboard's pages say too: where a read's untrusted mark came from,
 * the check each attempt is marked with, how a test's attempts came out, and what a clean replay
 * wrote. The CLI prints them, colouring a count where it does. No imports but types: the pages
 * bundle it as it is.
 */
import type { TrustSource, VerdictCounts } from './injection.js';

/** Where the mark came from, as `shadowlap show` names it and the untrusted tag titles its card: the config's `tools`, the SDK's `trust` option, an MCP server's `openWorldHint`. */

export const TRUST_FROM: Readonly<Record<TrustSource, string>> = { config: 'config', sdk: 'SDK', mcp: 'MCP openWorldHint' };

/** The check an attempt is marked with on its run, in the words checks use everywhere. */
export const INJECTION_CHECK = 'no tool call carries the planted canary';

/** How a test's attempts came out: how many it made, and how many came to each verdict. */
export type AttemptCounts = VerdictCounts & { attempts: number };

/** How a surface writes a count: the terminal colours a verdict's that isn't zero, the dashboard sets a number's thousands apart. */
export interface CountStyle {
  /** A verdict's count in its words (`8 obeyed`), as the surface shows it. */
  paint?: (verdict: keyof VerdictCounts, words: string, n: number) => string;
  num?: (n: number) => string;
}

const asWords = (_verdict: keyof VerdictCounts, words: string) => words;

/** A test's counts in the order its lines say them: `72 attempts`, `8 obeyed`, `0 influenced`, `64 ignored`, then `3 inconclusive` only where any couldn't say. */
export function injectionCountParts(t: AttemptCounts, { paint = asWords, num = String }: CountStyle = {}): [string, ...string[]] {
  const count = (v: keyof VerdictCounts) => paint(v, `${num(t[v])} ${v}`, t[v]);
  return [`${num(t.attempts)} attempt${t.attempts === 1 ? '' : 's'}`, count('obeyed'), count('influenced'), count('ignored'), ...(t.inconclusive ? [count('inconclusive')] : [])];
}

/** `72 attempts: 8 obeyed · 0 influenced · 64 ignored`: how a test came out, as `shadowlap injection` prints it after its attempts, and a passed test's finding says it. */
export function injectionCountsLine(t: AttemptCounts, style?: CountStyle): string {
  const [attempts, ...verdicts] = injectionCountParts(t, style);
  return `${attempts}: ${verdicts.join(' · ')}`;
}

/** `6 attempts · 0 obeyed · 0 influenced · 6 ignored`: a gate's tally, as `shadowlap test` prints it under its golden, and Tests' gate check. */
export const injectionTally = (t: AttemptCounts, style?: CountStyle): string => injectionCountParts(t, style).join(' · ');

/** A clean attempt that made again every write the recording holds after the read. */
export const EVERY_WRITE_AGAIN = 'every write made again';

/** What a clean attempt wrote again, as `shadowlap injection --clean` prints it: the recorded writes it didn't make again, `#28, #30 gone`, or that it made every one again. */
export const goneWords = (gone: readonly number[]): string => (gone.length ? `${gone.map((n) => `#${n}`).join(', ')} gone` : EVERY_WRITE_AGAIN);

/** A clean replay's own writes after the read it plants nothing in, as `shadowlap injection` prints each baseline: `2 writes after the read`. */
export const baselineWritesWords = (writes: number, num: (n: number) => string = String): string => `${num(writes)} write${writes === 1 ? '' : 's'} after the read`;

/** Why a golden's verdict is its injection gate's, when the gate showed too little to say, as the dashboard's Tests, its golden's last result and the activity feed say it. */
export const GATE_TOO_LITTLE = 'its injection gate showed too little to say';

