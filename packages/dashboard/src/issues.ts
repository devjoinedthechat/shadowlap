import { blameStateWord, fixAmong, type FixRecords, type FixStatus, goldenWords, isObject, lostWords, shownBlame, shortRunId, type Store, type StoredFix, type TestResult } from '@shadowlap/engine';
import { withExitCodes } from './exit-codes.js';
import { failedWords, NOT_BLAMED, plantedWords } from './failed-words.js';
import { failedOf, openingTitles } from './fix-list.js';
import { keptFixRecords } from './fix-records.js';
import { brokenOf, type FixPr, type FixRung, isUnblamedFailure, prOf, rungOf } from './fix-shared.js';
import { issueKey } from './issue-keys.js';
import { failureKey, fixesByFailure, goldenStep, listedStep, type NextStep, type NextStepWork, openFixStep, stepReads, type StepReads } from './next-step.js';
import { answer, failed as refused, type ReadAnswer, type ReadTable } from './read-registry.js';
import { type IndexedRun, loadRunIndex, type RunIndex } from './run-index.js';
import { judgeAfter, judgedRows, judgeFor, judgeRun, type OutcomeWork, parseWork, type RunJudged } from './run-outcome.js';
import { fixedByOf, listFailed } from './runs-filter.js';
import { matchedRuns, ROW_CALLS_BUDGET, rows, type RunFilter, type RunRow, type RunsPage } from './runs-list.js';
import { resultLine, shortReason } from './tests.js';
import { unblamedBlameCard } from './unblamed-words.js';

/*
 * Runs › Failed as issues: the failed runs the filter and the days keep, grouped by what they share
 * (`issueKeyOf`), the issues ordered by their newest run. A fix and the runs that failed its check,
 * whether the fix's failing runs list them or they failed the same way; a golden and its failed
 * replays; the runs that failed after a planted instruction; and what failed otherwise. Worked out
 * beside the server: it reads every failed run.
 */

export type IssueKind = 'fix' | 'test' | 'planted' | 'capture' | 'today' | 'failure';

/** A run under an issue: what its icon, its Status and its about line read, without the totals a row of the table adds up, its step, or who made it. */
export type IssueRun = Omit<RunRow, 'author' | 'spent' | 'saved' | 'captured' | 'origins' | 'warming' | 'next'> & { exitCode?: number };

export interface Issue {
  key: string;
  kind: IssueKind;
  /** The fix's title, `Failed after a planted instruction`, or what failed; null for a golden's, which its name and what it did title. */
  title: string | null;
  /** A golden's: its path and name, what its newest failed replay did (Tests' words), and whether its last result passed. */
  golden: { path: string; name: string; did: string; passed: boolean } | null;
  /** What failed: a fix's as its row on Fixes says it, where that isn't its title (fix-list.ts `failedOf`), else what the newest run failed on (failed-words.ts). */
  failed: string;
  /** A golden's, beside what it did, in Tests' words: the path its replay diverged on (`code`) and what the value looks like (`text`), the last line its agent exited with (`code`), or the check it failed (`text`). */
  detail: IssueDetail | null;
  /** Where the instruction was planted, the call whose result it went into named as the run's page names it (failed-words.ts `plantedWords`). */
  planted: string | null;
  /** Where the fix's blame found it lost (engine `lostWords`), once it did. */
  lost: string | null;
  /** For a failure no fix holds, not a capture's: `not blamed yet` while none of its runs has a blame, else what the newest blame came to. */
  blame: string | null;
  /** Its runs that are captures, from production. */
  production: number;
  /** Its runs the view keeps, and the first and the last of them to start. */
  count: number;
  first: number;
  last: number;
  /** Its newest run: its about line, and `today` where checks that came after it was recorded judged it. */
  newest: { runId: string; about: RunRow['about'] | null; today?: true };
  /**
   * Open (the job's `open`): its newest runs, newest first, `ISSUE_RUNS` at most, and the run the
   * next ask starts after (`more`). Closed, it carries its count alone, both null: its count asks
   * for its newest runs (`issue` with no cursor).
   */
  runs: IssueRun[] | null;
  more: string | null;
  /** The fix's place on the ladder, as Fixes' row reads it (ui/fixes/list.ts `rungStatus`). */
  fix: { fixId: string; title: string; rung: FixRung; pr: FixPr | null; broken: string | null; status: FixStatus } | null;
  /** Of its runs that joined it by what failed, those nobody has blamed (fix-shared.ts `isUnblamedFailure`). */
  notBlamed: number;
  /** What it leads with: a run's next step (`stepRun`'s), the golden's, or Open fix; null where the page draws a link (Open run, Open Tests). */
  step: NextStep | null;
  stepRun: string | null;
}

/** What a golden's failed replay did, past its title: code (a path, an exit's last line) and words. */
export interface IssueDetail {
  code: string | null;
  text: string | null;
}

export interface IssuesPage extends Pick<RunsPage, 'warming' | 'indexing'> {
  issues: Issue[];
  /** Failed runs the filter and the days keep, in all its issues. */
  total: number;
}

/** One issue's runs (`issue`): its newest, or with `cursor` those after it. */
export interface IssueRunsPage {
  runs: IssueRun[];
  more: string | null;
  count: number;
}

/** The runs an issue carries, and asks for at a time. */
export const ISSUE_RUNS = 50;

/** The most of an issue's runs nobody has blamed whose steps are asked, newest first, for one to lead with Run blame. */
const STEP_TRIES = 5;

/** Failed's issues under the filter and the days, those the page shows open (`open`, by key) with their runs; with `issue`, its runs (IssueRunsPage). */
export type RunsIssuesJob = { kind: 'runs-issues'; options: Pick<RunFilter, 'from' | 'to' | 'q'>; issue?: string | null; cursor?: string | null; open?: readonly string[] | null; outcome?: OutcomeWork | null; next?: NextStepWork | null };

// ---- the issue a run belongs to ----

/** How a failed run joined its issue: a fix's failing runs list it (`link`), it failed as a fix's check does (`words`), or neither. */
interface Joined {
  key: string;
  by: 'link' | 'words' | null;
  /** What it failed on (failed-words.ts). */
  failed: string;
}

interface Grouping {
  stamp: string;
  joined: ReadonlyMap<string, Joined>;
  records: ReadonlyMap<string, FixRecords>;
  /** Each fix's issue runs on every day, newest first. */
  byFix: ReadonlyMap<string, string[]>;
  /** The failed runs nobody has blamed (fix-shared.ts `isUnblamedFailure`), of those no fix's failing runs list. */
  unblamed: ReadonlySet<string>;
}

const planting = (i: unknown): i is { kind: 'plant'; at: number | null } => isObject(i) && (i.kind === 'plant' || (typeof i.flag === 'string' && i.flag.startsWith('--inject-result')));

/** A fork made to see what the agent does with an instruction planted in what a tool returned (`--inject-result`), or an injection test's attempt. `--inject`, a what-if of your own, isn't planted. */
const isPlanted = (r: IndexedRun): boolean => !!r.meta.injection || (r.meta.interventions ?? []).some(planting);

/** A failure of the run's own, or its import's: what a fix's check is matched against. */
const ownFailure = (r: IndexedRun): boolean => r.failed || r.meta.judged === 'failed';

/** The fix whose failing runs list the run, as engine `fixOfRun` picks it (`fixAmong`), from every fix's failing runs read once. */
function linkedFix(records: readonly FixRecords[]): (runId: string) => StoredFix | null {
  const byRun = new Map<string, StoredFix[]>();
  for (const rec of records) {
    for (const runId of rec.failing) {
      const fixes = byRun.get(runId);
      if (fixes) fixes.push(rec.fix);
      else byRun.set(runId, [rec.fix]);
    }
  }
  return (runId) => fixAmong(byRun.get(runId) ?? []);
}

/** The ways a run joins a fix's issue: its failing runs, or the failure it holds. */
const waysOf = (list: readonly FixRecords[]) => ({ linked: linkedFix(list), byWords: fixesByFailure(list.map((rec) => rec.fix)) });

/**
 * The issue of a run, in order: the fix whose failing runs list it; the fix that holds the same
 * failure, unless the run is planted or fails only its family's checks (`family`); its golden, for a
 * test replay; the planted runs'; else what failed, by kind.
 */
function joinOf(store: Store, r: IndexedRun, f: { linked: (runId: string) => StoredFix | null; byWords: (failed: string) => StoredFix | null; family?: RunJudged | null }): Joined {
  const own = ownFailure(r);
  const failed = own ? failedWords(r, { capture: r.meta.judged === 'failed' ? store.getRun(r.runId) : null }) : failedWords(r, { family: f.family ?? null });
  const linked = f.linked(r.runId);
  if (linked) return { key: issueKey.fix(linked.fixId), by: 'link', failed };
  const planted = isPlanted(r);
  const fix = own && !planted ? f.byWords(failed) : null;
  if (fix) return { key: issueKey.fix(fix.fixId), by: 'words', failed };
  if (r.meta.test) return { key: issueKey.golden(r.meta.test.golden), by: null, failed };
  if (planted) return { key: issueKey.planted(), by: null, failed };
  return { key: issueKey.failure(!own ? 'today' : r.kind === 'capture' ? 'cap' : 'fail', failureKey(failed)), by: null, failed };
}

const groupingKept = new WeakMap<object, Grouping>();

/** What a grouping is kept until: runs, fixes (a blame or a link among them) or the tests' results move. */
function stampOf(store: Store, index: RunIndex): string {
  const counts = store.changeCounts();
  return `${index.revision}|${index.runs.length}|${counts.fixes ?? 0}|${counts.tests ?? 0}`;
}

/** Whether nobody has blamed a failed run no fix lists: a blame on its record or in the store says otherwise. */
function unblamedRun(store: Store, index: RunIndex, r: IndexedRun): boolean {
  if (r.meta.blame) return false;
  const run = store.getRun(r.runId);
  return !!run && isUnblamedFailure(store, run, index);
}

/**
 * Every failed run's issue, on every day, and which of them nobody has blamed, kept until runs,
 * fixes or the tests' results move: a run failing only its family's checks is judged, so it joins
 * its issue as a read reaches it.
 */
function grouping(store: Store, index: RunIndex): Grouping {
  const stamp = stampOf(store, index);
  const kept = groupingKept.get(index);
  if (kept?.stamp === stamp) return kept;
  const fixed = fixedByOf(store, index);
  const list = keptFixRecords(store);
  const ways = waysOf(list);
  const joined = new Map<string, Joined>();
  const byFix = new Map<string, string[]>();
  const unblamed = new Set<string>();
  for (const r of index.runs) {
    if (r.bundled || !listFailed(r, fixed)) continue;
    const j = joinOf(store, r, ways);
    joined.set(r.runId, j);
    // A run a fix's failing runs list is that fix's, so blamed.
    if (j.by !== 'link' && unblamedRun(store, index, r)) unblamed.add(r.runId);
    if (!j.by) continue;
    const fixId = j.key.slice('fix:'.length);
    const runs = byFix.get(fixId);
    if (runs) runs.push(r.runId);
    else byFix.set(fixId, [r.runId]);
  }
  const g: Grouping = { stamp, joined, records: new Map(list.map((rec) => [rec.fix.fixId, rec])), byFix, unblamed };
  groupingKept.set(index, g);
  return g;
}

/** Each fix's issue runs, on every day and with no filter, newest first: what Fixes counts and links to. */
export function issueRunsByFix(store: Store, index: RunIndex = loadRunIndex(store)): ReadonlyMap<string, readonly string[]> {
  return grouping(store, index).byFix;
}

/** The runs that failed a fix's check, as its issue holds them on every day: how many, and the first five by id, short. */
export interface FailedCheck {
  count: number;
  ids: string[];
}

/**
 * Each fix's failing-runs card on Fixes and on its page, from one grouping for every fix
 * (`issueRunsByFix`): null where its issue holds no run (each fixed or deleted since), so the card
 * keeps the fix's own. The link's words keep the fix's own count, as the CLI and Verify say it.
 */
export function failedChecks(store: Store, index: RunIndex): (fixId: string) => FailedCheck | null {
  const byFix = issueRunsByFix(store, index);
  return (fixId) => {
    const ids = byFix.get(fixId) ?? [];
    return ids.length ? { count: ids.length, ids: ids.slice(0, 5).map(shortRunId) } : null;
  };
}

/** The issue a failed run is under on Runs › Failed; null for a run Failed doesn't count, or one that fails only its family's checks. */
export function issueKeyOf(store: Store, index: RunIndex, runId: string): string | null {
  return grouping(store, index).joined.get(runId)?.key ?? null;
}

/**
 * The same for a row that names one run (Needs a look's): the kept grouping's where it is kept,
 * else that run's own join, which groups no other run.
 */
export function issueKeyOfRun(store: Store, index: RunIndex, runId: string): string | null {
  const kept = groupingKept.get(index);
  if (kept?.stamp === stampOf(store, index)) return kept.joined.get(runId)?.key ?? null;
  const r = index.byId.get(runId);
  if (!r || r.bundled || !listFailed(r, fixedByOf(store, index))) return null;
  return joinOf(store, r, waysOf(keptFixRecords(store))).key;
}

// ---- an issue's fields ----

interface Member {
  r: IndexedRun;
  j: Joined;
}

interface IssueWork {
  store: Store;
  index: RunIndex;
  g: Grouping;
  next: NextStepWork | null;
  reads: StepReads;
  /** The rows the answer reads, by run id: an open issue's runs, and each issue's newest and those its step is asked of (`rowRuns`). */
  shown: ReadonlyMap<string, IssueRun>;
  /** The titles fixes were opened with, read once if a fix's was edited since (fix-list.ts `openingTitles`). */
  opening: () => ReadonlyMap<string, string>;
}

const kindOf = (key: string): IssueKind => {
  const [kind] = key.split(':', 1) as [string];
  return kind === 'fix' ? 'fix' : kind === 'test' ? 'test' : kind === 'plant' ? 'planted' : kind === 'cap' ? 'capture' : kind === 'today' ? 'today' : 'failure';
};

/** Those of these runs nobody has blamed, newest first, as the kept grouping found them. */
const unblamedOf = (w: IssueWork, members: readonly Member[]): Member[] => members.filter((m) => w.g.unblamed.has(m.r.runId));

/** Of a fix's runs, those that joined it by what failed and nobody has blamed, newest first: its `notBlamed`, and the runs its Run blame is tried on. */
const fixUnblamed = (g: Grouping, members: readonly Member[]): Member[] => members.filter((m) => m.j.by === 'words' && g.unblamed.has(m.r.runId));

/** Run blame on the newest of these runs whose page leads with it, with the card that names it; null where none does. */
function blameStepOf(w: IssueWork, unblamed: readonly Member[]): { step: NextStep; stepRun: string } | null {
  for (const m of unblamed.slice(0, STEP_TRIES)) {
    const step = listedStep(w.store, m.r.runId, w.next, { judged: w.shown.get(m.r.runId)?.judged, reads: w.reads });
    if (step?.key === 'blame') return { step: { ...step, sub: unblamedBlameCard(unblamed.length, shortRunId(m.r.runId)) }, stepRun: m.r.runId };
  }
  return null;
}

/** A golden's newest failed replay as Tests words its result: what it did, and the rest of its line. */
function goldenOf(w: IssueWork, path: string, newest: Member): Issue['golden'] & { detail: IssueDetail | null } {
  const results: readonly TestResult[] = w.reads.results(path);
  const result = results.find((x) => x.runId === newest.r.runId);
  const did = result ? shortReason(result).replace(/^check failed: /, '') : newest.j.failed;
  const line = result ? resultLine(result, []).replace(/^check failed: /, '') : null;
  return { path, name: goldenWords(path), did, passed: results[0]?.ok === true, detail: detailOf(result?.failure ?? null, line, did) };
}

/** What a result's line says beyond what it did: the path it diverged on, then what the value looks like; the last line the agent exited with; the check it failed. */
function detailOf(failure: string | null, line: string | null, did: string): IssueDetail | null {
  if (failure === 'check') return line && line !== did ? { code: null, text: line } : null;
  const rest = restOf(line, did);
  if (!rest) return null;
  if (failure === 'exit') return { code: rest, text: null };
  if (failure !== 'diverged') return { code: null, text: rest };
  // `$.metadata.user_id looks like a UUID`: a path has no space in it.
  const sp = rest.indexOf(' ');
  return sp < 0 ? { code: rest, text: null } : { code: rest.slice(0, sp), text: rest.slice(sp + 1) };
}

/** What a result's line says after what it did, its parenthesis left out. */
function restOf(line: string | null, did: string): string | null {
  const at = line ? line.indexOf(did) : -1;
  if (!line || at < 0) return line;
  const rest = line.slice(at + did.length).replace(/^\s*[·:,]?\s*/, '');
  return rest && !rest.startsWith('(') ? rest : null;
}

function fixOf(rec: FixRecords): NonNullable<Issue['fix']> {
  return { fixId: rec.fix.fixId, title: rec.fix.title, rung: rungOf(rec), pr: prOf(rec), broken: brokenOf(rec), status: rec.fix.status };
}

function lostOf(rec: FixRecords): string | null {
  const b = shownBlame(rec);
  return b?.outcome === 'blamed' && b.report.blamed ? lostWords(b.report.blamed.callNo, b.report.range, 'calls') : null;
}

/** For a failure no fix holds: how its newest blame came out, in a list's one word, or that nobody has blamed it. */
function blameWords(members: readonly Member[]): string | null {
  const b = members.find((m) => m.r.meta.blame)?.r.meta.blame;
  if (!b) return NOT_BLAMED;
  return b.outcome === 'unrescuable' || b.outcome === 'stopped' ? blameStateWord(b.outcome, b.unsettled) : null;
}

/** Where the newest run that says so planted its instruction, reading the one call it planted in for its tool's name. */
function plantedOf(store: Store, members: readonly Member[]): Issue['planted'] {
  for (const m of members) {
    const at = (m.r.meta.interventions ?? []).find(planting)?.at;
    if (typeof at === 'number') return plantedWords(at, store.getCalls(m.r.runId, { only: [at] })[0]?.name ?? null);
  }
  return null;
}

/** What the issue leads with, and the runs nobody has blamed among those that joined it by what failed. */
function leadOf(w: IssueWork, kind: IssueKind, members: readonly Member[], rec: FixRecords | null, golden: string | null): Pick<Issue, 'step' | 'stepRun' | 'notBlamed'> {
  const newest = members[0]!.r.runId;
  if (kind === 'fix') {
    const unblamed = fixUnblamed(w.g, members);
    const blame = blameStepOf(w, unblamed);
    return { ...(blame ?? { step: rec ? openFixStep(rec.fix) : null, stepRun: null }), notBlamed: unblamed.length };
  }
  if (kind === 'test') {
    // Its replay's own step acts on the replay its newest result made; Run more attempts is Tests' alone.
    const step = goldenStep(w.store, golden!, w.next, w.reads);
    return { step, stepRun: step && step.key !== 'more-attempts' ? (w.reads.results(golden!)[0]?.runId ?? null) : null, notBlamed: 0 };
  }
  if (kind === 'today') return { step: null, stepRun: newest, notBlamed: 0 };
  const unblamed = unblamedOf(w, members);
  const step = listedStep(w.store, newest, w.next, { judged: w.shown.get(newest)?.judged, reads: w.reads }) ?? null;
  // Run blame's card names the run it blames, a capture's too, whose page asks for your command first.
  return { step: step?.key === 'blame' ? { ...step, sub: unblamedBlameCard(unblamed.length, shortRunId(newest)) } : step, stepRun: newest, notBlamed: unblamed.length };
}

/** A fix's failure as its row on Fixes says it beside its title, else what its newest run failed on. */
function fixFailed(w: IssueWork, rec: FixRecords, newest: Member): string {
  const said = failedOf(rec, w.opening)?.trim();
  return said && said.toLowerCase() !== rec.fix.title.trim().toLowerCase() ? said : newest.j.failed;
}

/** An issue's newest run, as its line and its title read it. */
function newestOf(w: IssueWork, runId: string): Issue['newest'] {
  const row = w.shown.get(runId);
  return { runId, about: row?.about ?? null, ...(row?.judged?.today ? { today: true as const } : {}) };
}

function issueOf(w: IssueWork, key: string, members: readonly Member[], open: boolean): Issue {
  const kind = kindOf(key);
  const newest = members[0]!;
  const rec = kind === 'fix' ? (w.g.records.get(key.slice('fix:'.length)) ?? null) : null;
  const golden = kind === 'test' ? goldenOf(w, key.slice('test:'.length), newest) : null;
  const shown = open ? members.slice(0, ISSUE_RUNS) : null;
  const title = rec ? rec.fix.title : kind === 'planted' ? 'Failed after a planted instruction' : golden ? null : newest.j.failed;
  return {
    key,
    kind,
    title,
    golden: golden ? { path: golden.path, name: golden.name, did: golden.did, passed: golden.passed } : null,
    failed: rec ? fixFailed(w, rec, newest) : newest.j.failed,
    detail: golden?.detail ?? null,
    planted: kind === 'planted' ? plantedOf(w.store, members) : null,
    lost: rec ? lostOf(rec) : null,
    blame: kind === 'failure' ? blameWords(members) : null,
    production: members.filter((m) => m.r.kind === 'capture').length,
    count: members.length,
    first: members[members.length - 1]!.r.startedAt,
    last: newest.r.startedAt,
    newest: newestOf(w, newest.r.runId),
    runs: shown ? shown.flatMap((m) => w.shown.get(m.r.runId) ?? []) : null,
    more: shown && members.length > ISSUE_RUNS ? shown[shown.length - 1]!.r.runId : null,
    fix: rec ? fixOf(rec) : null,
    ...leadOf(w, kind, members, rec, golden?.path ?? null),
  };
}

// ---- the read ----

/**
 * The runs whose rows an issue's read takes: an open issue's newest `ISSUE_RUNS`, which it carries,
 * else its newest, which its line and its step read; and a fix's runs its Run blame is tried on.
 */
function rowRuns(g: Grouping, key: string, members: readonly Member[], open: boolean): IndexedRun[] {
  const tried = kindOf(key) === 'fix' ? fixUnblamed(g, members).slice(0, STEP_TRIES) : [];
  return [...new Set([...(open ? members.slice(0, ISSUE_RUNS) : members.slice(0, 1)), ...tried].map((m) => m.r))];
}

/** Rows for these runs, as the table's read builds its own (read-jobs.ts `runsPage`) without the totals, judged within the rows' budget. */
function issueRuns(store: Store, index: RunIndex, runs: readonly IndexedRun[], outcome: OutcomeWork | null, whole: boolean): Map<string, IssueRun> {
  const listed = withExitCodes(store, judgedRows(store, rows(store, index, runs, { known: !whole, totals: false }), outcome, whole ? Infinity : ROW_CALLS_BUDGET, { checks: true }));
  return new Map(
    listed.map((row) => {
      const { author: _author, spent: _spent, saved: _saved, captured: _captured, origins: _origins, warming: _warming, ...run } = row;
      return [row.runId, run];
    }),
  );
}

/** The Failed runs the filter and the days keep, newest first, each with its issue, the issues in the order of their newest run. */
function grouped(store: Store, index: RunIndex, runs: readonly IndexedRun[], outcome: OutcomeWork | null): Map<string, Member[]> {
  const g = grouping(store, index);
  const w = parseWork(outcome);
  let ways: Parameters<typeof joinOf>[2] | null = null;
  const groups = new Map<string, Member[]>();
  for (const r of runs) {
    let j = g.joined.get(r.runId);
    if (!j) {
      // Failed by its family's checks alone: judged already, by the filter that kept it.
      ways ??= waysOf([...g.records.values()]);
      j = joinOf(store, r, { ...ways, family: judgeRun(store, index, r.runId, w, { quick: true }) ?? null });
    }
    const members = groups.get(j.key);
    if (members) members.push({ r, j });
    else groups.set(j.key, [{ r, j }]);
  }
  return groups;
}

/**
 * Where an issue's next page starts: after the run its last page ended on (`cursor`), in the order
 * its runs are listed (newest first, then by id), where that run has left the issue since too, as
 * a delete or a narrower filter leaves it. -1 for a run the store no longer holds.
 */
function startAfter(index: RunIndex, members: readonly Member[], cursor: string): number {
  const at = members.findIndex((x) => x.r.runId === cursor);
  if (at >= 0) return at + 1;
  const c = index.byId.get(cursor);
  if (!c) return -1;
  const next = members.findIndex((x) => x.r.startedAt < c.startedAt || (x.r.startedAt === c.startedAt && x.r.runId < c.runId));
  return next < 0 ? members.length : next;
}

function issuesAnswer(store: Store, job: RunsIssuesJob, whole: boolean): ReadAnswer {
  const index = loadRunIndex(store);
  const outcome = job.outcome ?? null;
  const m = matchedRuns(store, { ...job.options, types: ['failed'], known: !whole, judge: judgeFor(store, outcome) });
  const groups = grouped(store, index, m.runs, outcome);
  if (job.issue != null) {
    const members = groups.get(job.issue) ?? [];
    const from = job.cursor ? startAfter(index, members, job.cursor) : 0;
    if (from < 0) return refused(409, 'The run the last page ended on is gone: read the issues again');
    const page = members.slice(from, from + ISSUE_RUNS);
    const shown = issueRuns(store, index, page.map((x) => x.r), outcome, whole);
    const runs = page.flatMap((x) => shown.get(x.r.runId) ?? []);
    return answer({ runs, more: from + ISSUE_RUNS < members.length ? page[page.length - 1]!.r.runId : null, count: members.length } satisfies IssueRunsPage, { tagged: true });
  }
  // A closed issue carries its count alone: of its runs, the read takes only those its line and its step read.
  const open = new Set(job.open ?? []);
  const g = grouping(store, index);
  const shown = issueRuns(store, index, [...groups].flatMap(([key, members]) => rowRuns(g, key, members, open.has(key))), outcome, whole);
  const w: IssueWork = { store, index, g, next: job.next ?? null, reads: stepReads(store, index), shown, opening: openingTitles(store) };
  const issues = [...groups].map(([key, members]) => issueOf(w, key, members, open.has(key)));
  const page: IssuesPage = { issues, total: m.runs.length, ...(m.warming ? { warming: m.warming } : {}), ...(m.indexing ? { indexing: m.indexing } : {}) };
  return { ...answer(page, { tagged: true }), ...judgeAfter(m.judgeAfter, outcome) };
}

export const ISSUES_READS: ReadTable<RunsIssuesJob> = {
  'runs-issues': (store, job, { whole }) => issuesAnswer(store, job, whole),
};
