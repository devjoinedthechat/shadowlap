import { TRUST_FROM } from '../../../engine/src/trust-words.js';
import { tipCard } from '../components/HoverCard.js';
import type { InjectionRow, RunInjection, UntrustedView } from '../types.js';

/**
 * What a run's page draws of the injection tests it was in, from `/api/injection`: the untrusted
 * reads Calls and Turns tag, the finding a kept test of the run shows, and for an attempt, its test.
 * The server words every verdict, proof and count; this only picks and joins its words. No DOM here:
 * the tests import it.
 */

/** A kept test's finding on the run it tested: its verdict against its limits, its line, its golden for a gate. */
export interface InjectionFinding {
  resultId: string;
  gate: 'failed' | 'inconclusive' | 'passed';
  label: 'injection test' | 'injection gate';
  /** Failed, the gate's reason up to its limit; inconclusive, the reason whole; passed, the counts. */
  line: string;
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

/** `6 attempts: 0 obeyed · 0 influenced · 6 ignored`, ` · 3 inconclusive` after where any couldn't say. */
export function countsLine(r: Pick<InjectionRow, 'attempts' | 'obeyed' | 'influenced' | 'ignored' | 'inconclusive'>): string {
  const head = `${r.attempts.toLocaleString('en-US')} attempt${r.attempts === 1 ? '' : 's'}: ${r.obeyed} obeyed · ${r.influenced} influenced · ${r.ignored} ignored`;
  return r.inconclusive ? `${head} · ${r.inconclusive} inconclusive` : head;
}

/** The result a run's finding shows, and Share's Security report saves: its newest plant test that has ended. */
export const shownResult = (results: readonly InjectionRow[]): InjectionRow | null => results.find((r) => r.mode === 'plant' && !r.running && r.gate !== null) ?? null;

/** A kept test's finding, from its row: a failed gate's reason ends at its limit, as the proof is the panel's to show. */
export function injectionFinding(r: InjectionRow): InjectionFinding | null {
  if (!r.gate) return null;
  const line = r.gate === 'passed' ? countsLine(r) : r.gate === 'failed' ? (r.reason ?? r.line).replace(/\): [\s\S]*$/, ')') : (r.reason ?? r.line);
  return { resultId: r.resultId, gate: r.gate, label: r.golden ? 'injection gate' : 'injection test', line, golden: r.golden };
}

/** The page's view of its run's injection: the read of the run, and its results as runs move once they have come. */
export function runInjectionView(read: RunInjection | null, results: readonly InjectionRow[] | null): RunInjectionView {
  if (!read && !results) return NO_INJECTION;
  const row = shownResult(results ?? read?.results ?? []);
  return { untrusted: new Map((read?.untrusted ?? []).filter((u) => u.readAt !== null).map((u) => [u.callNo, u])), finding: row && injectionFinding(row), attempt: read?.attempt ?? null };
}

/** The untrusted tag's card: where the mark came from, and the model call that reads the read. */
export function untrustedTip(r: UntrustedView): string {
  return tipCard(`untrusted · ${TRUST_FROM[r.from]}`, [], `${r.from === 'sdk' ? 'Marked in the agent’s code. ' : ''}It brings outside text in: shadowlap injection plants its payloads here, and model call #${String(r.readAt)} reads it.`);
}
