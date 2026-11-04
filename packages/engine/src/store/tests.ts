/**
 * Tests: each `shadowlap test` session and how each golden did in it (test_sessions, test_results),
 * so a golden's history across revisions outlives the runs gc deletes, with the pull request a CI
 * session ran for and what the comment on it carried; the process running a session not ended yet
 * (test_session_owners); and the runs and revisions a test or a bisect reads.
 */
import { isObject } from '../is-object.js';
import { currentOwner, type RunOwner } from '../liveness.js';
import type { GateResult } from '../stats.js';
import type { JudgeSummary, Normalizer, RunRecord, StoredCheck } from '../types.js';
import { parseJsonColumn, StorePart, ulidNow } from './core.js';
import { rowToRun } from './recording.js';

// ---- tests (v4): the shapes of the test tables ----

/** One `shadowlap test` session: what ran, at which revision, and how it came out. */
export interface TestSession {
  sessionId: string;
  startedAt: number;
  /** Null while the session runs, or when its process was killed before it could end it. */
  endedAt: number | null;
  /** The command as given, without global options: `['shadowlap', 'test', 'goldens/*']`. */
  command: string[];
  /** The code version it tested (`codeVersion`): a short sha, with `+dirty` for uncommitted changes. */
  revision: string | null;
  /**
   * Set when it ends: the goldens that finished, by how they came out. An inconclusive one is
   * neither (its result's `data.verdict` says so); sessions before verdicts counted it by CI's call.
   */
  passed: number;
  failed: number;
  /** Requests that reached a provider: 0 for goldens that replay offline. */
  upstreamRequests: number;
  /** Who ran it (resolveAuthor). */
  actor: string | null;
  /** A signal stopped it (Ctrl-C, a job stopped): the golden it was replaying has no result, and the ones after it didn't run. */
  interrupted: boolean;
  /** v6: the pull or merge request it ran for (a CI session's); null for one that ran for none, or didn't say. */
  pullRequest: TestSessionPullRequest | null;
  /** v6: what the comment the Action keeps on that pull request carried beside the verdicts, as far as it was kept; null when none was. */
  comment: TestSessionComment | null;
}

export type NewTestSession = Partial<Pick<TestSession, 'sessionId' | 'startedAt' | 'revision' | 'actor' | 'pullRequest'>> &
  Pick<TestSession, 'command'> & {
    /** The process running it, until it ends: this one unless given; null names none (a session recorded elsewhere). */
    owner?: RunOwner | null;
  };

/** The pull or merge request a CI test session ran for, as CI named it (the remote package's pullRequestJob). */
export interface TestSessionPullRequest {
  /** Its number; null when CI ran the job for one but gave no number. */
  number: number | null;
  /** Its page (an http or https address), where CI says where it is; null otherwise. */
  url: string | null;
  /** How the job was known to run for one, in words: `GitHub Actions (pull_request)`, `SHADOWLAP_PR`. */
  source: string;
}

/**
 * What the pull request comment carried beside each golden's verdict line and injection gate, kept
 * with its session, so an older revision's page shows it as the comment did. The verdicts and the
 * gates are the session's results (each golden's `data.injection`), so they are never kept twice.
 * The job that ran the session keeps some parts and a job after it others (setTestSessionComment);
 * a part not kept reads as none.
 */
export interface TestSessionComment {
  /** The decisions session (`dc-…`) the branch's write and stop changes came from (`decisions --from-code`); null when the job asked none. */
  decisions: string | null;
  /** What a run costs, in USD: on the base branch, and in this session; null where it can't be told. */
  costPerRun: { before: number | null; after: number | null } | null;
}

/**
 * Why a golden failed: its replay sent a request the recording doesn't have, a check failed, the
 * agent exited non-zero, it made no calls, it couldn't run at all, or (`injection`) its injection
 * gate saw more attempts obey a planted instruction than it allows; or why it didn't pass:
 * `inconclusive`, its gate ran out of attempts between its bounds, or a check couldn't be decided (a
 * judge check with no verdict, and no way to ask the judge). `guard`: under `--guard block`, the
 * replay made calls with no Shadowlap preload loaded in the agent's processes, so the network guard
 * never watched it.
 */
export type TestFailure = 'diverged' | 'check' | 'exit' | 'no-calls' | 'error' | 'inconclusive' | 'injection' | 'guard';

/** What a result keeps besides its verdict, for the Tests screen. Every field is optional to readers. */
export interface TestResultData {
  /** `replay` must send the requests it recorded; `fork` may diverge and passes on its checks. */
  mode?: 'replay' | 'fork';
  calls?: { total: number; replayed: number; live: number; blocked: number; stubbed: number };
  upstreamRequests?: number;
  tokensNotRespent?: number;
  /** Input tokens of the run's model requests, cache reads included: what it costs to run live. */
  inputTokens?: number;
  /** Each check of the attempt shown, a judge check's with its verdict, reason and where the verdict came from. */
  checks?: StoredCheck[];
  /** What its judge checks' calls did and cost over every attempt, apart from the agent's (`calls`, `upstreamRequests`). */
  judge?: JudgeSummary;
  /**
   * Attempts run, passed and needed, and each attempt's run: kept for every result since gates
   * pool them, one attempt included (a result kept before has it only for a recording that
   * repeats). `inconclusive`: attempts a check couldn't judge, which count neither way.
   * `unavailable`: attempts the provider was unavailable for, retried and never counted (`total` leaves them out).
   * `cutShort`: attempts the provider cut short after the model had answered, which a gate counted
   * against either verdict (`total` has them, `passed` none of them).
   */
  attempts?: { total: number; passed: number; required: number | null; runs: string[]; inconclusive?: number; unavailable?: number; cutShort?: number };
  /** How the golden came out: passed, failed, or inconclusive (its gate ran out between its bounds, or a check couldn't be decided). Absent before results said. */
  verdict?: 'passed' | 'failed' | 'inconclusive';
  /** A golden with a gate: its decision, interval, pass^k, evidence path and sentence (stats.ts), as the reports show it. */
  gate?: GateResult;
  /** USD its attempts spent on live calls, so a dashboard can say what more attempts would cost. */
  spent?: number;
  /**
   * `test --continue` carried an inconclusive gate's attempts over: the sessions they came from,
   * oldest first, and how many. `gate` counts them; `attempts` is this session's own, so a baseline
   * pools each attempt once.
   */
  continued?: { sessions: string[]; attempts: number };
  /**
   * Where the replay diverged; `text` is the report as the CLI prints it. `diff` keeps the first
   * changes, cut short; `entries` is how many there were, and `volatile` what volatileValues() made
   * of all of them, so a reader never judges from the cut-down diff.
   */
  divergence?: {
    type: string;
    callNo: number;
    kind: string;
    name: string;
    replayedBefore: number;
    diff?: Array<{ path: string; op: string; before?: unknown; after?: unknown }>;
    entries?: number;
    hints?: Array<{ message: string; normalizer?: Normalizer }>;
    volatile?: { values: Array<{ path: string; looks: string; op: 'changed' | 'added'; certain?: boolean; normalizer: Normalizer }>; explainsAll: boolean; coversAll?: boolean };
    /** The first change the normalizers in force did not mask: what made it diverge (the report lists the masked ones too). */
    cause?: string | null;
    text: string;
  };
  /** The failure as the CLI printed it under the golden's line. */
  details?: string;
  /** For a failure: the last lines the agent printed, as `test --markdown` shows them (at most 20, cut short). */
  output?: string;
  /** `test --update` re-recorded the golden: the run it replaced, the new one, its calls, and what the agent sends differently. */
  updated?: { from: string | null; to: string; calls: number; changes?: string[] };
  /**
   * The golden's injection gate (`"injection"` under its tests entry): the result kept for it, the
   * attempts by verdict, what the gate allows, and whether it passed; `skipped` says why it planted
   * nothing, when it didn't.
   */
  injection?: InjectionGateData;

  // ---- where the session ran (gate-history.ts reads these: only a result that passed on the
  // baseline branch, outside any pull request, on a committed revision, is part of a baseline) ----
  /** The branch the session tested, from CI's variables or git; null when none could be told. */
  branch?: string | null;
  /** The revision it tested, as `revision` says it: a short sha, `+dirty` with uncommitted changes. */
  revision?: string | null;
  /** The session ran for a pull or merge request. */
  pullRequest?: boolean;
  /** The branch baselines came from as the session saw it (`tests.baselineBranch`, CI's default branch, origin/HEAD); null when unknown. */
  baselineBranch?: string | null;
}

/**
 * An injection gate's outcome, as the test history and the JSON report keep it: `verdict` passed,
 * failed (more attempts obeyed, or were influenced, than allowed) or inconclusive (the test showed
 * too little to say: nothing to plant in, an attempt that failed, none a model read, a run cut
 * short), with `reason`; null with `skipped` when the gate did not run (the golden failed, or is
 * inconclusive, first).
 */
export interface InjectionGateData {
  resultId: string | null;
  attempts: number;
  obeyed: number;
  influenced: number;
  ignored: number;
  inconclusive: number;
  allowed: { obeyed: number; influenced: number | null };
  verdict: 'passed' | 'failed' | 'inconclusive' | null;
  /** One line: why it failed or is inconclusive. */
  reason: string | null;
  /** Why it did not run (the golden failed, or is inconclusive), else null. */
  skipped: string | null;
}

/** How one golden did in one session. */
export interface TestResult {
  sessionId: string;
  golden: string;
  at: number;
  revision: string | null;
  ok: boolean;
  failure: TestFailure | null;
  /** One line: why it failed. */
  reason: string | null;
  /** The replay to open: the passing one, or the one that failed. */
  runId: string | null;
  /** The recording that was replayed. */
  goldenRunId: string | null;
  data: TestResultData | null;
}

export type NewTestResult = Partial<Pick<TestResult, 'at' | 'revision' | 'failure' | 'reason' | 'runId' | 'goldenRunId' | 'data'>> & Pick<TestResult, 'sessionId' | 'golden' | 'ok'>;

export abstract class Tests extends StorePart {
  // ---- tests (v4): shadowlap test sessions and each golden's result ----

  /** Starts a test session; finishTestSession fills in its totals. */
  startTestSession(input: NewTestSession): TestSession {
    const session: TestSession = {
      sessionId: input.sessionId ?? ulidNow(),
      startedAt: input.startedAt ?? Date.now(),
      endedAt: null,
      command: input.command,
      revision: input.revision ?? null,
      passed: 0,
      failed: 0,
      upstreamRequests: 0,
      actor: input.actor ?? null,
      interrupted: false,
      // As it reads back: a number or a page that is none is kept as none.
      pullRequest: pullRequestOf(input.pullRequest ?? null),
      comment: null,
    };
    this.db
      .prepare(`INSERT INTO test_sessions (session_id, started_at, ended_at, command, revision, passed, failed, upstream_requests, actor, interrupted, pull_request) VALUES (?, ?, NULL, ?, ?, 0, 0, 0, ?, 0, ?)`)
      .run(session.sessionId, session.startedAt, JSON.stringify(session.command), session.revision, session.actor, session.pullRequest === null ? null : JSON.stringify(session.pullRequest));
    // Who runs it, until it ends (testSessionOwner).
    const owner = input.owner === undefined ? currentOwner() : input.owner;
    if (owner) this.db.prepare(`INSERT OR REPLACE INTO test_session_owners (session_id, pid, host) VALUES (?, ?, ?)`).run(session.sessionId, owner.pid, owner.host);
    return session;
  }

  /** Records a session's totals once its goldens have run, or once a signal stopped it (`interrupted`). */
  finishTestSession(sessionId: string, totals: { passed: number; failed: number; upstreamRequests: number; endedAt?: number; interrupted?: boolean }): void {
    this.db
      .prepare(`UPDATE test_sessions SET ended_at = ?, passed = ?, failed = ?, upstream_requests = ?, interrupted = ? WHERE session_id = ?`)
      .run(totals.endedAt ?? Date.now(), totals.passed, totals.failed, totals.upstreamRequests, totals.interrupted ? 1 : 0, sessionId);
    this.db.prepare(`DELETE FROM test_session_owners WHERE session_id = ?`).run(sessionId);
  }

  /**
   * The process running a session that hasn't ended, for `recorderGone` to ask; null once it ended,
   * and for a session no process here was named for (one from before owners were kept).
   */
  testSessionOwner(sessionId: string): RunOwner | null {
    const row = this.db.prepare(`SELECT pid, host FROM test_session_owners WHERE session_id = ?`).get(sessionId);
    return row ? { pid: Number(row.pid), host: String(row.host) } : null;
  }

  getTestSession(sessionId: string): TestSession | null {
    const row = this.db.prepare(`SELECT * FROM test_sessions WHERE session_id = ?`).get(sessionId);
    return row ? rowToTestSession(row) : null;
  }

  /** Names the pull request a session ran for, as it reads back, in place of the one it named, or none (null). An unknown session throws. */
  setTestSessionPullRequest(sessionId: string, pullRequest: TestSessionPullRequest | null): void {
    const kept = pullRequestOf(pullRequest);
    const done = this.db.prepare(`UPDATE test_sessions SET pull_request = ? WHERE session_id = ?`).run(kept === null ? null : JSON.stringify(kept), sessionId);
    if (Number(done.changes) === 0) throw new Error(`unknown test session ${sessionId}`);
  }

  /**
   * Keeps parts of what a session's pull request comment carried, beside the parts kept already: each
   * part given takes its own place, null clearing it, in one statement, so a job that keeps one part
   * never writes back another a job beside it kept meanwhile. An unknown session throws.
   */
  setTestSessionComment(sessionId: string, parts: Partial<TestSessionComment>): void {
    // A JSON merge patch keeps the parts not given; null takes one out, which reads as none. What
    // was kept and doesn't read as JSON is none, so it never stops a part being kept.
    const done = this.db.prepare(`UPDATE test_sessions SET comment = json_patch(CASE WHEN json_valid(comment) THEN comment ELSE '{}' END, ?) WHERE session_id = ?`).run(JSON.stringify(parts), sessionId);
    if (Number(done.changes) === 0) throw new Error(`unknown test session ${sessionId}`);
  }

  /**
   * Sessions, newest first; `before` pages back (exclusive), `finished` leaves out sessions that
   * haven't ended, and `withResults` the ones with no golden's result yet (one that just started, or
   * was stopped during its first golden).
   */
  listTestSessions(options: { limit?: number; before?: number; finished?: boolean; withResults?: boolean } = {}): TestSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.before !== undefined) {
      where.push('started_at < ?');
      params.push(options.before);
    }
    if (options.finished) where.push('ended_at IS NOT NULL');
    if (options.withResults) where.push('EXISTS (SELECT 1 FROM test_results r WHERE r.session_id = test_sessions.session_id)');
    params.push(Math.max(1, Math.min(10_000, options.limit ?? 100)));
    return this.db
      .prepare(`SELECT * FROM test_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, session_id DESC LIMIT ?`)
      .all(...params)
      .map(rowToTestSession);
  }

  /** Records how one golden did in a session; a second result for the same golden in the same session replaces the first. */
  addTestResult(input: NewTestResult): TestResult {
    const result: TestResult = {
      sessionId: input.sessionId,
      golden: input.golden,
      at: input.at ?? Date.now(),
      revision: input.revision ?? null,
      ok: input.ok,
      failure: input.ok ? null : (input.failure ?? 'error'),
      reason: input.reason ?? null,
      runId: input.runId ?? null,
      goldenRunId: input.goldenRunId ?? null,
      data: input.data ?? null,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO test_results (session_id, golden, at, revision, ok, failure, reason, run_id, golden_run_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(result.sessionId, result.golden, result.at, result.revision, result.ok ? 1 : 0, result.failure, result.reason, result.runId, result.goldenRunId, result.data === null ? null : JSON.stringify(result.data));
    return result;
  }

  /** Results, newest first: of one session or several, of one golden, or of every session (`limit`, default 1000). */
  listTestResults(options: { sessionId?: string; sessionIds?: readonly string[]; golden?: string; since?: number; limit?: number } = {}): TestResult[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.sessionIds !== undefined) {
      if (!options.sessionIds.length) return [];
      where.push(`session_id IN (${options.sessionIds.map(() => '?').join(', ')})`);
      params.push(...options.sessionIds);
    }
    if (options.golden !== undefined) {
      where.push('golden = ?');
      params.push(options.golden);
    }
    if (options.since !== undefined) {
      where.push('at >= ?');
      params.push(options.since);
    }
    params.push(Math.max(1, Math.min(100_000, options.limit ?? 1000)));
    return this.db
      .prepare(`SELECT * FROM test_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, session_id DESC, golden ASC LIMIT ?`)
      .all(...params)
      .map(rowToTestResult);
  }

  /** The newest result of each golden, at or before `until` when given: one row per golden, newest first. */
  latestTestResults(options: { until?: number } = {}): TestResult[] {
    const where = options.until !== undefined ? 'WHERE at <= ?' : '';
    return this.db
      .prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY golden ORDER BY at DESC, session_id DESC) AS n FROM test_results ${where}) WHERE n = 1 ORDER BY at DESC, golden ASC`)
      .all(...(options.until !== undefined ? [options.until] : []))
      .map(rowToTestResult);
  }

  /** When each golden was first tested: the time of its oldest result, by golden. */
  firstTestResultAt(): Map<string, number> {
    const rows = this.db.prepare(`SELECT golden, MIN(at) AS first FROM test_results GROUP BY golden`).all();
    return new Map(rows.map((r) => [String(r.golden), Number(r.first)]));
  }

  /** The goldens each of these sessions has a result for, by session, without reading the results themselves. */
  testSessionGoldens(sessionIds: readonly string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (!sessionIds.length) return out;
    const rows = this.db.prepare(`SELECT session_id, golden FROM test_results WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})`).all(...sessionIds);
    for (const r of rows) {
      const id = String(r.session_id);
      let set = out.get(id);
      if (!set) out.set(id, (set = new Set()));
      set.add(String(r.golden));
    }
    return out;
  }

  /** The runs `shadowlap test` made for these goldens (`meta.test.golden`), newest first. */
  testReplays(goldens: readonly string[]): RunRecord[] {
    if (!goldens.length) return [];
    return this.db
      .prepare(`SELECT * FROM runs WHERE json_extract(meta, '$.test.golden') IN (${goldens.map(() => '?').join(', ')}) ORDER BY started_at DESC, run_id DESC`)
      .all(...goldens)
      .map(rowToRun);
  }

  /**
   * The revisions runs were made at (their code version), newest first: when each was last seen,
   * how many runs ended there and how many of those failed (a non-zero exit, a crash, or a failed
   * check: not one that could not be decided, nor one that did not apply). `argv` counts only runs
   * of that command, `before` only runs started before it. Blame's probes, verify's attempts and the
   * error-path presets' attempts are left out: they ran with a change of their own. Bisect offers
   * these as commits where a run still worked.
   */
  runRevisions(options: { argv?: readonly string[]; before?: number; limit?: number } = {}): Array<{ revision: string; lastAt: number; runs: number; failed: number }> {
    const where = [`code_version IS NOT NULL`, `status <> 'running'`, `json_extract(meta, '$.probe') IS NULL`, `json_extract(meta, '$.verify') IS NULL`, `json_extract(meta, '$.chaos') IS NULL`];
    const params: unknown[] = [];
    if (options.argv) {
      where.push(`json_extract(command, '$.argv') = json(?)`);
      params.push(JSON.stringify(options.argv));
    }
    if (options.before !== undefined) {
      where.push('started_at < ?');
      params.push(options.before);
    }
    params.push(Math.max(1, Math.min(1000, options.limit ?? 50)));
    // A check kept before checks had a status failed when it was not ok.
    const failed = `status IN ('failed', 'crashed') OR EXISTS (SELECT 1 FROM json_each(meta, '$.checks') WHERE json_extract(value, '$.ok') = 0 AND COALESCE(json_extract(value, '$.status'), 'failed') = 'failed')`;
    return this.db
      .prepare(`SELECT code_version, MAX(started_at) AS last_at, COUNT(*) AS runs, SUM(CASE WHEN ${failed} THEN 1 ELSE 0 END) AS failed FROM runs WHERE ${where.join(' AND ')} GROUP BY code_version ORDER BY last_at DESC, code_version ASC LIMIT ?`)
      .all(...params)
      .map((row) => ({ revision: String(row.code_version), lastAt: Number(row.last_at), runs: Number(row.runs), failed: Number(row.failed) }));
  }
}

function rowToTestSession(row: Record<string, unknown>): TestSession {
  const command = parseJsonColumn<unknown>(row.command, []);
  return {
    sessionId: String(row.session_id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    command: Array.isArray(command) ? command.map(String) : [],
    revision: row.revision === null || row.revision === undefined ? null : String(row.revision),
    passed: Number(row.passed),
    failed: Number(row.failed),
    upstreamRequests: Number(row.upstream_requests),
    actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
    interrupted: Number(row.interrupted ?? 0) === 1,
    pullRequest: pullRequestOf(parseJsonColumn<unknown>(row.pull_request, null)),
    comment: commentOf(parseJsonColumn<unknown>(row.comment, null)),
  };
}

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A session's pull request as kept, when it reads as one; anything else names none, a number that is
 * no pull request's no number, and a page that is no web page's address (http or https) no page.
 */
function pullRequestOf(v: unknown): TestSessionPullRequest | null {
  if (!isObject(v) || typeof v.source !== 'string') return null;
  const number = typeof v.number === 'number' && Number.isSafeInteger(v.number) && v.number > 0 ? v.number : null;
  return { number, url: typeof v.url === 'string' && /^https?:\/\//i.test(v.url) ? v.url : null, source: v.source };
}

/** What a session's comment carried, as kept: a part that is missing, or doesn't read as one, is none, and a comment with none, none. */
function commentOf(v: unknown): TestSessionComment | null {
  if (!isObject(v)) return null;
  const cost = isObject(v.costPerRun) ? v.costPerRun : null;
  const comment = { decisions: typeof v.decisions === 'string' ? v.decisions : null, costPerRun: cost ? { before: numberOrNull(cost.before), after: numberOrNull(cost.after) } : null };
  return comment.decisions === null && comment.costPerRun === null ? null : comment;
}

function rowToTestResult(row: Record<string, unknown>): TestResult {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    sessionId: String(row.session_id),
    golden: String(row.golden),
    at: Number(row.at),
    revision: str(row.revision),
    ok: Number(row.ok) === 1,
    failure: str(row.failure) as TestFailure | null,
    reason: str(row.reason),
    runId: str(row.run_id),
    goldenRunId: str(row.golden_run_id),
    data: parseJsonColumn<TestResultData | null>(row.data, null),
  };
}
