/**
 * Error-path presets: each `shadowlap test --chaos` or `replay --chaos` session (chaos_sessions), how
 * each preset came out on each recording it forked (chaos_results), and the process running a
 * session not ended yet (chaos_session_owners).
 */
import { currentOwner, type RunOwner } from '../liveness.js';
import { parseJsonColumn, StorePart, ulidNow } from './core.js';

// ---- error-path presets (v4): the shapes of the chaos tables ----

/** One `shadowlap test --chaos` (or `replay --chaos`) session. */
export interface ChaosSession {
  sessionId: string;
  startedAt: number;
  /** Null while it runs, or when its process was killed before it could end it. */
  endedAt: number | null;
  /** The command as given, without global options. */
  command: string[];
  revision: string | null;
  actor: string | null;
  /** The presets it was asked to run, in order. */
  presets: string[];
  /** Set when it ends: the results by verdict (not-applicable ones aren't counted). */
  passed: number;
  failed: number;
  inconclusive: number;
  upstreamRequests: number;
  interrupted: boolean;
}

export type ChaosVerdict = 'passed' | 'failed' | 'inconclusive' | 'not-applicable';

/** How one preset came out on one recording. */
export interface ChaosResult {
  sessionId: string;
  /** The recording it forked: a golden's run, or the run `replay --chaos` was given. */
  runId: string;
  /** The golden, for `test --chaos`; null for a run. */
  golden: string | null;
  preset: string;
  at: number;
  verdict: ChaosVerdict;
  /** The call the preset hit, or null when it found none to hit. */
  callNo: number | null;
  passes: number;
  attempts: number;
  data: ChaosResultData | null;
}

/** What a result keeps besides its verdict. Every field is optional to readers. */
export interface ChaosResultData {
  /** The call it hit: its kind (`tool` or `api`) and name. */
  target?: { kind: string; name: string } | null;
  /** One sentence: what came out, naming the values involved. */
  detail?: string;
  /** For a failure, the first failing attempt's reason; for one inconclusive for a reason of its own (not a gate that ran out), why. */
  reason?: string | null;
  /**
   * Each attempt: its run, its verdict, whether it passed, the agent's exit code, its checks, why it
   * failed or is inconclusive, and the error the agent died of. An attempt is inconclusive when it
   * says nothing of the error path: its replay never reached the call, or all that kept it from
   * passing is a check no attempt can decide. A result kept before attempts had a verdict has none.
   */
  runs?: Array<{ runId: string; verdict?: Exclude<ChaosVerdict, 'not-applicable'>; passed: boolean; exitCode: number; checks?: Array<{ ok: boolean; label: string; detail: string | null }>; reason?: string | null; lastLine?: string }>;
  /** The gate the attempts were decided by, as configured. */
  gate?: Record<string, unknown> | null;
  revision?: string | null;
  upstreamRequests?: number;
  spent?: number;
}

export type NewChaosSession = Partial<Pick<ChaosSession, 'sessionId' | 'startedAt' | 'revision' | 'actor'>> &
  Pick<ChaosSession, 'command' | 'presets'> & {
    /** The process running it, until it ends: this one unless given; null names none (a session recorded elsewhere). */
    owner?: RunOwner | null;
  };

export type NewChaosResult = Partial<Pick<ChaosResult, 'at' | 'golden' | 'callNo' | 'passes' | 'attempts' | 'data'>> & Pick<ChaosResult, 'sessionId' | 'runId' | 'preset' | 'verdict'>;

export abstract class Chaos extends StorePart {
  // ---- error-path presets (v4): test --chaos sessions and each preset's result ----

  /** Starts a session; finishChaosSession fills in its totals. */
  startChaosSession(input: NewChaosSession): ChaosSession {
    const session: ChaosSession = {
      sessionId: input.sessionId ?? ulidNow(),
      startedAt: input.startedAt ?? Date.now(),
      endedAt: null,
      command: input.command,
      revision: input.revision ?? null,
      actor: input.actor ?? null,
      presets: input.presets,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      upstreamRequests: 0,
      interrupted: false,
    };
    this.db
      .prepare(`INSERT INTO chaos_sessions (session_id, started_at, ended_at, command, revision, actor, presets) VALUES (?, ?, NULL, ?, ?, ?, ?)`)
      .run(session.sessionId, session.startedAt, JSON.stringify(session.command), session.revision, session.actor, JSON.stringify(session.presets));
    // Who runs it, until it ends (chaosSessionOwner).
    const owner = input.owner === undefined ? currentOwner() : input.owner;
    if (owner) this.db.prepare(`INSERT OR REPLACE INTO chaos_session_owners (session_id, pid, host) VALUES (?, ?, ?)`).run(session.sessionId, owner.pid, owner.host);
    return session;
  }

  /** Records a session's totals once its presets have run, or once a signal stopped it (`interrupted`). */
  finishChaosSession(sessionId: string, totals: { passed: number; failed: number; inconclusive: number; upstreamRequests: number; endedAt?: number; interrupted?: boolean }): void {
    this.db
      .prepare(`UPDATE chaos_sessions SET ended_at = ?, passed = ?, failed = ?, inconclusive = ?, upstream_requests = ?, interrupted = ? WHERE session_id = ?`)
      .run(totals.endedAt ?? Date.now(), totals.passed, totals.failed, totals.inconclusive, totals.upstreamRequests, totals.interrupted ? 1 : 0, sessionId);
    this.db.prepare(`DELETE FROM chaos_session_owners WHERE session_id = ?`).run(sessionId);
  }

  /**
   * The process running a session of presets that hasn't ended, for `recorderGone` to ask; null once
   * it ended, and for a session no process here was named for (one a v4 store kept, or one recorded
   * elsewhere).
   */
  chaosSessionOwner(sessionId: string): RunOwner | null {
    const row = this.db.prepare(`SELECT pid, host FROM chaos_session_owners WHERE session_id = ?`).get(sessionId);
    return row ? { pid: Number(row.pid), host: String(row.host) } : null;
  }

  getChaosSession(sessionId: string): ChaosSession | null {
    const row = this.db.prepare(`SELECT * FROM chaos_sessions WHERE session_id = ?`).get(sessionId);
    return row ? rowToChaosSession(row) : null;
  }

  /** Sessions, newest first. */
  listChaosSessions(options: { limit?: number } = {}): ChaosSession[] {
    return this.db
      .prepare(`SELECT * FROM chaos_sessions ORDER BY started_at DESC, session_id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(10_000, options.limit ?? 100)))
      .map(rowToChaosSession);
  }

  /** Records how one preset came out on one golden's recording (or one run); a second result for the same one in the same session replaces the first. */
  addChaosResult(input: NewChaosResult): ChaosResult {
    const result: ChaosResult = {
      sessionId: input.sessionId,
      runId: input.runId,
      golden: input.golden ?? null,
      preset: input.preset,
      at: input.at ?? Date.now(),
      verdict: input.verdict,
      callNo: input.callNo ?? null,
      passes: input.passes ?? 0,
      attempts: input.attempts ?? 0,
      data: input.data ?? null,
    };
    this.db
      .prepare(`INSERT OR REPLACE INTO chaos_results (session_id, run_id, golden, preset, at, verdict, call_no, passes, attempts, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(result.sessionId, result.runId, result.golden, result.preset, result.at, result.verdict, result.callNo, result.passes, result.attempts, result.data === null ? null : JSON.stringify(result.data));
    return result;
  }

  /** Results, newest first: of one session, one recording, or one golden (`limit`, default 1000). */
  listChaosResults(options: { sessionId?: string; runId?: string; golden?: string; limit?: number } = {}): ChaosResult[] {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [['session_id', options.sessionId], ['run_id', options.runId], ['golden', options.golden]] as const) {
      if (value === undefined) continue;
      where.push(`${column} = ?`);
      params.push(value);
    }
    params.push(Math.max(1, Math.min(100_000, options.limit ?? 1000)));
    return this.db
      .prepare(`SELECT * FROM chaos_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, session_id DESC, preset ASC LIMIT ?`)
      .all(...params)
      .map(rowToChaosResult);
  }

  /** The newest result of each preset on each golden's recording (and each run presets ran on alone): one row per golden, recording and preset, newest first. */
  latestChaosResults(): ChaosResult[] {
    return this.db
      .prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY coalesce(golden, ''), run_id, preset ORDER BY at DESC, session_id DESC) AS n FROM chaos_results) WHERE n = 1 ORDER BY at DESC, run_id ASC, preset ASC`)
      .all()
      .map(rowToChaosResult);
  }
}

// ---- error-path presets (v4): rows to records ----

function rowToChaosSession(row: Record<string, unknown>): ChaosSession {
  const command = parseJsonColumn<unknown>(row.command, []);
  const presets = parseJsonColumn<unknown>(row.presets, []);
  return {
    sessionId: String(row.session_id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    command: Array.isArray(command) ? command.map(String) : [],
    revision: row.revision === null || row.revision === undefined ? null : String(row.revision),
    actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
    presets: Array.isArray(presets) ? presets.map(String) : [],
    passed: Number(row.passed),
    failed: Number(row.failed),
    inconclusive: Number(row.inconclusive),
    upstreamRequests: Number(row.upstream_requests),
    interrupted: Number(row.interrupted ?? 0) === 1,
  };
}

function rowToChaosResult(row: Record<string, unknown>): ChaosResult {
  return {
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    golden: row.golden === null || row.golden === undefined ? null : String(row.golden),
    preset: String(row.preset),
    at: Number(row.at),
    verdict: String(row.verdict) as ChaosVerdict,
    callNo: row.call_no === null || row.call_no === undefined ? null : Number(row.call_no),
    passes: Number(row.passes),
    attempts: Number(row.attempts),
    data: parseJsonColumn<ChaosResultData | null>(row.data, null),
  };
}
