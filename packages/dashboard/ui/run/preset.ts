import type { ChaosMatrix } from '../types.js';

/**
 * An error-path preset's attempt, as its run's page says it (`/api/chaos/runs/:id`, the recording's
 * presets): which preset it played in, on which golden, at which call, and how it came out by the
 * preset's verdict, which the run's own state can't say (an injected failure that the agent exits
 * with an error on is no failure of the run by itself: the preset decides). No DOM here.
 */
export interface PresetAttempt {
  /** The preset in words: `tool timeout`. */
  label: string;
  golden: string | null;
  /** The recording's call it hit, and what that call is (`list_inbox`, `POST /v1/messages`). */
  callNo: number | null;
  target: string | null;
  verdict: 'passed' | 'failed' | 'inconclusive';
  /** What the agent did: `the agent exited with code 1 (ShadowlapInjectedFailure …)`. */
  outcome: string;
  exitCode: number | null;
}

/** What follows the call in a preset's detail: `the agent exited 0` in `list_inbox (#2) answered with nothing: the agent exited 0`. */
const afterCall = (detail: string): string | null => {
  const at = detail.indexOf(': ');
  return at < 0 ? null : detail.slice(at + 2).trim() || null;
};

/** The preset this run is an attempt of, from its recording's presets; null for a run no preset made. */
export function presetAttempt(matrix: ChaosMatrix | null | undefined, runId: string): PresetAttempt | null {
  for (const c of matrix?.cells ?? []) {
    const x = c.runs.find((r) => r.runId === runId);
    if (!x) continue;
    const exited = `the agent exited ${x.exitCode === 0 ? '0' : `with code ${x.exitCode}`}`;
    // A preset decided by one attempt says it in its own words; one of several says this attempt's exit.
    const outcome = (c.runs.length === 1 ? afterCall(c.detail) : null) ?? exited;
    return { label: c.label, golden: matrix!.golden, callNo: c.callNo, target: c.target?.name ?? null, verdict: x.verdict, outcome, exitCode: Number.isInteger(x.exitCode) ? x.exitCode : null };
  }
  return null;
}

/** Each attempt a recording's presets made, by its run id: a family's tree marks those that failed or couldn't say. */
export function presetAttempts(matrix: ChaosMatrix | null | undefined): Map<string, PresetAttempt> {
  const out = new Map<string, PresetAttempt>();
  for (const c of matrix?.cells ?? []) for (const x of c.runs) out.set(x.runId, presetAttempt(matrix, x.runId)!);
  return out;
}

/**
 * The banner's line, its verdict first so a line cut short at the banner's end still says it: `tool
 * timeout preset · failed: the agent exited with code 1 · on goldens/inbox`.
 */
export function presetWhy(p: PresetAttempt): string {
  return `${p.label} preset · ${p.verdict}: ${p.outcome}${p.golden ? ` · on ${p.golden}` : ''}`;
}

/** The status chip a preset's verdict gives its attempt: failed in red, inconclusive in amber; one that passed keeps its kind's. */
export function presetTag(p: PresetAttempt | null): { cls: string; text: string } | null {
  if (!p) return null;
  return p.verdict === 'failed' ? { cls: 'fail', text: 'failed' } : p.verdict === 'inconclusive' ? { cls: 'inc', text: 'inconclusive' } : null;
}

/** How a fork that exited with an error says so in its meta line: its code when a preset kept it. */
export function exitWords(status: string, p: PresetAttempt | null): string | null {
  if (status !== 'failed') return null;
  return p?.exitCode !== null && p?.exitCode !== undefined && p.exitCode !== 0 ? `exited ${p.exitCode}` : 'exited with an error';
}
