/**
 * Injection tests: each `shadowlap injection` of a run keeps one row (injection_results), its
 * attempts counted by verdict and its report as --json prints it.
 */
import { parseJsonColumn, StorePart } from './core.js';

// ---- injection tests: the shape of injection_results ----

/** One `shadowlap injection` of a run, as kept for the dashboard: its counts by verdict, and the report it printed. */
export interface StoredInjectionResult {
  /** `inj-<ulid>`. */
  resultId: string;
  /** The run tested: a recording, a golden's, or a replay (an attempt that obeyed, under --clean). */
  runId: string;
  /** The golden it was, as the project names it (`goldens/refund-flow`), else null. */
  golden: string | null;
  /** The `shadowlap test` session whose injection gate ran it, else null. */
  sessionId: string | null;
  mode: 'plant' | 'clean';
  at: number;
  endedAt: number | null;
  /** Attempts that planted a payload (plant) or replaced the read (clean). */
  attempts: number;
  obeyed: number;
  influenced: number;
  ignored: number;
  inconclusive: number;
  /** plant: obeyed, influenced, ignored or inconclusive; clean: caused, not caused or inconclusive. */
  verdict: string | null;
  actor: string | null;
  /** The report as `shadowlap injection --json` prints it for this run. */
  data: Record<string, unknown>;
}

export abstract class Injection extends StorePart {
  // ---- injection tests: shadowlap injection's results ----

  /** Keeps a result, replacing the one under the same id (a test still running writes its row again as attempts end). */
  putInjectionResult(r: StoredInjectionResult): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO injection_results (result_id, run_id, golden, session_id, mode, at, ended_at, attempts, obeyed, influenced, ignored, inconclusive, verdict, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.resultId, r.runId, r.golden, r.sessionId, r.mode, r.at, r.endedAt, r.attempts, r.obeyed, r.influenced, r.ignored, r.inconclusive, r.verdict, r.actor, JSON.stringify(r.data));
  }

  getInjectionResult(resultId: string): StoredInjectionResult | null {
    const row = this.db.prepare(`SELECT * FROM injection_results WHERE result_id = ?`).get(resultId);
    return row ? rowToInjectionResult(row) : null;
  }

  /** Results, newest first: of one run tested, one golden, one test session, or all (`limit`, default 100). */
  listInjectionResults(options: { runId?: string; golden?: string; sessionId?: string; limit?: number } = {}): StoredInjectionResult[] {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['run_id', options.runId],
      ['golden', options.golden],
      ['session_id', options.sessionId],
    ] as const) {
      if (value === undefined) continue;
      where.push(`${column} = ?`);
      params.push(value);
    }
    params.push(Math.max(1, Math.min(10_000, options.limit ?? 100)));
    return this.db
      .prepare(`SELECT * FROM injection_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, result_id DESC LIMIT ?`)
      .all(...params)
      .map(rowToInjectionResult);
  }

  deleteInjectionResult(resultId: string): void {
    this.db.prepare(`DELETE FROM injection_results WHERE result_id = ?`).run(resultId);
  }
}

function rowToInjectionResult(row: Record<string, unknown>): StoredInjectionResult {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    resultId: String(row.result_id),
    runId: String(row.run_id),
    golden: str(row.golden),
    sessionId: str(row.session_id),
    mode: row.mode === 'clean' ? 'clean' : 'plant',
    at: Number(row.at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    attempts: Number(row.attempts),
    obeyed: Number(row.obeyed),
    influenced: Number(row.influenced),
    ignored: Number(row.ignored),
    inconclusive: Number(row.inconclusive),
    verdict: str(row.verdict),
    actor: str(row.actor),
    data: parseJsonColumn<Record<string, unknown>>(row.data, {}),
  };
}
