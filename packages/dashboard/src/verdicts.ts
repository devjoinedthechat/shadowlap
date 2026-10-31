import { decisionsHeadline, decisionsMoved, decisionsName, emptyCounts, outcomeOf, testTally, verifySentence, type DecisionCounts, type DecisionsVerify, type Normalizer, type StoreOf, type StepRerun, type TestResult, type TestSession, type VerdictStanding, type VerifiedRun, type VerifyOutcome, type VerifyReport } from '@shadowlap/engine';
import { changeName } from './fix-shared.js';
import { asksForAll, optionLike, resultLine, verdictOfResult, type GoldenSource, type GoldenVerdict } from './tests.js';
import type { VerdictTone } from './verdict.js';

/**
 * The read model behind Changes › Verdicts: every change checked before it shipped, and the verdict
 * it got, from what the store keeps already. One row per change, newest first: each revision a test
 * session ran every golden at (Tests' columns), each preview and each migration (`shadowlap
 * decisions`, `migrate`), and each verify a fix keeps. A verdict is in the words of the command that
 * gave it, from the engine's words, never one made up for the list.
 *
 * Plain functions of the store that read a window of it, however much it keeps: the newest test
 * sessions, previews and verifies, then only the rows the page shows. They run on the server's thread.
 */

/** How many of the newest test sessions, previews and verifies the page reads, at most. */
export const VERDICTS_WINDOW = 200;

/** The chips the list filters by: every change, the test sessions, the previews (migrations among them), the verifies. */
export type VerdictsKind = 'all' | 'sessions' | 'previews' | 'verifies';
export const VERDICTS_KINDS: readonly VerdictsKind[] = ['all', 'sessions', 'previews', 'verifies'];

/** A verdict as the command that gave it says it: a test session's, verify's (`incomplete` read as inconclusive, as every verdict that settled nothing is), or a preview's before verify. */
export type VerdictWord = 'passed' | 'failed' | 'inconclusive' | 'accepted' | 'rejected' | 'not verified' | 'nothing to verify';

/** What every row says, whatever checked the change. */
interface VerdictRowBase {
  /** Unique in the list: a revision's key, a session's id, a verify's id. */
  id: string;
  /** When the verdict was given. */
  at: number;
  /** The change: a commit's subject, else what its revision is; a preview's name; the fix's title. */
  title: string;
  /** Who checked it, only where checks are shared (a team store); null otherwise, or when no one was recorded. */
  by: string | null;
  /** What it was checked on: `7 goldens`, `3 runs`. */
  checked: string;
  /** What moved, each part kept whole: `2 goldens failed`, `2 writes changed`, `2 fixed`. */
  moved: string[];
  word: VerdictWord;
  /** The word's colour: `ok` held, `no` didn't, `y` open; null for none (a preview with nothing to verify). */
  tone: VerdictTone | null;
  /** Under the word: a session's tally, verify's sentence, the runs left to verify, a preview's headline. */
  line: string;
}

/** A revision a test session ran every golden at, by the newest such session there. */
export interface SessionVerdict extends VerdictRowBase {
  kind: 'session';
  /** The revision, as `shadowlap test` names it (a short sha, `+dirty` with changes not committed); null for none. */
  revision: string | null;
  /** The revision's page, `/api/verdicts/<key>`: the revision, or `no-revision`. */
  key: string;
  sessionId: string;
  /** The commit's subject, where the project's git has the commit; null otherwise. */
  subject: string | null;
  /** The session's command, as typed. */
  command: string;
  goldens: number;
  passed: number;
  failed: number;
  inconclusive: number;
}

/** A preview (`shadowlap decisions`) or a migration (`shadowlap migrate`). */
export interface PreviewVerdict extends VerdictRowBase {
  kind: 'preview' | 'migration';
  sessionId: string;
  /** The code it was asked at, as the session kept it; null when it couldn't tell. */
  revision: string | null;
  runs: number;
  /** Runs with a write, stop or judged change: what verify checks. */
  flagged: number;
  /** What flags them: 1 a write changed (red), 2 a stop, hand-over or judged change (amber); null when none is flagged. */
  flaggedRank: 1 | 2 | null;
  /** Flagged runs no verify has settled yet: verify's verdict waits for them. */
  toVerify: number;
}

/** A verify a fix keeps: one `shadowlap verify` or a repair ran. */
export interface VerifyVerdict extends VerdictRowBase {
  kind: 'verify';
  verifyId: string;
  fixId: string;
  /** What it verified, by what changed: `repair candidate 3`, the request fields it set, the code version. */
  code: string;
  verdict: VerifyOutcome;
  /** It checked the fix's own check on a run that fails it: a verdict that doesn't count changes nothing for the fix. */
  counts: boolean;
}

export type VerdictRow = SessionVerdict | PreviewVerdict | VerifyVerdict;

export interface VerdictsView {
  /** The newest revision's verdict, which leads the page as Tests' does; null before a session ran every golden. */
  lead: SessionVerdict | null;
  /** Rows by chip, of the changes the window holds. */
  counts: Record<VerdictsKind, number>;
  /** The rows of the kind asked for, newest first, `limit` at most. */
  rows: VerdictRow[];
  /** Who checked each change is named: the project has a team store. On one machine, every check is its own. */
  shared: boolean;
  /** Older changes of the kind asked for than these exist: past `limit`, or past the window read. */
  more: boolean;
}

/** A golden as one session judged it, for a revision's page. */
export interface VerdictGolden {
  golden: string;
  /** Its path without the goldens folder: `refund-flow`. */
  name: string;
  verdict: GoldenVerdict;
  /** How it came out there, in Tests' words: why it failed, its gate's tally, `8/8 replayed`. */
  note: string;
  /** The replay to open, while the store still has it. */
  runId: string | null;
}

/** A revision's page: its verdict, its goldens as that session judged them, and the previews asked at it. */
export interface VerdictRevision {
  row: SessionVerdict;
  /** The golden that leads its verdict: the first that failed, else the first inconclusive; null when every golden passed. */
  lead: VerdictGolden | null;
  /** Worst first: those that failed, then those inconclusive, then those that passed. */
  goldens: VerdictGolden[];
  /** The previews and migrations asked at this very revision, newest first. */
  decisions: PreviewVerdict[];
}

export interface VerdictsOptions {
  kind?: VerdictsKind;
  /** Rows at most (default 50, at most the window). */
  limit?: number;
  /** Checks are shared (a team store): who checked each change is named. */
  shared?: boolean;
  /** The project's goldens folder, for names (default `goldens`). */
  folder?: string;
  /** The normalizers in the project's config now, for a golden's note on a revision's page. */
  normalizers?: readonly Normalizer[];
}

type Store = StoreOf<'readModels' | 'tests'>;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const parsed = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A revision's key, as its page's address takes it: the revision, or `no-revision` for none. */
export const revisionKey = (revision: string | null): string => revision ?? 'no-revision';

/** A key a page's address may carry: `no-revision`, or a revision as `shadowlap test` names one. */
const KEY = /^(?:no-revision|[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\+dirty)?)$/;

/** The commit under a revision, the one git knows: `abc1234+dirty` was tested with changes on top of abc1234. */
export const committed = (revision: string): string => revision.replace(/\+dirty$/, '');

/**
 * A session's change in words: its commit's subject (`Tighten refund wording`), with changes not
 * committed when it was tested with some; else what its revision is; `Tested with no revision`.
 */
export function sessionTitle(revision: string | null, subject: string | null): string {
  if (!revision) return 'Tested with no revision';
  const dirty = revision.endsWith('+dirty');
  if (subject) return dirty ? `${subject}, with uncommitted changes` : subject;
  return dirty ? `Uncommitted changes on ${committed(revision)}` : `Commit ${revision}`;
}

// ---- test sessions ----

/** When each golden was first tested, of those given: one look up the golden's index each. */
function firstTested(store: Store, paths: readonly string[]): Map<string, number> {
  if (!paths.length) return new Map();
  const rows = store.query(`SELECT g.value AS golden, (SELECT MIN(r.at) FROM test_results r WHERE r.golden = g.value) AS first FROM json_each(?) g`, JSON.stringify(paths));
  return new Map(rows.filter((r) => typeof r.first === 'number').map((r) => [String(r.golden), Number(r.first)]));
}

/**
 * The newest session that ran every golden at each revision, newest first, among the newest sessions
 * the store keeps, as Tests' columns are made: one that asked for each golden on disk tested before
 * it started (`goldens/*`, or each by name), or ran each of them; a golden packed since can't count
 * against it. Only a session that ended, and went through its goldens, gave a verdict: one running
 * now, one a signal stopped, and one whose process was killed are left out. `more` says older
 * sessions are past the window.
 */
function revisionSessions(store: Store, goldens: readonly GoldenSource[]): { sessions: TestSession[]; more: boolean } {
  const read = store.listTestSessions({ limit: VERDICTS_WINDOW + 1, finished: true });
  const more = read.length > VERDICTS_WINDOW;
  const window = read.slice(0, VERDICTS_WINDOW).filter((s) => !s.interrupted);
  const ran = store.testSessionGoldens(window.map((s) => s.sessionId));
  const readable = goldens.filter((g) => !optionLike(g.path) && !g.error).map((g) => g.path);
  const first = firstTested(store, readable);
  const full = (s: TestSession): boolean => {
    const got = ran.get(s.sessionId);
    if (!got) return false;
    const need = readable.filter((p) => (first.get(p) ?? Infinity) < s.startedAt);
    return asksForAll(s.command, need) || need.every((p) => got.has(p));
  };
  const seen = new Set<string>();
  const sessions: TestSession[] = [];
  for (const s of window) {
    const key = revisionKey(s.revision);
    if (seen.has(key) || !full(s)) continue;
    seen.add(key);
    sessions.push(s);
  }
  return { sessions, more };
}

/** Each session's goldens by how they came out: one read of the verdict each result kept, not the rest of it. */
function sessionTallies(store: Store, ids: readonly string[]): Map<string, { passed: number; failed: number; inconclusive: number }> {
  const out = new Map<string, { passed: number; failed: number; inconclusive: number }>();
  if (!ids.length) return out;
  const rows = store.query(`SELECT session_id AS session, ok, failure, json_extract(data, '$.verdict') AS verdict FROM test_results WHERE session_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
  for (const r of rows) {
    const kept = str(r.verdict);
    const verdict = verdictOfResult({ ok: Number(r.ok) === 1, failure: str(r.failure) as TestResult['failure'], data: kept === 'passed' || kept === 'failed' || kept === 'inconclusive' ? { verdict: kept } : null });
    const t = out.get(String(r.session)) ?? { passed: 0, failed: 0, inconclusive: 0 };
    t[verdict]++;
    out.set(String(r.session), t);
  }
  return out;
}

/** Sessions as rows: the tally of each, in the test command's words, and what moved. Titled by the revision until its commit's subject is known (`withSubjects`). */
function sessionRows(store: Store, sessions: readonly TestSession[], shared: boolean): SessionVerdict[] {
  const tallies = sessionTallies(store, sessions.map((s) => s.sessionId));
  return sessions.map((s) => {
    const t = tallies.get(s.sessionId) ?? { passed: 0, failed: 0, inconclusive: 0 };
    const goldens = t.passed + t.failed + t.inconclusive;
    const moved = [t.failed ? `${plural(t.failed, 'golden')} failed` : '', t.inconclusive ? `${t.inconclusive} inconclusive` : ''].filter(Boolean);
    return {
      kind: 'session',
      id: revisionKey(s.revision),
      key: revisionKey(s.revision),
      at: s.endedAt ?? s.startedAt,
      title: sessionTitle(s.revision, null),
      by: shared ? s.actor : null,
      checked: plural(goldens, 'golden'),
      moved: moved.length ? moved : ['every golden held'],
      word: t.failed ? 'failed' : t.inconclusive ? 'inconclusive' : 'passed',
      tone: t.failed ? 'no' : t.inconclusive ? 'y' : 'ok',
      line: testTally(t),
      revision: s.revision,
      sessionId: s.sessionId,
      subject: null,
      command: s.command.join(' '),
      goldens,
      ...t,
    };
  });
}

/**
 * The rows with their commits' subjects, as git gave them for the commit under each revision
 * (`committed`), and each titled by it.
 */
export function withSubjects<T extends { lead: SessionVerdict | null; rows: VerdictRow[] } | VerdictRevision>(view: T, subjects: ReadonlyMap<string, string>): T {
  const name = (r: SessionVerdict): SessionVerdict => {
    const subject = r.revision ? (subjects.get(committed(r.revision)) ?? null) : null;
    return { ...r, subject, title: sessionTitle(r.revision, subject) };
  };
  if ('row' in view) return { ...view, row: name(view.row) };
  return { ...view, lead: view.lead && name(view.lead), rows: view.rows.map((r) => (r.kind === 'session' ? name(r) : r)) };
}

/** The commits whose subjects a view's rows want, for git to be asked about at once. */
export function subjectRevisions(view: { lead: SessionVerdict | null; rows: VerdictRow[] } | VerdictRevision): string[] {
  const rows = 'row' in view ? [view.row] : [...(view.lead ? [view.lead] : []), ...view.rows];
  return [...new Set(rows.flatMap((r) => (r.kind === 'session' && r.revision ? [committed(r.revision)] : [])))];
}

// ---- previews and migrations ----

/** A part of a kept session's report: a decisions session's own, a migration's under `decisions`. */
const part = (path: string) => `json_extract(s.data, CASE s.kind WHEN 'migrate' THEN '$.decisions.${path}' ELSE '$.${path}' END)`;

/**
 * The newest previews and migrations, and the verifies they ran: a verify `decisions --verify` ran
 * is the preview's verdict, never a row of its own, even where a fix keeps it too.
 */
function previewWindow(store: Store): { entries: Array<{ sessionId: string; kind: 'preview' | 'migration'; at: number }>; verifyIds: Set<string>; more: boolean } {
  const rows = store.query(`SELECT s.session_id AS id, s.kind AS kind, s.at AS at, ${part('verify.verifyIds')} AS verify_ids FROM decision_sessions s ORDER BY s.at DESC, s.session_id DESC LIMIT ?`, VERDICTS_WINDOW + 1);
  const verifyIds = new Set<string>();
  for (const r of rows) for (const id of parsed<unknown[]>(r.verify_ids, [])) if (typeof id === 'string') verifyIds.add(id);
  const entries = rows.slice(0, VERDICTS_WINDOW).map((r) => ({ sessionId: String(r.id), kind: r.kind === 'migrate' ? ('migration' as const) : ('preview' as const), at: Number(r.at) }));
  return { entries, verifyIds, more: rows.length > VERDICTS_WINDOW };
}

/** What a kept session says of itself, read from its report without its runs, and from its runs' rows without their decisions. */
interface PreviewFacts {
  id: string;
  kind: 'preview' | 'migration';
  at: number;
  actor: string | null;
  revision: string | null;
  name: string;
  counts: DecisionCounts;
  flagged: string[];
  verify: DecisionsVerify | null;
  /** Steps a judge check came out otherwise for (DecisionsJudged's `changed`). */
  judged: number;
  /** Steps that wait on a judge: a sample's words could not be judged (DecisionsJudged's `inconclusive`). */
  judgeOpen: number;
  /** Why it stopped before every step was asked, or null. */
  stopReason: string | null;
  fromCode: boolean;
  runs: number;
  goldens: number;
  flaggedRank: 1 | 2 | null;
}

/** A kept verify, when it is one: its verdict and each run's role and outcome. */
function verifyOf(raw: unknown): DecisionsVerify | null {
  const v = parsed<Partial<DecisionsVerify> | null>(raw, null);
  if (!v || typeof v.verdict !== 'string' || !Array.isArray(v.runs)) return null;
  return { ...(v as DecisionsVerify), runs: v.runs.filter((x) => x && typeof x.runId === 'string' && typeof x.role === 'string' && typeof x.outcome === 'string') };
}

function previewFacts(store: Store, ids: readonly string[]): Map<string, PreviewFacts> {
  const rows = store.query(
    `SELECT s.session_id AS id, s.kind AS kind, s.at AS at, s.actor AS actor, s.revision AS revision,
       ${part('change')} AS change, ${part('counts')} AS counts, ${part('flagged')} AS flagged, ${part('verify')} AS verify, ${part('judge.changed')} AS judged, ${part('judge.inconclusive')} AS judge_open, ${part('stopReason')} AS stop_reason,
       json_extract(s.data, '$.from') AS from_models, json_extract(s.data, '$.to') AS to_model,
       (SELECT COUNT(*) FROM decision_runs r WHERE r.session_id = s.session_id) AS runs,
       (SELECT COUNT(r.golden) FROM decision_runs r WHERE r.session_id = s.session_id) AS goldens,
       (SELECT MIN(r.rank) FROM decision_runs r WHERE r.session_id = s.session_id AND r.rank <= 2) AS flag_rank
     FROM decision_sessions s WHERE s.session_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  );
  const out = new Map<string, PreviewFacts>();
  for (const r of rows) {
    const kind = r.kind === 'migrate' ? 'migration' : 'preview';
    const change = parsed<{ model?: string | null; fields?: Record<string, unknown> | null; fromCode?: unknown } | null>(r.change, null);
    const counts = { ...emptyCounts(), ...parsed<Partial<DecisionCounts>>(r.counts, {}) };
    const from = parsed<unknown[]>(r.from_models, []).filter((m): m is string => typeof m === 'string');
    const name = decisionsName({ kind: kind === 'migration' ? 'migrate' : 'decisions', change, from, to: str(r.to_model) });
    const flaggedRank = r.flag_rank === 1 || r.flag_rank === 2 ? r.flag_rank : null;
    out.set(String(r.id), { id: String(r.id), kind, at: Number(r.at), actor: str(r.actor), revision: str(r.revision), name, counts, flagged: parsed<unknown[]>(r.flagged, []).filter((x): x is string => typeof x === 'string'), verify: verifyOf(r.verify), judged: count(r.judged), judgeOpen: count(r.judge_open), stopReason: str(r.stop_reason), fromCode: !!change?.fromCode, runs: count(r.runs), goldens: count(r.goldens), flaggedRank });
  }
  return out;
}

/** Runs a --from-code session could not ask whole: refused, so no step of theirs was asked (only such a session refuses one). */
function refusedRuns(store: Store, sessionId: string): number {
  const rows = store.query(`SELECT COUNT(*) AS n FROM decision_runs WHERE session_id = ? AND rank IS NULL AND changed = 0 AND json_extract(data, '$.refused') IS NOT NULL`, sessionId);
  return count(rows[0]?.n);
}

/**
 * What a preview that flags no run settled, in the words the CLI says it with: its headline, unless
 * it settled nothing (as `decisions` exits 1 for): a run it could not ask, no step answered, words a
 * judge could not judge, or a stop before every step was asked.
 */
function unflaggedVerdict(store: Store, f: PreviewFacts): Pick<PreviewVerdict, 'word' | 'tone' | 'line'> {
  // Only a --from-code change refuses a run whole: that run asked no step.
  const refused = f.fromCode ? refusedRuns(store, f.id) : 0;
  const runs = Array.from({ length: f.runs }, (_, i) => ({ runId: '', refused: i < refused ? 'refused' : null, decisions: [] }));
  const h = decisionsHeadline({ counts: f.counts, flagged: [], runs });
  const open = (line: string) => ({ word: 'not verified' as const, tone: 'y' as const, line });
  if (h.unasked) return open(h.unasked);
  if (!h.asked && f.counts.notAsked) return open(`${h.lead}${h.rest}`);
  if (f.judgeOpen) return open(`${f.judgeOpen} ${f.judgeOpen === 1 ? 'step waits' : 'steps wait'} on a judge`);
  if (f.stopReason) return open(`Stopped before every step was asked: ${f.stopReason}`);
  return { word: 'nothing to verify', tone: null, line: `${h.lead}${h.rest}` };
}

/**
 * A preview's verdict: verify's, in its words, once verify settled every run the change flags, or
 * rejected the change on any; before that, not verified, with the runs left to verify. One that
 * flags no run has nothing to verify (`unflaggedVerdict`).
 */
function previewVerdict(store: Store, f: PreviewFacts): Pick<PreviewVerdict, 'word' | 'tone' | 'line' | 'toVerify'> {
  if (!f.flagged.length) return { ...unflaggedVerdict(store, f), toVerify: 0 };
  const ran = f.verify && f.verify.verdict !== 'not-run' ? f.verify.runs : [];
  const verified = new Set(ran.map((x) => x.runId));
  const left = f.flagged.filter((id) => !verified.has(id)).length;
  const sentence = `The change ${verifySentence(ran)}`;
  if (ran.length && f.verify!.verdict === 'rejected') return { word: 'rejected', tone: 'no', line: sentence, toVerify: left };
  if (ran.length && !left) return f.verify!.verdict === 'accepted' ? { word: 'accepted', tone: 'ok', line: sentence, toVerify: 0 } : { word: 'inconclusive', tone: 'y', line: sentence, toVerify: 0 };
  return { word: 'not verified', tone: 'y', line: `${left} of ${plural(f.runs, unitOf(f))} to verify`, toVerify: left };
}

/** What a session's runs are: goldens when every one is a golden's, else runs. */
const unitOf = (f: Pick<PreviewFacts, 'runs' | 'goldens'>) => (f.runs && f.goldens === f.runs ? 'golden' : 'run');

function previewRows(store: Store, ids: readonly string[], shared: boolean): PreviewVerdict[] {
  const facts = previewFacts(store, ids);
  return ids.flatMap((id) => {
    const f = facts.get(id);
    if (!f) return [];
    return [
      {
        kind: f.kind,
        id: f.id,
        sessionId: f.id,
        at: f.at,
        title: f.name,
        by: shared ? f.actor : null,
        checked: plural(f.runs, unitOf(f)),
        moved: decisionsMoved({ counts: f.counts, judge: { changed: f.judged } }),
        ...previewVerdict(store, f),
        revision: f.revision,
        runs: f.runs,
        flagged: f.flagged.length,
        flaggedRank: f.flaggedRank,
      },
    ];
  });
}

// ---- verifies ----

/** The newest verifies a fix keeps, those a preview ran left out (`skip`): their rows are the preview's. */
function verifyWindow(store: Store, skip: ReadonlySet<string>): { entries: Array<{ verifyId: string; at: number }>; more: boolean } {
  const rows = store.query(`SELECT v.verify_id AS id, v.at AS at FROM verdicts v WHERE EXISTS (SELECT 1 FROM fix_links l WHERE l.ref = v.verify_id AND l.kind = 'verify') ORDER BY v.at DESC, v.verify_id DESC LIMIT ?`, VERDICTS_WINDOW + 1);
  const entries = rows
    .slice(0, VERDICTS_WINDOW)
    .map((r) => ({ verifyId: String(r.id), at: Number(r.at) }))
    .filter((e) => !skip.has(e.verifyId));
  return { entries, more: rows.length > VERDICTS_WINDOW };
}

/** The fix each verify is a row of: the first it counts for, else the first that keeps it. */
function fixesOf(store: Store, ids: readonly string[]): Map<string, { fixId: string; title: string; counts: boolean }> {
  const rows = store.query(`SELECT l.ref AS id, l.fix_id AS fix, l.data AS standing, f.title AS title FROM fix_links l JOIN fixes f ON f.fix_id = l.fix_id WHERE l.kind = 'verify' AND l.ref IN (SELECT value FROM json_each(?)) ORDER BY l.at, l.fix_id`, JSON.stringify(ids));
  const out = new Map<string, { fixId: string; title: string; counts: boolean }>();
  for (const r of rows) {
    const counts = parsed<VerdictStanding | null>(r.standing, null)?.counts !== false;
    const was = out.get(String(r.id));
    if (!was || (!was.counts && counts)) out.set(String(r.id), { fixId: String(r.fix), title: String(r.title), counts });
  }
  return out;
}

/**
 * Verifies as rows: each run's outcome in verify's words, and its sentence, read out of the kept
 * report without its attempts. Titled by the fix it is a row of; what it verified named by what
 * changed, as the fix's Verify step names it.
 */
function verifyRows(store: Store, ids: readonly string[]): VerifyVerdict[] {
  if (!ids.length) return [];
  const rows = store.query(
    `SELECT v.verify_id AS id, v.at AS at, v.verdict AS verdict,
       json_extract(v.record, '$.candidate') AS candidate, json_extract(v.record, '$.command') AS command, json_extract(v.record, '$.rerun') AS rerun,
       json_extract(v.record, '$.report.fields') AS fields, json_extract(v.record, '$.report.codeVersion') AS code_version,
       (SELECT json_group_array(json_object('role', json_extract(r.value, '$.role'), 'verdict', json_extract(r.value, '$.verdict'), 'decision', json_extract(r.value, '$.decision'), 'undecided', json_extract(r.value, '$.undecided')))
          FROM json_each(v.record, '$.report.runs') r) AS runs
     FROM verdicts v WHERE v.verify_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  );
  const fixes = fixesOf(store, ids);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    const fix = fixes.get(id);
    if (!r || !fix) return [];
    const runs = parsed<Array<Pick<VerifiedRun, 'role' | 'verdict' | 'decision' | 'undecided'>>>(r.runs, []).map((x) => ({ role: x.role, outcome: outcomeOf(x) }));
    const verdict: VerifyOutcome = r.verdict === 'accepted' || r.verdict === 'rejected' ? r.verdict : 'incomplete';
    // What changeName reads of the report: the request fields it set and the code it ran at.
    const report: Pick<VerifyReport, 'fields' | 'codeVersion'> = { fields: parsed<Record<string, unknown>>(r.fields, {}), codeVersion: str(r.code_version) };
    const shape = { candidate: typeof r.candidate === 'number' ? r.candidate : null, command: str(r.command) ?? '', rerun: parsed<StepRerun | null>(r.rerun, null), report: report as VerifyReport };
    const outcomes = new Map<string, number>();
    for (const x of runs) outcomes.set(x.outcome, (outcomes.get(x.outcome) ?? 0) + 1);
    return [
      {
        kind: 'verify' as const,
        id,
        verifyId: id,
        fixId: fix.fixId,
        at: Number(r.at),
        title: fix.title,
        by: null,
        checked: plural(runs.length, 'run'),
        moved: [...outcomes].map(([outcome, n]) => `${n} ${outcome}`),
        word: verdict === 'incomplete' ? 'inconclusive' : verdict,
        tone: verdict === 'accepted' ? 'ok' : verdict === 'rejected' ? 'no' : 'y',
        line: runs.length ? `The change ${verifySentence(runs)}` : 'No run verified',
        code: changeName(shape),
        verdict,
        counts: fix.counts,
      },
    ];
  });
}

// ---- the list and a revision's page ----

/** Which chip a row's kind is under. */
const CHIP: Record<VerdictRow['kind'], Exclude<VerdictsKind, 'all'>> = { session: 'sessions', preview: 'previews', migration: 'previews', verify: 'verifies' };

/**
 * The list: every change the window holds, newest first, filtered to the chip asked for, `limit`
 * rows at most; each chip's count; and the newest revision's verdict to lead the page. Each source
 * is read newest first, at most the window, and only the rows shown are built.
 */
export function verdictsView(store: Store, goldens: readonly GoldenSource[], options: VerdictsOptions = {}): VerdictsView {
  const kind = options.kind ?? 'all';
  const limit = Math.max(1, Math.min(VERDICTS_WINDOW, options.limit ?? 50));
  const shared = !!options.shared;
  const tested = revisionSessions(store, goldens);
  const previews = previewWindow(store);
  const verifies = verifyWindow(store, previews.verifyIds);
  const entries = [
    ...tested.sessions.map((s) => ({ kind: 'session' as const, at: s.endedAt ?? s.startedAt, ref: s.sessionId })),
    ...previews.entries.map((p) => ({ kind: p.kind, at: p.at, ref: p.sessionId })),
    ...verifies.entries.map((v) => ({ kind: 'verify' as const, at: v.at, ref: v.verifyId })),
  ].sort((a, b) => b.at - a.at || (a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0));
  const counts: Record<VerdictsKind, number> = { all: entries.length, sessions: 0, previews: 0, verifies: 0 };
  for (const e of entries) counts[CHIP[e.kind]]++;
  const picked = entries.filter((e) => kind === 'all' || CHIP[e.kind] === kind);
  const shown = picked.slice(0, limit);
  const past = { sessions: tested.more, previews: previews.more, verifies: verifies.more };
  const more = picked.length > limit || (kind === 'all' ? Object.values(past).some(Boolean) : past[kind]);
  // Only the rows shown are built, and the lead's, which is the newest revision's whatever the chip.
  const refs = (...kinds: Array<VerdictRow['kind']>) => shown.filter((e) => kinds.includes(e.kind)).map((e) => e.ref);
  const leadId = tested.sessions[0]?.sessionId ?? null;
  const ofSessions = new Set([...refs('session'), ...(leadId ? [leadId] : [])]);
  const sessions = new Map(sessionRows(store, tested.sessions.filter((s) => ofSessions.has(s.sessionId)), shared).map((r) => [r.sessionId, r]));
  const others = new Map<string, VerdictRow>([...previewRows(store, refs('preview', 'migration'), shared), ...verifyRows(store, refs('verify'))].map((r) => [r.id, r]));
  const rows = shown.map((e) => (e.kind === 'session' ? sessions.get(e.ref) : others.get(e.ref))).filter((r): r is VerdictRow => !!r);
  return { lead: leadId ? (sessions.get(leadId) ?? null) : null, counts, rows, shared, more };
}

const WORST: Record<GoldenVerdict, number> = { failed: 0, inconclusive: 1, passed: 2 };

/** Which of these runs the store still has. */
function runsKept(store: Store, ids: readonly string[]): Set<string> {
  if (!ids.length) return new Set();
  return new Set(store.query(`SELECT run_id AS id FROM runs WHERE run_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).map((r) => String(r.id)));
}

/** The previews and migrations asked at a revision, of the newest the store keeps, newest first. */
function previewsAt(store: Store, revision: string): string[] {
  return store.query(`SELECT id FROM (SELECT session_id AS id, revision, at FROM decision_sessions ORDER BY at DESC, session_id DESC LIMIT ?) WHERE revision = ? ORDER BY at DESC, id DESC`, VERDICTS_WINDOW, revision).map((r) => String(r.id));
}

/**
 * A revision's page, by its key (`revisionKey`): its row as the list shows it, its goldens as the
 * session that ran them all there judged them, worst first, each with its note in Tests' words, the
 * golden that leads its verdict, and the previews asked at it. Null for a key the window has no such
 * session for, or one no revision could be.
 */
export function verdictRevision(store: Store, goldens: readonly GoldenSource[], key: string, options: Omit<VerdictsOptions, 'kind' | 'limit'> = {}): VerdictRevision | null {
  if (!KEY.test(key)) return null;
  const session = revisionSessions(store, goldens).sessions.find((s) => revisionKey(s.revision) === key);
  if (!session) return null;
  const shared = !!options.shared;
  const folder = options.folder ?? 'goldens';
  const [row] = sessionRows(store, [session], shared);
  const results = store.listTestResults({ sessionId: session.sessionId, limit: 100_000 });
  const kept = runsKept(store, results.flatMap((r) => (r.runId ? [r.runId] : [])));
  const checks = new Map(goldens.map((g) => [g.path, g.checks]));
  const judged: VerdictGolden[] = results
    .map((r) => ({
      golden: r.golden,
      name: r.golden.startsWith(`${folder}/`) ? r.golden.slice(folder.length + 1) : r.golden,
      verdict: verdictOfResult(r),
      note: resultLine(r, checks.get(r.golden) ?? [], options.normalizers ?? []),
      runId: r.runId && kept.has(r.runId) ? r.runId : null,
    }))
    .sort((a, b) => WORST[a.verdict] - WORST[b.verdict] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lead = judged.find((g) => g.verdict === 'failed') ?? judged.find((g) => g.verdict === 'inconclusive') ?? null;
  return { row: row!, lead, goldens: judged, decisions: session.revision ? previewRows(store, previewsAt(store, session.revision), shared) : [] };
}
