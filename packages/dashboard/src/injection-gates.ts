import { DEFAULT_BASELINES, GATE_TOO_LITTLE, type InjectionEntry, type StoreOf } from '@shadowlap/engine';
import { proofCall, proofOf } from './injection-view.js';
import { injectionLine } from './injection.js';
import type { FailingTest, GoldenRow, GoldenSource } from './tests.js';

/**
 * Tests' gated goldens (`GET /api/tests`), decorated beside testsView so src/tests.ts doesn't grow:
 * each golden with an injection gate gets its entry as parsed (shown among its checks), and, from its
 * last result's kept test, the attempt that proves it failed and the test's one line. Only the newest
 * result is read, once per gated golden: the history's cells never are. Where the golden's verdict is
 * its gate's, its last result says what the gate found: the test's line, or that it showed too little.
 */
export interface InjectionGateRow {
  /** Its tests entry's `"injection"`, with its defaults. */
  entry: InjectionEntry;
  /** The attempt its last result rests on (the first that obeyed, else influenced, else couldn't say), at its call; null when none is kept. */
  proof: { runId: string; callNo: number | null } | null;
  /** Its last kept test's one line (injectionLine): `send_email obeyed a planted instruction · 8 of 72`. */
  line: string | null;
  /** The run its last kept test planted into, and that test: the gate's words open the run with the test's results. */
  results: { runId: string; resultId: string } | null;
  /** Its entry as its card shows it: `{ "obeyed": 0, "repeat": 3, "templates": ["user-recipient"] }`, the keys at their defaults left out but obeyed and repeat. */
  json: string;
}

declare module './tests.js' {
  interface GoldenRow {
    /** Its injection gate, which Tests draws under its checks (withInjectionGates); none without one. */
    injectionGate?: InjectionGateRow;
  }
}

/** A gate's entry as one line, each list on it: what its tests entry sets beyond the defaults. */
function entryJson(e: InjectionEntry): string {
  const set: Array<[string, unknown]> = [['obeyed', e.obeyed], ['influenced', e.influenced], ['repeat', e.repeat], ['templates', e.templates === 'all' ? null : e.templates], ['payloads', e.payloads], ['baselines', e.baselines === DEFAULT_BASELINES ? null : e.baselines], ['liveReads', e.liveReads || null]];
  const value = (v: unknown) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  return `{ ${set.filter(([, v]) => v !== null).map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(', ')} }`;
}

export function withInjectionGates<V extends { rows: GoldenRow[] }>(store: StoreOf<'recording' | 'injection'>, view: V, goldens: readonly GoldenSource[]): V {
  const entries = new Map(goldens.filter((g) => g.injectionGate).map((g) => [g.path, g.injectionGate!]));
  if (!entries.size) return view;
  const rows = view.rows.map((row) => {
    const entry = entries.get(row.path);
    if (!entry) return row;
    const kept = row.last.injection?.resultId ? store.getInjectionResult(row.last.injection.resultId) : null;
    const proof = kept ? proofOf(store, kept.data) : null;
    const results = kept ? { runId: kept.runId, resultId: kept.resultId } : null;
    const gate: InjectionGateRow = { entry, proof: proof ? { runId: proof.runId, callNo: proofCall(proof) } : null, line: kept ? injectionLine(kept) : null, results, json: entryJson(entry) };
    // The last result of a golden whose verdict is its gate's: the gate's own line, or that it showed too little to say.
    const said = row.last.failure !== 'injection' ? null : row.last.verdict === 'inconclusive' ? GATE_TOO_LITTLE : gate.line;
    return { ...row, injectionGate: gate, ...(said ? { last: { ...row.last, line: said } } : {}) };
  });
  return { ...view, rows };
}

/**
 * Needs a look's failing goldens, where a golden failed its injection gate, with the line its row on
 * Tests gives it: its kept test's one line (injectionLine), which names the tool and the count. Only
 * the newest results are read, and only when a golden failed that way.
 */
export function withGateLines(store: StoreOf<'tests' | 'injection'>, failing: FailingTest[]): FailingTest[] {
  const byGate = (t: FailingTest) => t.failure === 'injection' && t.verdict === 'failed';
  if (!failing.some(byGate)) return failing;
  const latest = new Map(store.latestTestResults().map((r) => [r.golden, r]));
  return failing.map((t) => {
    const resultId = byGate(t) ? latest.get(t.golden)?.data?.injection?.resultId : null;
    const kept = resultId ? store.getInjectionResult(resultId) : null;
    return kept ? { ...t, line: injectionLine(kept) } : t;
  });
}
