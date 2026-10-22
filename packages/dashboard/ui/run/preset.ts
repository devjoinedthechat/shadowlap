import type { ChaosMatrix } from '../types.js';

/**
 * An error-path preset's attempt, as its run's page says it (`/api/chaos/runs/:id`, the presets of
 * the session that decided it, on its recording): which preset it played in, on which golden, at
 * which call, which attempt it was, and how it came out by the preset's verdict, which the run's own
 * state can't say (an injected failure that the agent exits with an error on is no failure of the
 * run by itself: the preset decides). No DOM here.
 */
export interface PresetAttempt {
  /** The preset in words: `tool timeout`. */
  label: string;
  golden: string | null;
  /** The recording's call it hit, and what that call is (`list_inbox`, `POST /v1/messages`). */
  callNo: number | null;
  target: string | null;
  verdict: 'passed' | 'failed' | 'inconclusive';
  /** Which of the preset's attempts it was, from 1, and how many the preset made. */
  attempt: number;
  of: number;
  /** What the preset played in, where, as its result says it: `list_inbox (#2) timed out`; null when it doesn't say. */
  played: string | null;
  /** What the agent did: `the agent exited with code 1 (TimeoutError: list_inbox timed out)`; for one that couldn't say, why. */
  outcome: string;
  exitCode: number | null;
}

/** What precedes the outcome in a preset's detail: `list_inbox (#2) timed out` in `list_inbox (#2) timed out: the agent exited 0`. */
const beforeOutcome = (detail: string): string | null => {
  const at = detail.indexOf(': ');
  return at < 0 ? null : detail.slice(0, at).trim() || null;
};

/** What follows the call in a preset's detail: `the agent exited 0` in `list_inbox (#2) answered with nothing: the agent exited 0`. */
const afterCall = (detail: string): string | null => {
  const at = detail.indexOf(': ');
  return at < 0 ? null : detail.slice(at + 2).trim() || null;
};

/** The preset this run is an attempt of, from the presets that decided it; null for a run no preset made. */
export function presetAttempt(matrix: ChaosMatrix | null | undefined, runId: string): PresetAttempt | null {
  for (const c of matrix?.cells ?? []) {
    const i = c.runs.findIndex((r) => r.runId === runId);
    if (i < 0) continue;
    const x = c.runs[i]!;
    const exited = `the agent exited ${x.exitCode === 0 ? '0' : `with code ${x.exitCode}`}`;
    // Its own words when the result kept them; else a preset decided by one attempt says it in its
    // own words, and one of several this attempt's exit.
    const outcome = x.reason ?? (c.runs.length === 1 ? afterCall(c.detail) : null) ?? exited;
    return { label: c.label, golden: matrix!.golden, callNo: c.callNo, target: c.target?.name ?? null, verdict: x.verdict, attempt: i + 1, of: c.runs.length, played: beforeOutcome(c.detail), outcome, exitCode: Number.isInteger(x.exitCode) ? x.exitCode : null };
  }
  return null;
}

/**
 * The banner's line after its verdict word, in every attempt's grammar: what was done, which attempt
 * it was, and what the preset played in where, `tool timeout, attempt 1 of 1: list_inbox (#2) timed
 * out, played in by the preset`. Why one failed is the header's red line, so the banner doesn't say
 * it again; one that couldn't say says why at the banner's end, since the header has no line for it.
 */
export function presetWhy(p: PresetAttempt): string {
  const which = `${p.label}, attempt ${p.attempt} of ${p.of}`;
  return p.verdict === 'inconclusive' || !p.played ? which : `${which}: ${p.played}, played in by the preset`;
}

/** The status chip a preset's verdict gives its attempt: failed in red, inconclusive in amber; one that passed keeps its kind's. */
export function presetTag(p: PresetAttempt | null): { cls: string; text: string } | null {
  if (!p) return null;
  return p.verdict === 'failed' ? { cls: 'fail', text: 'failed' } : p.verdict === 'inconclusive' ? { cls: 'inc', text: 'inconclusive' } : null;
}

/**
 * How a fork that exited with an error says so in its meta line: an attempt its preset failed, as
 * the preset's result says why (`the agent exited with code 1 (TimeoutError: …)`), the line the
 * banner leaves to it; any other, its exit code when a preset kept it.
 */
export function exitWords(status: string, p: PresetAttempt | null): string | null {
  if (status !== 'failed') return null;
  if (p?.verdict === 'failed') return p.outcome;
  return p?.exitCode !== null && p?.exitCode !== undefined && p.exitCode !== 0 ? `exited ${p.exitCode}` : 'exited with an error';
}
