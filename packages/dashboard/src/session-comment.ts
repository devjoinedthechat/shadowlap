import { aboutUsd, commentDecisions, commentInjection, costPerRunLine, decisionsMoved, emptyCounts, percentChange, testResultVerdict, type CommentDecision, type CommentDecisionsSource, type CommentResult, type DecisionCounts, type DecisionStep, type PullRequestState, type StoreOf, type TestResult, type TestSession, type TestSessionComment } from '@shadowlap/engine';

/**
 * What a test session keeps of the pull request it ran for, and of the comment the Action keeps on
 * it, as Changes › Verdicts, a revision's page and Settings → CI's preview of the comment read them:
 * where the pull request stands, whether it merged while the session's verdict didn't pass, the
 * decisions the branch changes (the `decisions --from-code` session the job kept), a run's cost
 * before and after, and each golden's injection gate. Every part is said in the comment's own words
 * (the engine's pr-comment), so a page shows what the comment carried. Plain reads of the store, on
 * the server's thread: no run and no call is read.
 */

type Store = StoreOf<'readModels' | 'tests'>;

/** The pull request a session ran for, and where it stands, as gh last said; `state` null until someone said. */
export interface VerdictPullRequest {
  /** Its number; null when CI ran the job for one but gave none, which the pages leave out. */
  number: number | null;
  /** Its page, where GitHub Actions named it; null otherwise. */
  url: string | null;
  state: PullRequestState | null;
}

/** A session whose pull request merged though its verdict didn't pass: the change shipped with it. */
export type VerdictFlag = 'merged while failing' | 'merged while inconclusive';

/** A session's pull request, as the pages show it; null for a session that ran for none. */
export function pullRequestOf(s: Pick<TestSession, 'pullRequest'>): VerdictPullRequest | null {
  const pr = s.pullRequest;
  return pr ? { number: pr.number, url: pr.url, state: pr.state ?? null } : null;
}

/** The flag a session's verdict gets once its pull request merged: none while it is open, closed, or untold, none for a verdict that passed, and none for a pull request with no number. */
export function flagOf(word: string, pr: VerdictPullRequest | null): VerdictFlag | null {
  if (pr?.number === null || pr?.number === undefined || pr.state !== 'merged') return null;
  return word === 'failed' ? 'merged while failing' : word === 'inconclusive' ? 'merged while inconclusive' : null;
}

const parsed = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return (JSON.parse(v) as T) ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * What the decisions each session kept for its comment changed, in the words previews say it in
 * (decisionsMoved: `1 write changed`, `1 stop changed`), by session: one read of those previews'
 * counts. A session that kept none, or whose preview is gone, has no entry.
 */
export function keptDecisionsMoved(store: Store, sessions: ReadonlyArray<Pick<TestSession, 'sessionId' | 'comment'>>): Map<string, string[]> {
  const wanted = sessions.flatMap((s) => (s.comment?.decisions ? [{ session: s.sessionId, decisions: s.comment.decisions }] : []));
  if (!wanted.length) return new Map();
  const rows = store.query(`SELECT session_id AS id, json_extract(data, '$.counts') AS counts FROM decision_sessions WHERE kind = 'decisions' AND session_id IN (SELECT value FROM json_each(?))`, JSON.stringify(wanted.map((w) => w.decisions)));
  const counts = new Map(rows.map((r) => [String(r.id), { ...emptyCounts(), ...parsed<Partial<DecisionCounts>>(r.counts, {}) }]));
  return new Map(
    wanted.flatMap((w) => {
      const c = counts.get(w.decisions);
      return c ? [[w.session, decisionsMoved(c)] as const] : [];
    }),
  );
}

/**
 * A kept `decisions --from-code` session as the comment reads it, in one bounded read: its counts and
 * the runs it flags, from its report; each run's golden and whether it was refused; and only the rank
 * 1 and 2 steps of the runs it flags, with what changed and the recorded and new calls. Null for none,
 * one the store no longer keeps, or a migration.
 */
export function keptDecisions(store: Store, id: string | null | undefined): (CommentDecisionsSource & { sessionId: string }) | null {
  if (!id) return null;
  const rows = store.query(
    `SELECT json_extract(s.data, '$.counts') AS counts, json_extract(s.data, '$.flagged') AS flagged, r.run_id AS run, r.golden AS golden, json_extract(r.data, '$.refused') AS refused,
       CASE WHEN r.run_id IN (SELECT value FROM json_each(s.data, '$.flagged')) THEN
         (SELECT json_group_array(json_object('callNo', json_extract(d.value, '$.callNo'), 'majority', json_extract(d.value, '$.majority'), 'changes', json_extract(d.value, '$.changes'), 'recorded', json_extract(d.value, '$.recorded'), 'now', json_extract(d.value, '$.now')))
          FROM json_each(r.data, '$.decisions') d WHERE json_extract(d.value, '$.majority') <= 2)
       END AS steps
     FROM decision_sessions s LEFT JOIN decision_runs r ON r.session_id = s.session_id
     WHERE s.session_id = ? AND s.kind = 'decisions' ORDER BY r.position`,
    id,
  );
  if (!rows.length) return null;
  const counts = { ...emptyCounts(), ...parsed<Partial<DecisionCounts>>(rows[0]!.counts, {}) };
  const flagged = parsed<unknown[]>(rows[0]!.flagged, []).filter((x): x is string => typeof x === 'string');
  const runs = rows
    .filter((r) => typeof r.run === 'string')
    .map((r) => {
      const steps = parsed<unknown[]>(r.steps, []).filter((s): s is DecisionStep => !!s && typeof s === 'object' && Array.isArray((s as DecisionStep).changes) && typeof (s as DecisionStep).recorded === 'object');
      return { runId: String(r.run), golden: typeof r.golden === 'string' ? r.golden : null, refused: typeof r.refused === 'string' ? r.refused : null, decisions: steps };
    });
  return { sessionId: id, counts, flagged, runs };
}

/** A session's results in the order it ran them, as its JSON report lists them: the store lists them newest first. */
export const inSessionOrder = (results: readonly TestResult[]): TestResult[] => [...results].sort((a, b) => a.at - b.at);

/** A stored result as the comment reads it, as the Action reads the same result from the JSON report (packResult): its golden, verdict, message and the parts its verdict line says. */
export function storedCommentResult(r: TestResult): CommentResult {
  const d = r.data ?? {};
  return { golden: r.golden, ok: r.ok, verdict: testResultVerdict(r), message: r.reason, gate: d.gate ?? null, updated: d.updated ?? null, divergence: d.divergence ?? null, attempts: d.attempts ?? null, checks: d.checks ?? null, injection: d.injection ?? null };
}

/** The decisions the branch changes, as the comment says them: the headline's mark and sentence, counted in goldens, and each rank 1 and 2 step of the goldens it flags. */
export interface KeptDecisions {
  /** The `decisions --from-code` session they came from. */
  sessionId: string;
  mark: '✗' | '!' | '✓';
  sentence: string;
  rows: CommentDecision[];
}

/** A run's cost before and after, as the comment says it: `≈$0.041 → ≈$0.043 (+5%)`, and its two parts. */
export interface KeptCost {
  before: number;
  after: number;
  line: string;
  /** `≈$0.041 → ≈$0.043` */
  amounts: string;
  /** `+5%`, `about the same` */
  change: string;
}

/** A golden's injection gate that ran, as the comment lists it, with the result kept for it so a page can open it. */
export interface KeptInjection {
  verdict: string;
  golden: string;
  resultId: string | null;
  /** `passed · 6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored` */
  line: string;
  /** The line after its verdict; null for a gate with no attempts, whose verdict says it all. */
  tally: string | null;
}

/** What the comment carried beside the verdicts: the decisions, the cost per run, each injection gate. */
export interface SessionCommentParts {
  /** Null when the session kept none, or its preview is gone. */
  decisions: KeptDecisions | null;
  /** Null without both sides. */
  cost: KeptCost | null;
  /** Worst golden first; empty with no gate that ran. */
  injection: KeptInjection[];
}

/** The decisions part in the comment's words; null for none kept. */
export function decisionsPart(source: (CommentDecisionsSource & { sessionId: string }) | null): KeptDecisions | null {
  if (!source) return null;
  const d = commentDecisions(source);
  return { sessionId: source.sessionId, ...d };
}

/** The cost part in the comment's words; null without both sides. */
export function costPart(cost: TestSessionComment['costPerRun'] | undefined): KeptCost | null {
  const line = costPerRunLine(cost);
  if (!line || !cost || cost.before === null || cost.after === null) return null;
  return { before: cost.before, after: cost.after, line, amounts: `${aboutUsd(cost.before)} → ${aboutUsd(cost.after)}`, change: percentChange(cost.before, cost.after) };
}

/**
 * What a session's comment carried beside its verdicts, from what the session keeps: the decisions
 * part its job kept, its cost per run, and the injection gate of each result. Null when it carried
 * none of them.
 */
export function sessionCommentParts(store: Store, session: Pick<TestSession, 'comment'>, results: readonly CommentResult[]): SessionCommentParts | null {
  const parts: SessionCommentParts = { decisions: decisionsPart(keptDecisions(store, session.comment?.decisions)), cost: costPart(session.comment?.costPerRun), injection: commentInjection(results) };
  return parts.decisions || parts.cost || parts.injection.length ? parts : null;
}
