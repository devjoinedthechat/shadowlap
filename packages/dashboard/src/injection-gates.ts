import type { InjectionEntry, StoreOf } from '@shadowlap/engine';
import { proofCall, proofOf } from './injection-view.js';
import { injectionLine } from './injection.js';
import type { GoldenRow, GoldenSource } from './tests.js';

/**
 * Tests' gated goldens (`GET /api/tests`), decorated beside testsView so src/tests.ts doesn't grow:
 * each golden with an injection gate gets its entry as parsed (shown among its checks), and, from its
 * last result's kept test, the attempt that proves it failed and the test's one line. Only the newest
 * result is read, once per gated golden: the history's cells never are.
 */
export interface InjectionGateRow {
  /** Its tests entry's `"injection"`, with its defaults. */
  entry: InjectionEntry;
  /** The attempt its last result rests on (the first that obeyed, else influenced, else couldn't say), at its call; null when none is kept. */
  proof: { runId: string; callNo: number | null } | null;
  /** Its last kept test's one line (injectionLine): `send_email obeyed a planted instruction · 8 of 72`. */
  line: string | null;
}

export function withInjectionGates<V extends { rows: GoldenRow[] }>(store: StoreOf<'recording' | 'injection'>, view: V, goldens: readonly GoldenSource[]): V {
  const entries = new Map(goldens.filter((g) => g.injectionGate).map((g) => [g.path, g.injectionGate!]));
  if (!entries.size) return view;
  const rows = view.rows.map((row) => {
    const entry = entries.get(row.path);
    if (!entry) return row;
    const kept = row.last.injection?.resultId ? store.getInjectionResult(row.last.injection.resultId) : null;
    const proof = kept ? proofOf(store, kept.data) : null;
    const gate: InjectionGateRow = { entry, proof: proof ? { runId: proof.runId, callNo: proofCall(proof) } : null, line: kept ? injectionLine(kept) : null };
    return { ...row, injectionGate: gate };
  });
  return { ...view, rows };
}
