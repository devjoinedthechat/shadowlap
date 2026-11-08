import { blameStateWord, type FixRecords, type FixStatus, goldenWords, isObject, lostWords, shownBlame, shortRunId, type Store, type StoredFix, type TestResult } from '@shadowlap/engine';
import { withExitCodes } from './exit-codes.js';
import { blameCard, failedWords, NOT_BLAMED, plantedWords } from './failed-words.js';
import { keptFixRecords } from './fix-records.js';
import { brokenOf, type FixPr, type FixRung, isUnblamedFailure, prOf, rungOf } from './fix-shared.js';
import { issueKey } from './issue-keys.js';
import { failureKey, fixesByFailure, goldenStep, listedStep, type NextStep, type NextStepWork, openFixStep, stepReads, type StepReads } from './next-step.js';
import { answer, type ReadAnswer, type ReadTable } from './read-registry.js';
import { type IndexedRun, loadRunIndex, type RunIndex } from './run-index.js';
import { judgeAfter, judgedRows, judgeFor, judgeRun, type OutcomeWork, parseWork, type RunJudged } from './run-outcome.js';
import { fixedByOf, listFailed } from './runs-filter.js';
import { matchedRuns, ROW_CALLS_BUDGET, rows, type RunFilter, type RunRow, type RunsPage } from './runs-list.js';
import { resultLine, shortReason } from './tests.js';

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
  /** What the newest run failed on (failed-words.ts). */
  failed: string;
  /** A golden's: where its replay diverged and what the value looks like, or what it failed on, as Tests says it beside what it did. */
  detail: string | null;
  /** Where the instruction was planted, the call whose result it went into named as the run's page names it (failed-words.ts `plantedWords`). */
  planted: string | null;
  /** Where the fix's blame found it lost (engine `lostWords`), once it did. */
  lost: string | null;
  /** For a failure no fix holds: `not blamed yet` while none of its runs has a blame, else what the newest blame came to. */
  blame: string | null;
  /** Its runs that are captures, from production. */
  production: number;
  /** Its runs the view keeps, and the first and the last of them to start. */
  count: number;
  first: number;
  last: number;
  newest: { runId: string; about: RunRow['about'] | null };
  /** Its newest runs, newest first, `ISSUE_RUNS` at most; `more` asks for the next. */
  runs: IssueRun[];
  more: string | null;
  /** The fix's place on the ladder, as Fixes' row reads it (ui/fixes/list.ts `rungStatus`). */
  fix: { fixId: string; title: string; rung: FixRung; pr: FixPr | null; broken: string | null; status: FixStatus } | null;
  /** Of its runs that joined it by what failed, those nobody has blamed (fix-shared.ts `isUnblamedFailure`). */
  notBlamed: number;
  /** What it leads with: a run's next step (`stepRun`'s), the golden's, or Open fix; null where the page draws a link (Open run, Open Tests). */
  step: NextStep | null;
  stepRun: string | null;
}

export interface IssuesPage extends Pick<RunsPage, 'warming' | 'indexing'> {
  issues: Issue[];
  /** Failed runs the filter and the days keep, in all its issues. */
  total: number;
}

/** One issue's next runs (`issue` and `cursor`). */
export interface IssueRunsPage {
  runs: IssueRun[];
  more: string | null;
  count: number;
}

/** The runs an issue carries, and asks for at a time. */
export const ISSUE_RUNS = 50;

/** The most of an issue's runs nobody has blamed whose steps are asked, newest first, for one to lead with Run blame. */
const STEP_TRIES = 5;

export type RunsIssuesJob = { kind: 'runs-issues'; options: Pick<RunFilter, 'from' | 'to' | 'q'>; issue?: string | null; cursor?: string | null; outcome?: OutcomeWork | null; next?: NextStepWork | null };

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
}

const planting = (i: unknown): i is { kind: 'plant'; at: number | null } => isObject(i) && (i.kind === 'plant' || (typeof i.flag === 'string' && i.flag.startsWith('--inject-result')));

/** A fork made to see what the agent does with an instruction planted in what a tool returned (`--inject-result`), or an injection test's attempt. `--inject`, a what-if of your own, isn't planted. */
const isPlanted = (r: IndexedRun): boolean => !!r.meta.injection || (r.meta.interventions ?? []).some(planting);

/** A failure of the run's own, or its import's: what a fix's check is matched against. */
const ownFailure = (r: IndexedRun): boolean => r.failed || r.meta.judged === 'failed';

/** The fix whose failing runs list the run, as engine `fixOfRun` picks it: the newest not yet applied, else the newest. */
function linkedFix(records: readonly FixRecords[]): (runId: string) => StoredFix | null {
  const byRun = new Map<string, StoredFix[]>();
  for (const rec of records) for (const runId of rec.failing) byRun.set(runId, [...(byRun.get(runId) ?? []), rec.fix]);
  return (runId) => {
    const fixes = [...(byRun.get(runId) ?? [])].sort((a, b) => b.openedAt - a.openedAt);
    return fixes.find((f) => f.status !== 'applied') ?? fixes[0] ?? null;
  };
}

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

/**
 * Every failed run's issue, on every day, kept until runs, fixes or the tests' results move: a run
 * failing only its family's checks is judged, so it joins its issue as a read reaches it.
 */
function grouping(store: Store, index: RunIndex): Grouping {
  const counts = store.changeCounts();
  const stamp = `${index.revision}|${index.runs.length}|${counts.fixes ?? 0}|${counts.tests ?? 0}`;
  const kept = groupingKept.get(index);
  if (kept?.stamp === stamp) return kept;
  const fixed = fixedByOf(store, index);
  const list = keptFixRecords(store);
  const ways = { linked: linkedFix(list), byWords: fixesByFailure(list.map((rec) => rec.fix)) };
  const joined = new Map<string, Joined>();
  const byFix = new Map<string, string[]>();
  for (const r of index.runs) {
    if (r.bundled || !listFailed(r, fixed)) continue;
    const j = joinOf(store, r, ways);
    joined.set(r.runId, j);
    if (j.by) {
      const fixId = j.key.slice('fix:'.length);
      byFix.set(fixId, [...(byFix.get(fixId) ?? []), r.runId]);
    }
  }
  const g: Grouping = { stamp, joined, records: new Map(list.map((rec) => [rec.fix.fixId, rec])), byFix };
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
  /** The rows of the runs the answer carries, by run id. */
  shown: ReadonlyMap<string, IssueRun>;
}

const kindOf = (key: string): IssueKind => {
  const [kind] = key.split(':', 1) as [string];
  return kind === 'fix' ? 'fix' : kind === 'test' ? 'test' : kind === 'plant' ? 'planted' : kind === 'cap' ? 'capture' : kind === 'today' ? 'today' : 'failure';
};

/** Those of these runs nobody has blamed, newest first: a run with a blame in the index needs no read. */
const unblamedOf = (w: IssueWork, members: readonly Member[]): Member[] =>
  members.filter((m) => {
    if (m.r.meta.blame) return false;
    const run = w.store.getRun(m.r.runId);
    return !!run && isUnblamedFailure(w.store, run, w.index);
  });

/** Run blame on the newest of these runs whose page leads with it, with the card that names it; null where none does. */
function blameStepOf(w: IssueWork, unblamed: readonly Member[]): { step: NextStep; stepRun: string } | null {
  for (const m of unblamed.slice(0, STEP_TRIES)) {
    const step = listedStep(w.store, m.r.runId, w.next, { judged: w.shown.get(m.r.runId)?.judged, reads: w.reads });
    if (step?.key === 'blame') return { step: { ...step, sub: blameCard(m.r.runId, unblamed.length > 1) }, stepRun: m.r.runId };
  }
  return null;
}

/** A golden's newest failed replay as Tests words its result: what it did, and the rest of its line. */
function goldenOf(w: IssueWork, path: string, newest: Member): Issue['golden'] & { detail: string | null } {
  const results: readonly TestResult[] = w.reads.results(path);
  const result = results.find((x) => x.runId === newest.r.runId);
  const did = result ? shortReason(result).replace(/^check failed: /, '') : newest.j.failed;
  const line = result ? resultLine(result, []).replace(/^check failed: /, '') : null;
  return { path, name: goldenWords(path), did, passed: results[0]?.ok === true, detail: result?.failure === 'check' ? (line !== did ? line : null) : restOf(line, did) };
}

/** What a result's line says beyond what it did: the path it diverged on and what the value looks like, or what the agent exited with. */
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
    const unblamed = unblamedOf(w, members.filter((m) => m.j.by === 'words'));
    const blame = blameStepOf(w, unblamed);
    return { ...(blame ?? { step: rec ? openFixStep(rec.fix) : null, stepRun: null }), notBlamed: unblamed.length };
  }
  if (kind === 'test') return { step: goldenStep(w.store, golden!, w.next, w.reads), stepRun: null, notBlamed: 0 };
  if (kind === 'today') return { step: null, stepRun: newest, notBlamed: 0 };
  const unblamed = unblamedOf(w, members);
  const step = listedStep(w.store, newest, w.next, { judged: w.shown.get(newest)?.judged, reads: w.reads }) ?? null;
  return { step: step?.key === 'blame' && !step.capture ? { ...step, sub: blameCard(newest, unblamed.length > 1) } : step, stepRun: newest, notBlamed: unblamed.length };
}

function issueOf(w: IssueWork, key: string, members: readonly Member[]): Issue {
  const kind = kindOf(key);
  const newest = members[0]!;
  const rec = kind === 'fix' ? (w.g.records.get(key.slice('fix:'.length)) ?? null) : null;
  const golden = kind === 'test' ? goldenOf(w, key.slice('test:'.length), newest) : null;
  const shown = members.slice(0, ISSUE_RUNS);
  const title = rec ? rec.fix.title : kind === 'planted' ? 'Failed after a planted instruction' : golden ? null : newest.j.failed;
  return {
    key,
    kind,
    title,
    golden: golden ? { path: golden.path, name: golden.name, did: golden.did, passed: golden.passed } : null,
    failed: newest.j.failed,
    detail: golden?.detail ?? null,
    planted: kind === 'planted' ? plantedOf(w.store, members) : null,
    lost: rec ? lostOf(rec) : null,
    blame: kind === 'failure' || kind === 'capture' ? blameWords(members) : null,
    production: members.filter((m) => m.r.kind === 'capture').length,
    count: members.length,
    first: members[members.length - 1]!.r.startedAt,
    last: newest.r.startedAt,
    newest: { runId: newest.r.runId, about: w.shown.get(newest.r.runId)?.about ?? null },
    runs: shown.flatMap((m) => w.shown.get(m.r.runId) ?? []),
    more: members.length > ISSUE_RUNS ? shown[shown.length - 1]!.r.runId : null,
    fix: rec ? fixOf(rec) : null,
    ...leadOf(w, kind, members, rec, golden?.path ?? null),
  };
}

// ---- the read ----

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
      const list = [...g.records.values()];
      ways ??= { linked: linkedFix(list), byWords: fixesByFailure(list.map((rec) => rec.fix)) };
      j = joinOf(store, r, { ...ways, family: judgeRun(store, index, r.runId, w, { quick: true }) ?? null });
    }
    groups.set(j.key, [...(groups.get(j.key) ?? []), { r, j }]);
  }
  return groups;
}

function issuesAnswer(store: Store, job: RunsIssuesJob, whole: boolean): ReadAnswer {
  const index = loadRunIndex(store);
  const outcome = job.outcome ?? null;
  const m = matchedRuns(store, { ...job.options, types: ['failed'], known: !whole, judge: judgeFor(store, outcome) });
  const groups = grouped(store, index, m.runs, outcome);
  if (job.issue != null) {
    const members = groups.get(job.issue) ?? [];
    const from = job.cursor ? members.findIndex((x) => x.r.runId === job.cursor) + 1 : 0;
    const page = members.slice(from, from + ISSUE_RUNS);
    const shown = issueRuns(store, index, page.map((x) => x.r), outcome, whole);
    const runs = page.flatMap((x) => shown.get(x.r.runId) ?? []);
    return answer({ runs, more: from + ISSUE_RUNS < members.length ? page[page.length - 1]!.r.runId : null, count: members.length } satisfies IssueRunsPage, { tagged: true });
  }
  const shown = issueRuns(store, index, [...groups.values()].flatMap((list) => list.slice(0, ISSUE_RUNS).map((x) => x.r)), outcome, whole);
  const w: IssueWork = { store, index, g: grouping(store, index), next: job.next ?? null, reads: stepReads(store, index), shown };
  const issues = [...groups].map(([key, members]) => issueOf(w, key, members));
  const page: IssuesPage = { issues, total: m.runs.length, ...(m.warming ? { warming: m.warming } : {}), ...(m.indexing ? { indexing: m.indexing } : {}) };
  return { ...answer(page, { tagged: true }), ...judgeAfter(m.judgeAfter, outcome) };
}

export const ISSUES_READS: ReadTable<RunsIssuesJob> = {
  'runs-issues': (store, job, { whole }) => issuesAnswer(store, job, whole),
};
