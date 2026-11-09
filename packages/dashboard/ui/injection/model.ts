import { INJECTION_CHECK, injectionCountsLine } from '../../../engine/src/trust-words.js';
import { goldenName, num } from '../format.js';
import type { CheckView, InjectionMark, InjectionRow, RunDetail, RunInjection, UntrustedView } from '../types.js';

/**
 * What a run's page draws of the injection tests it was in, from `/api/injection`: the untrusted
 * reads Calls and Turns tag, the finding a kept test of the run shows, and for an attempt, its test.
 * The server words every verdict, proof and count; this only picks and joins its words. No DOM here,
 * nor anything that draws (the tag's card is UntrustedTag.tsx's): the Node tests import it.
 */

/** A kept test's finding on the run it tested: its verdict against its limits, its line, its golden for a gate. */
export interface InjectionFinding {
  resultId: string;
  gate: 'failed' | 'inconclusive' | 'passed';
  label: 'injection test' | 'injection gate';
  /** Failed, the gate's reason up to its limit; inconclusive, the reason whole; passed, the counts. */
  line: string;
  /** A gate's golden by its name, its folder left off (`refund-over-limit`, kept as `goldens/refund-over-limit`). */
  golden: string | null;
}

/** What the page has of the run's injection tests, with nothing to draw until the read comes. */
export interface RunInjectionView {
  /** The reads a model call reads, by their call: a read no model call follows brought no text in. */
  untrusted: ReadonlyMap<number, UntrustedView>;
  finding: InjectionFinding | null;
  attempt: RunInjection['attempt'];
}

export const NO_INJECTION: RunInjectionView = { untrusted: new Map(), finding: null, attempt: null };

/** The result a run's finding shows, and Share's Security report saves: its newest plant test that has ended. */
export const shownResult = (results: readonly InjectionRow[]): InjectionRow | null => results.find((r) => r.mode === 'plant' && !r.running && r.gate !== null) ?? null;

/** A kept test's finding, from its row: a failed gate's reason ends at its limit, as the proof is the panel's to show. */
export function injectionFinding(r: InjectionRow): InjectionFinding | null {
  if (!r.gate) return null;
  const line = r.gate === 'passed' ? injectionCountsLine(r, { num }) : r.gate === 'failed' ? (r.reason ?? r.line).replace(/\): [\s\S]*$/, ')') : (r.reason ?? r.line);
  return { resultId: r.resultId, gate: r.gate, label: r.golden ? 'injection gate' : 'injection test', line, golden: r.golden && goldenName(r.golden) };
}

/** The page's view of its run's injection: the read of the run, and its results as runs move once they have come. */
export function runInjectionView(read: RunInjection | null, results: readonly InjectionRow[] | null): RunInjectionView {
  if (!read && !results) return NO_INJECTION;
  const row = shownResult(results ?? read?.results ?? []);
  return { untrusted: new Map((read?.untrusted ?? []).filter((u) => u.readAt !== null).map((u) => [u.callNo, u])), finding: row && injectionFinding(row), attempt: read?.attempt ?? null };
}

/** What an injection test's replay's first fact says (run/metrics.ts): its own record's role and verdict, and what the read adds. */
export interface InjectionFact {
  role: InjectionMark['role'];
  verdict: InjectionMark['verdict'] | null;
  /** The call that carried the canary, for an attempt that obeyed. */
  callNo: number | null;
  /** Why it came out so: the mark's own why, else its check's detail. */
  why: string | null;
  /** A clean attempt's recorded writes it did not make again, and a baseline's own writes after the read: null until the read comes, and in a copy. */
  gone: number[] | null;
  writes: number | null;
}

/** An injection test's replay's first fact, from its record, its checks and the read of what was planted where; null for any other run. */
export function injectionFactOf(run: Pick<RunDetail, 'run'>, checks: readonly CheckView[], attempt: RunInjection['attempt']): InjectionFact | null {
  const m = run.run.meta?.injection;
  if (!m) return null;
  const check = checks.find((c) => c.label === INJECTION_CHECK);
  return { role: m.role, verdict: m.verdict ?? null, callNo: m.evidence?.[0]?.callNo ?? null, why: m.why ?? check?.detail ?? null, gone: attempt?.gone ?? null, writes: attempt?.writes ?? null };
}
