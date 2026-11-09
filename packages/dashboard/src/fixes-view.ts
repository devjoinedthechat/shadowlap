import { checkWords, failedCheckLabels, fixCost, type FixRecords, fixRecords, type FixStatus, type RunRecord, shownBlame, type Store, type StoreOf } from '@shadowlap/engine';
import { fixActions } from './fix-actions.js';
import { fixCrash } from './fix-crash.js';
import { fixLead, type FixLead } from './fix-lead.js';
import { type FixRow, openingTitles, rowOf } from './fix-list.js';
import { checksOf, type FixPr, type FixRung, type PatchCheck, patchToCheck, prOf, type RewriteCheck, rungOf, short, unblamedRuns } from './fix-shared.js';
import { pulledPatchOf } from './fixes.js';
import { type NextStepRow, type NextStepWork, type StepReads, stepReads, stepRow, unblamedListedStep } from './next-step.js';
import { patchesInTree, rewritesHere } from './patch-in-tree.js';
import { answer, type ReadAnswer, type ReadTable } from './read-registry.js';
import { aboutsUpTo, SUMMARY_CALLS_BUDGET } from './run-about.js';
import type { BlameOffer } from './run-offers.js';
import { loadRunIndex, type RunIndex } from './run-index.js';

/**
 * The Fixes page (`GET /api/fixes`): every fix as a to-do list, worked out beside the server's thread
 * (it reads every fix's reports, and the run index for the failing runs nobody has blamed). The open
 * fixes come first, then those ready to apply, then those applied; each row says where the fix
 * stands on one ladder (`rungOf`), which chip it is under, and the step it leads with (fix-lead.ts),
 * as its page leads. Beside the rows: how many each chip holds, what every fix took, and the failed
 * runs nobody has blamed, which lead the list with Run blame. `shadowlap fix ls` keeps its own list,
 * the most recently opened first (fix-list.ts `fixList`).
 */

/** The chip a fix is under: open, ready to apply (verified, not merged), or applied (applied, or shipped with its merged pull request). */
export type FixBucket = 'open' | 'ready' | 'applied';

export interface FixesViewRow extends FixRow {
  rung: FixRung;
  pr: FixPr | null;
  /** The CI it came from, as its source names it (`github`), or null for a fix opened here. */
  ci: string | null;
  bucket: FixBucket;
  /** Its first five failing runs, short, for its link's card. */
  failingIds: string[];
  /** The step it leads with, or null: its row opens it. */
  next: FixLead | null;
}

/** The failed runs nobody has blamed, as one row: how many, the newest, what it was about and what failed in it. */
export interface UnblamedRow {
  count: number;
  /** The newest of them. */
  runId: string;
  /** Its about line, when known within the read's budget. */
  about: string | null;
  /** The first check it failed (a capture's, as its import judged it), in the engine's words; null when it failed by its agent's exit. */
  failed: string | null;
  /** Every check it failed, for Run blame's dialog to ask which. */
  checks: string[];
  /** Where Run blame finds its check (`ask`: its dialog asks for it), as its run page's would; null with no Run blame. */
  from: BlameOffer['from'] | null;
  /** Its next step when that is Run blame, as Needs a look rules it (a capture's opens its page, where blame asks for your command first); null otherwise. */
  next: NextStepRow | null;
}

export interface FixesView {
  /** In to-do order, filtered by `status` when asked. */
  fixes: FixesViewRow[];
  /** Per chip, every fix whatever `status` keeps; `verified` is every fix not open. */
  counts: { all: number; open: number; ready: number; applied: number; verified: number };
  /** Every fix's failing runs, and what blame, repair and verify took for them (a verdict shared by several fixes once). */
  totals: { failing: number; attempts: number; spent: number };
  unblamed: UnblamedRow | null;
}

export interface FixesViewOptions {
  /** As `?status=` keeps the rows: `verified` keeps every fix not open. */
  status?: FixStatus | 'all';
  /** The repairer shadowlap.config.json names, for the repair commands. */
  repairer?: string | null;
  /** What a run's next step reads of the project, for the unblamed row's Run blame. */
  next?: NextStepWork | null;
  patchInTree?: PatchCheck | undefined;
  rewriteHere?: RewriteCheck | undefined;
  /** The most calls the about line reads, as the Overview's request reads them (`SUMMARY_CALLS_BUDGET`); every call when absent. */
  budget?: number | undefined;
}

/**
 * Every fix's records, read once for each change to fixes: the store's `fixes` counter moves whenever
 * a fix, a blame, a repair, a verdict or a pull request's state is written, so a page polled while
 * runs record parses no report again.
 */
const recordsRead = new WeakMap<object, { n: number; records: FixRecords[] }>();

function keptFixRecords(store: StoreOf<'activity' | 'fixes'>): FixRecords[] {
  const n = store.changeCounts().fixes;
  const kept = recordsRead.get(store);
  if (kept && n !== undefined && kept.n === n) return kept.records;
  const records = store.listFixes().map((f) => fixRecords(store, f));
  if (n !== undefined) recordsRead.set(store, { n, records });
  return records;
}

const bucketOf = (rung: FixRung, status: FixStatus): FixBucket => (status === 'open' ? 'open' : status === 'applied' || rung === 'merged' ? 'applied' : 'ready');

/**
 * Where a row goes in the to-do order: open fixes nobody has blamed to a call, then those blamed
 * with no change yet, then those with one; then ready to apply; then applied, one that doesn't hold
 * first. Ties keep the newest first.
 */
function rank(r: FixesViewRow): number {
  if (r.bucket === 'open') return r.rung === 'open' ? 0 : r.steps[1]?.state === 'done' ? 2 : 1;
  if (r.bucket === 'ready') return 3;
  return r.broken ? 4 : 5;
}

function viewRow(store: Store, rec: FixRecords, opening: () => ReadonlyMap<string, string>, o: FixesViewOptions, reads: () => StepReads): FixesViewRow {
  const row = rowOf(store, rec, opening);
  const rung = rungOf(rec);
  const actions = fixActions(store, rec, { label: row.label, repairer: o.repairer ?? null, patchInTree: o.patchInTree, rewriteHere: o.rewriteHere });
  // A crashed test replay no model rescued leads with its own step, as its page does (fix-crash.ts).
  const b = rec.fix.status === 'open' ? shownBlame(rec) : null;
  const crash = b?.outcome === 'unrescuable' ? fixCrash(store, b, { work: o.next ?? null, reads: reads() }) : null;
  return { ...row, rung, pr: prOf(rec), ci: rec.fix.data.source?.ci ?? null, bucket: bucketOf(rung, rec.fix.status), failingIds: rec.failing.slice(0, 5).map(short), next: fixLead(rec, actions, { repairer: o.repairer ?? null, crash }) };
}

/** The failed runs nobody has blamed, kept until runs or fixes change: a recording that adds calls changes neither. */
const unblamedKept = new WeakMap<object, { key: string; runs: RunRecord[] }>();

/** The failed runs nobody has blamed, as the list's first row; null when there are none. */
function unblamedRow(store: Store, index: RunIndex, key: string | null, o: FixesViewOptions): UnblamedRow | null {
  const kept = unblamedKept.get(store);
  const runs = key !== null && kept?.key === key ? kept.runs : unblamedRuns(store, index);
  if (key !== null) unblamedKept.set(store, { key, runs });
  const run = runs[0];
  if (!run) return null;
  const indexed = index.byId.get(run.runId);
  const about = indexed ? (aboutsUpTo(store, index, [indexed], o.budget).get(run.runId)?.text ?? null) : null;
  // A capture's, as its import judged it: the verdict that counts it failed.
  const check = checksOf(run, indexed).find((c) => !c.ok);
  // Run blame only where its page leads with it: blame can't take a run that made no model call, and a failed injection test's proof comes first.
  const step = unblamedListedStep(store, run.runId, o.next ?? null, { reads: stepReads(store, index) });
  return { count: runs.length, runId: run.runId, about: about || null, failed: check ? checkWords(check, ', but ') : null, checks: failedCheckLabels(run), ...(step?.key === 'blame' ? { from: step.offer.from, next: stepRow(step) } : { from: null, next: null }) };
}

const keeps = (status: FixStatus | 'all' | undefined, f: FixesViewRow): boolean => !status || status === 'all' || (status === 'verified' ? f.status !== 'open' : f.status === status);

/**
 * The store, with every run's record read once for one answer: an open fix's repair command asks
 * which runs its label selects and which good runs it keeps (the engine's `repairArgv`), each a read
 * of every run, which a list of fixes would otherwise make once a fix.
 */
function readingRunsOnce(store: Store): Store {
  let runs: RunRecord[] | null = null;
  return new Proxy(store, {
    get: (target, key) => {
      if (key === 'allRuns') return () => (runs ??= target.allRuns());
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** What git said of each patch the rows could apply, and of each pulled repair's rewrite, as one key. */
function answersKey(store: Store, records: readonly FixRecords[], o: FixesViewOptions): string {
  if (!o.patchInTree && !o.rewriteHere) return '';
  return records
    .map((rec) => {
      const patch = o.patchInTree ? patchToCheck(rec) : null;
      const pulled = o.rewriteHere ? pulledPatchOf(store, rec) : null;
      return `${patch === null ? '' : String(o.patchInTree!(patch))}/${pulled ? String(o.rewriteHere!(pulled.repairId)) : ''}`;
    })
    .join(',');
}

/**
 * The rows, in to-do order, kept until fixes or runs change, the repairer the config names does, or
 * git says something else of a patch: a page polled while a recording adds calls works out none again.
 */
const rowsKept = new WeakMap<object, { key: string; rows: FixesViewRow[] }>();

function viewRows(store: Store, records: readonly FixRecords[], changes: string | null, o: FixesViewOptions): FixesViewRow[] {
  const key = changes === null ? null : `${changes}:${o.repairer ?? ''}:${answersKey(store, records, o)}`;
  const kept = rowsKept.get(store);
  if (key !== null && kept?.key === key) return kept.rows;
  const once = readingRunsOnce(store);
  const opening = openingTitles(store);
  // What the crashes' steps read, once for every row that needs it.
  let reads: StepReads | null = null;
  const stepsRead = () => (reads ??= stepReads(once));
  // A stable sort over the store's order, the most recently opened first, keeps that order within a rank.
  const rows = records.map((rec) => viewRow(once, rec, opening, o, stepsRead)).sort((a, b) => rank(a) - rank(b));
  if (key !== null) rowsKept.set(store, { key, rows });
  return rows;
}

/** The Fixes page's read model (above). */
export function fixesView(store: Store, o: FixesViewOptions = {}): FixesView {
  const records = keptFixRecords(store);
  // What the rows and the unblamed runs are worked out from: fixes, runs and events (a search's answer, which a crash's lead reads), as the store counts their changes.
  const n = store.changeCounts();
  const changes = n.fixes === undefined || n.runs === undefined ? null : `${n.fixes}:${n.runs}:${n.events ?? ''}`;
  const all = viewRows(store, records, changes, o);
  const count = (bucket: FixBucket) => all.filter((f) => f.bucket === bucket).length;
  const open = count('open');
  const cost = fixCost(records);
  return {
    fixes: all.filter((f) => keeps(o.status, f)),
    counts: { all: all.length, open, ready: count('ready'), applied: count('applied'), verified: all.length - open },
    totals: { failing: all.reduce((n, f) => n + f.failing, 0), attempts: cost.attempts, spent: cost.spent },
    unblamed: unblamedRow(store, loadRunIndex(store), changes, o),
  };
}

/** The read job: `status` as the route checked it, the project's folder (git is asked there about each patch), the configured repairer and what the next step reads. */
export type FixesJob = { kind: 'fixes'; status: FixStatus | 'all'; project: string | null; repairer: string | null; next: NextStepWork | null };

/**
 * Whether each patch the list could apply is in the working tree already, and why `fix apply`
 * refuses a pulled repair's patch there, asked of git in the project's folder beside the server, as
 * the Overview's read asks it; from the records kept, so a poll parses no report again.
 */
async function fixesRead(store: Store, job: FixesJob, whole: boolean): Promise<ReadAnswer> {
  const records = keptFixRecords(store);
  const patches = job.project ? records.flatMap((rec) => patchToCheck(rec) ?? []) : [];
  const pulled = job.project ? records.flatMap((rec) => pulledPatchOf(store, rec) ?? []) : [];
  const patchInTree = job.project && patches.length ? await patchesInTree(job.project, patches) : undefined;
  const rewriteHere = job.project && pulled.length ? await rewritesHere(job.project, pulled) : undefined;
  return answer(fixesView(store, { status: job.status, repairer: job.repairer, next: job.next, patchInTree, rewriteHere, budget: whole ? undefined : SUMMARY_CALLS_BUDGET }), { tagged: true });
}

export const FIXES_READS: ReadTable<FixesJob> = { fixes: (store, job, o) => fixesRead(store, job, o.whole) };
