/**
 * Decisions: each `shadowlap decisions` or `migrate` session, its report as --json prints it without
 * its runs (decision_sessions), and each run's part of it, a row of its own (decision_runs), so a
 * run's page reads its decisions without the rest of the session.
 */
import { StorePart } from './core.js';

// ---- Decisions: the shapes of the decision tables ----

/** A decisions or migrate session as the store lists it: what changed, over how many runs, and when. */
export interface DecisionSessionRow {
  sessionId: string;
  kind: 'decisions' | 'migrate';
  at: number;
  /** The change in words: `the model claude-haiku-4-5`. */
  change: string;
  runs: number;
  /** Runs with a rank 1 or 2 change. */
  flagged: number;
  actor: string | null;
  revision: string | null;
}

/** One run's part of a session: its rank and changed steps, and its report (a `DecisionRun`) whole. */
export interface DecisionRunRow {
  sessionId: string;
  runId: string;
  golden: string | null;
  rank: number | null;
  changed: number;
  at: number;
  data: Record<string, unknown>;
}

export interface NewDecisionSession extends Omit<DecisionSessionRow, 'runs' | 'flagged'> {
  /** The report without its runs. */
  data: Record<string, unknown>;
  runs: Array<Pick<DecisionRunRow, 'runId' | 'golden' | 'rank' | 'changed' | 'data'>>;
}

export abstract class Decisions extends StorePart {
  // ---- Decisions: decisions and migrate sessions, and each run's part of one ----

  /** Keeps a session and its runs, in one transaction; a session kept again under its id is replaced. */
  putDecisionSession(s: NewDecisionSession): void {
    const flagged = s.runs.filter((r) => r.rank !== null && r.rank <= 2).length;
    this.transaction(() => {
      this.db.prepare(`DELETE FROM decision_sessions WHERE session_id = ?`).run(s.sessionId);
      this.db
        .prepare(`INSERT INTO decision_sessions (session_id, kind, at, change, runs, flagged, actor, revision, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.sessionId, s.kind, s.at, s.change, s.runs.length, flagged, s.actor, s.revision, JSON.stringify(s.data));
      const insert = this.db.prepare(`INSERT OR REPLACE INTO decision_runs (session_id, run_id, position, golden, rank, changed, at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      s.runs.forEach((r, i) => insert.run(s.sessionId, r.runId, i, r.golden, r.rank, r.changed, s.at, JSON.stringify(r.data)));
    });
  }

  private decisionSessionRow(r: Record<string, unknown>): DecisionSessionRow {
    return {
      sessionId: String(r.session_id),
      kind: r.kind === 'migrate' ? 'migrate' : 'decisions',
      at: Number(r.at),
      change: String(r.change),
      runs: Number(r.runs),
      flagged: Number(r.flagged),
      actor: r.actor === null ? null : String(r.actor),
      revision: r.revision === null ? null : String(r.revision),
    };
  }

  private decisionRunRow(r: Record<string, unknown>): DecisionRunRow {
    return {
      sessionId: String(r.session_id),
      runId: String(r.run_id),
      golden: r.golden === null ? null : String(r.golden),
      rank: r.rank === null ? null : Number(r.rank),
      changed: Number(r.changed),
      at: Number(r.at),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
    };
  }

  /** A session with its report and its runs in the order it asked them, or null. */
  getDecisionSession(sessionId: string): (DecisionSessionRow & { data: Record<string, unknown>; runRows: DecisionRunRow[] }) | null {
    const row = this.db.prepare(`SELECT * FROM decision_sessions WHERE session_id = ?`).get(sessionId);
    if (!row) return null;
    const runRows = this.db.prepare(`SELECT * FROM decision_runs WHERE session_id = ? ORDER BY position`).all(sessionId).map((r) => this.decisionRunRow(r));
    return { ...this.decisionSessionRow(row), data: JSON.parse(String(row.data)) as Record<string, unknown>, runRows };
  }

  /** Sessions, newest first; `kind` keeps one kind. */
  listDecisionSessions(options: { limit?: number; kind?: 'decisions' | 'migrate' } = {}): DecisionSessionRow[] {
    const limit = Math.max(1, Math.min(10_000, options.limit ?? 50));
    const rows = options.kind
      ? this.db.prepare(`SELECT * FROM decision_sessions WHERE kind = ? ORDER BY at DESC, session_id DESC LIMIT ?`).all(options.kind, limit)
      : this.db.prepare(`SELECT * FROM decision_sessions ORDER BY at DESC, session_id DESC LIMIT ?`).all(limit);
    return rows.map((r) => this.decisionSessionRow(r));
  }

  /** A run's part of each session that asked its model calls again, newest first, with the session's kind and change. */
  decisionsOfRun(runId: string, limit = 20): Array<DecisionRunRow & Pick<DecisionSessionRow, 'kind' | 'change'>> {
    return this.db
      .prepare(`SELECT r.*, s.kind AS kind, s.change AS change FROM decision_runs r JOIN decision_sessions s ON s.session_id = r.session_id WHERE r.run_id = ? ORDER BY r.at DESC, r.session_id DESC LIMIT ?`)
      .all(runId, Math.max(1, Math.min(1000, limit)))
      .map((r) => ({ ...this.decisionRunRow(r), kind: r.kind === 'migrate' ? ('migrate' as const) : ('decisions' as const), change: String(r.change) }));
  }

  /**
   * The judge verdicts every session that asked a run again kept for it, newest first: each side of a
   * step's judge check that got one (`recorded` or `now`), by the digest of the request it answered.
   * The decision diff answers the very same request again from it, for free. Only those values are
   * read out of each session's part of the run, however many sessions there are.
   */
  decisionJudgeVerdicts(runId: string): Array<{ request: string; verdict: 'yes' | 'no'; reason: string }> {
    return this.db
      .prepare(
        `SELECT json_extract(side.value, '$.request') AS request, json_extract(side.value, '$.verdict') AS verdict, json_extract(side.value, '$.reason') AS reason
         FROM decision_runs r,
           json_each(r.data, '$.decisions') step,
           json_each(CASE step.type WHEN 'object' THEN step.value END, '$.judge') j,
           json_each(CASE j.type WHEN 'object' THEN j.value END) side
         WHERE r.run_id = ? AND side.key IN ('recorded', 'now') AND side.type = 'object'
           AND json_extract(side.value, '$.verdict') IN ('yes', 'no') AND json_type(side.value, '$.request') = 'text'
         ORDER BY r.at DESC, r.session_id DESC`,
      )
      .all(runId)
      .map((r) => ({ request: String(r.request), verdict: r.verdict === 'yes' ? ('yes' as const) : ('no' as const), reason: typeof r.reason === 'string' ? r.reason : '' }));
  }

  deleteDecisionSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM decision_sessions WHERE session_id = ?`).run(sessionId);
  }
}
