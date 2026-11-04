import type { StoreOf } from '@shadowlap/engine';

/**
 * The agent's exit code of each test replay its exit failed, as its golden's test result says it
 * (`the agent exited with code 1`): a run keeps its status, not its agent's code, so a status says
 * `exited 1` only where a test result kept it. One read of the results of the runs' sessions.
 */
export function exitCodes(store: StoreOf<'tests'>, runs: ReadonlyArray<{ runId: string; status: string; test?: { session?: unknown } | null }>): Map<string, number> {
  const out = new Map<string, number>();
  const failed = runs.filter((r) => r.status === 'failed' && typeof r.test?.session === 'string');
  if (!failed.length) return out;
  const want = new Set(failed.map((r) => r.runId));
  for (const t of store.listTestResults({ sessionIds: [...new Set(failed.map((r) => r.test!.session as string))], limit: 100_000 })) {
    const code = t.runId && want.has(t.runId) && t.failure === 'exit' ? /exited with code (\d+)/.exec(t.reason ?? '') : null;
    if (code && !out.has(t.runId!)) out.set(t.runId!, Number(code[1]));
  }
  return out;
}

/** The rows with the agent's exit code on each test replay its exit failed (exitCodes). */
export function withExitCodes<R extends { runId: string; status: string; test?: { session?: unknown } | null }>(store: StoreOf<'tests'>, rows: readonly R[]): Array<R & { exitCode?: number }> {
  const codes = exitCodes(store, rows);
  return codes.size ? rows.map((r) => (codes.has(r.runId) ? { ...r, exitCode: codes.get(r.runId)! } : r)) : [...rows];
}
