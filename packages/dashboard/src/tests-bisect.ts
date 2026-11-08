import { commandIsImported, hasRecordedCommand, importedCommandSource, isObject, withoutCommand, type RunRecord, type StoreOf, type TestResult } from '@shadowlap/engine';
import { GOLDEN_HISTORY } from './bisect-start.js';

/**
 * What Find breaking commit said about a golden, as `shadowlap bisect` keeps it in the activity
 * (`bisect.found` and `bisect.none`), and the rule for whether an answer still stands for the failure
 * the golden shows: Tests, a run's page, its next step and its fix read the same.
 */

/**
 * What the first bad commit changed against its first parent, as bisect kept it with its answer:
 * `file`, `files`, `hunk`, `line`, `cut` and `merge` as the CLI wrote them (docs/cli.md, bisect), sizes
 * capped again here. `path` and `outside` are worked out where the project folder is known
 * (found-here.ts); null and 0 until then.
 */
export interface FoundChange {
  /** Relative to the repository, as git names it. */
  file: string;
  files: string[];
  /** `file`'s diff from its first `@@`; null for a binary or deleted file. */
  hunk: string | null;
  /** The new file's line of the first added line; null without a hunk. */
  line: number | null;
  cut: boolean;
  /** A merge: its change is against its first parent, and it reverts with `-m 1`. */
  merge: boolean;
  /** `file` relative to the project folder, through its real path: what Open in editor opens. Null outside it. */
  path: string | null;
  /** How many of `files` are outside the project folder: git reverts them too. */
  outside: number;
}

/** The first bad commit `shadowlap bisect` found for a golden: the card above its buttons. */
export interface FoundCommit {
  rev: string;
  subject: string;
  /** Empty where names aren't shown (found-here.ts). */
  author: string;
  date: string;
  /** Why it fails there. */
  why: string;
  /** Commits just before it that could not be tested: the first bad one may be among them. */
  untested: string[];
  replays: number;
  tokens: number;
  at: number;
  /** What it changed; null for an answer kept before bisect kept it, or when git couldn't say. */
  change: FoundChange | null;
}

/** What Find breaking commit said when it named no first bad commit: why, between which commits it looked, and how it came out. */
export interface BisectMiss {
  why: string;
  good: string | null;
  bad: string | null;
  /**
   * `fails-at-good`: it already failed at the good commit, so an older one is asked for.
   * `passes-at-bad`: it passed at the commit it fails at, as committed, so the failure is in changes
   * not committed there, or doesn't happen every time; no other good commit helps. `untestable`: a
   * commit could not be checked out or built. Null for an answer kept before outcomes were.
   */
  outcome: 'fails-at-good' | 'passes-at-bad' | 'untestable' | null;
  at: number;
}

/** What Find breaking commit said about a golden: a first bad commit, or none and why (the `bisect.found` and `bisect.none` activity events). */
export type BisectAnswer = { found: FoundCommit; missed: null } | { found: null; missed: BisectMiss };

/**
 * One answer, with the failure it answered: the golden's newest result when the search started, as
 * `shadowlap bisect` records it (`answered`), or null for an answer kept before it did.
 */
export interface AnswerEvent {
  answer: BisectAnswer;
  at: number;
  answered: { at: number; ok: boolean } | null;
}

const MISS_OUTCOMES = new Set(['fails-at-good', 'passes-at-bad', 'untestable']);

/** The bounds bisect keeps a change to, held again on what the activity hands back. */
const MAX_FILES = 50;
const MAX_HUNK_LINES = 60;
const MAX_HUNK_BYTES = 4096;
const MAX_PATH = 4096;

const pathOf = (v: unknown): string | null => (typeof v === 'string' && v && v.length <= MAX_PATH && !v.includes('\0') ? v : null);

/** A hunk within bisect's bounds, cut at a line where it isn't. */
function boundedHunk(hunk: string): { hunk: string; cut: boolean } {
  const utf8 = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (const line of hunk.split('\n')) {
    const size = utf8.encode(line).length + 1;
    if (kept.length >= MAX_HUNK_LINES || (kept.length && bytes + size > MAX_HUNK_BYTES) || size > MAX_HUNK_BYTES) return { hunk: kept.join('\n'), cut: true };
    kept.push(line);
    bytes += size;
  }
  return { hunk: kept.join('\n'), cut: false };
}

/** A `bisect.found` event's `first.change`, its types checked and its sizes capped; null for one kept before bisect kept changes, or that isn't one. */
export function changeOf(raw: unknown): FoundChange | null {
  if (!isObject(raw)) return null;
  const file = pathOf(raw.file);
  if (!file) return null;
  const files = Array.isArray(raw.files) ? raw.files.map(pathOf).filter((f): f is string => f !== null).slice(0, MAX_FILES) : [];
  const hunk = typeof raw.hunk === 'string' && raw.hunk ? boundedHunk(raw.hunk) : null;
  const line = hunk && typeof raw.line === 'number' && Number.isSafeInteger(raw.line) && raw.line > 0 ? raw.line : null;
  return { file, files: files.includes(file) ? files : [file, ...files].slice(0, MAX_FILES), hunk: hunk?.hunk || null, line, cut: raw.cut === true || !!hunk?.cut, merge: raw.merge === true, path: null, outside: 0 };
}

/** Every answer Find breaking commit gave, by golden, newest first. */
export function bisectAnswers(store: StoreOf<'activity'>): Map<string, AnswerEvent[]> {
  const out = new Map<string, AnswerEvent[]>();
  for (const e of store.listEvents({ kinds: ['bisect.found', 'bisect.none'], limit: 500 })) {
    if (!e.ref) continue;
    const raw = (e.data ?? {}) as { answered?: { at?: unknown; ok?: unknown } | null };
    const answered = raw.answered && typeof raw.answered.at === 'number' && typeof raw.answered.ok === 'boolean' ? { at: raw.answered.at, ok: raw.answered.ok } : null;
    let answer: BisectAnswer;
    if (e.kind === 'bisect.none') {
      const d = (e.data ?? {}) as { why?: unknown; good?: unknown; bad?: unknown; outcome?: unknown };
      const outcome = typeof d.outcome === 'string' && MISS_OUTCOMES.has(d.outcome) ? (d.outcome as BisectMiss['outcome']) : null;
      answer = { found: null, missed: { why: String(d.why ?? 'no first bad commit'), good: typeof d.good === 'string' ? d.good : null, bad: typeof d.bad === 'string' ? d.bad : null, outcome, at: e.at } };
    } else {
      const d = e.data as { first?: { rev?: unknown; subject?: unknown; author?: unknown; date?: unknown; change?: unknown }; why?: unknown; untested?: unknown; replays?: unknown; tokens?: unknown } | null;
      if (typeof d?.first?.rev !== 'string') continue;
      const untested = Array.isArray(d.untested) ? d.untested.filter((x): x is string => typeof x === 'string') : [];
      answer = { found: { rev: d.first.rev, subject: String(d.first.subject ?? ''), author: String(d.first.author ?? ''), date: String(d.first.date ?? ''), why: String(d.why ?? ''), untested, replays: Number(d.replays ?? 0), tokens: Number(d.tokens ?? 0), at: e.at, change: changeOf(d.first.change) }, missed: null };
    }
    const list = out.get(e.ref);
    if (list) list.push({ answer, at: e.at, answered });
    else out.set(e.ref, [{ answer, at: e.at, answered }]);
  }
  return out;
}

/** A committed revision to bisect from: `abc1234+dirty` was tested with changes on top of abc1234. */
export const committed = (rev: string | null) => (rev ? rev.replace(/\+dirty$/, '') : null);

/** Two names of one commit: a short sha and a longer one, or the same. */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * What Find breaking commit said about the failure a golden shows, newest first: an answer stands only
 * for the failures since the golden last passed, and only when it answered one of them. One given
 * while the golden passed (a search from an old replay's page, or one still running when a session
 * passed it) is about a failure that is over, however it fails next. A search that found it passing
 * at the commit it fails at (`passes-at-bad`) stands only while it fails at that commit: once the
 * failure is committed, there is a commit to find again.
 */
export function standingAnswer(answers: readonly AnswerEvent[] | undefined, history: readonly TestResult[], latest: TestResult): BisectAnswer | null {
  if (!answers?.length) return null;
  // Newest first: the failures since the newest pass, the oldest of them where this streak began.
  const pass = history.findIndex((r) => r.ok);
  const began = (pass < 0 ? history : history.slice(0, pass)).at(-1)?.at;
  if (began === undefined) return null;
  const failsAt = committed(latest.revision);
  for (const a of answers) {
    if (a.answered ? a.answered.ok || a.answered.at < began : a.at < began) continue;
    const m = a.answer.missed;
    if (m?.outcome === 'passes-at-bad' && m.bad && failsAt && !sameCommit(m.bad, failsAt)) continue;
    return a.answer;
  }
  return null;
}

/** The first bad commit Find breaking commit named for the failure golden `path` shows now, by the one rule (standingAnswer); null with none. */
export function standingFound(store: StoreOf<'tests' | 'activity'>, path: string): FoundCommit | null {
  const history = store.listTestResults({ golden: path, limit: GOLDEN_HISTORY });
  return history[0] ? (standingAnswer(bisectAnswers(store).get(path), history, history[0])?.found ?? null) : null;
}

/** What holds Find breaking commit on a run, as `bisectChoices` works it out (src/tests.ts). */
interface BisectHold {
  /** The golden a test replay is bisected as, or null for a run bisected as it is. */
  golden: string | null;
  /** A signal cut the replay short: it has no result. */
  cut: boolean;
  /** Its golden came out inconclusive in the replay's session. */
  unsure: boolean;
  /** The label of a check of the run's own that could not be decided, for a run that failed nothing. */
  undecided: string | null;
  /** Forked, it failed a check bisect can't know: none on the command line, from the config or from blame. */
  unjudged: boolean;
}

/**
 * Why Find breaking commit can't start from a run, the first reason that applies, and whether it sends
 * you to Tests (`onTests`: the golden of a replay cut short, or one that came out inconclusive), whose
 * toast then offers Open Tests; null when it can.
 */
export function bisectBlock(run: RunRecord, h: BisectHold): { reason: string; onTests?: true } | null {
  if (run.status === 'running') return { reason: 'this run is still recording' };
  // A test replay a signal cut short has no result: it says nothing about its golden either way.
  if (h.golden !== null && h.cut) return { reason: `this replay was cut short, so it says nothing about ${h.golden}: find the breaking commit from the golden on Tests`, onTests: true };
  if (h.golden !== null && h.unsure) return { reason: `${h.golden} came out inconclusive in this replay's session, neither passed nor failed, so there is no breaking commit to find: Tests says what settles it`, onTests: true };
  if (h.undecided !== null) return { reason: `this run is inconclusive, neither passed nor failed: a check could not be decided (${h.undecided}), so there is no breaking commit to find` };
  if (h.golden === null && !hasRecordedCommand(run)) return { reason: `this run ${withoutCommand(run)}, so there is no command to run at each commit: replay it once with your agent (shadowlap replay ${run.runId} -- <command>) and find the commit from that run` };
  // Someone else chose its command, and bisect would run it at every commit: the CLI asks first, which a job can't.
  if (h.golden === null && commandIsImported(run)) return { reason: `this run came from ${importedCommandSource(run)}: bisect would run its command at every commit. Replay it with your own command first (shadowlap replay ${run.runId} -- <command>), and find the commit from that run` };
  // Replayed with --fork, only the exit status and the checks decide; the CLI takes the checks of the
  // golden it was a replay of from the config, and has none otherwise.
  if (h.unjudged) return { reason: `this run failed a check that bisect can't know: give it on the command line, shadowlap bisect ${run.runId} --good <commit> --expect '<checks>' --fork` };
  return null;
}
