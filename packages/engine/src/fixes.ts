import type { BlameReport } from './blame.js';
import { canonicalize } from './canonical.js';
import { credentialFreeCommandLine } from './argv-credentials.js';
import { ulid } from './ids.js';
import type { RepairReport } from './repair.js';
import type { FixData, FixStatus, StepRerun, StoreOf, StoredBlame, StoredFix, StoredRepair, StoredVerdict, VerdictStanding } from './store.js';
import type { RunRecord } from './types.js';
import type { VerifyReport } from './verify.js';

/**
 * Fixes: one failure, from the blame that reproduced it to a change that held. The commands that
 * do the work record it here, so the dashboard and `shadowlap fix` can show a failure's whole
 * story without re-running anything:
 *
 * - **blame** creates a fix or joins one (`joinableFix` says which). A run already in a fix keeps
 *   its blames there. A fix starts from a blame, so every fix has one.
 * - **verify** links to the fix of the failing runs it was given. Its verdict counts for that fix
 *   when it checked everything the fix's check asks, on at least one of the fix's runs that failed
 *   it as recorded: only then do its runs join the fix, and an accepted one turns the fix
 *   verified. A verdict that doesn't count is kept and shown, and changes nothing.
 * - **repair** links the same way, and the verify it ran on the candidate it accepted is kept as a
 *   verdict of its own, so a repair that fixes the runs under the fix's check turns it verified.
 * - **fix apply** marks it applied.
 *
 * Every blame, verdict and repair report is kept whole, so a later run of the same command never
 * rewrites what an earlier one found.
 */

/** A run labelled `good` passed; it never names a failure. */
export const GOOD_LABEL = 'good';

export const FIX_STATUSES: readonly FixStatus[] = ['open', 'verified', 'applied'];

const MAX_TITLE = 160;

export const newFixId = (now: number = Date.now()): string => `fx-${ulid(now)}`;
const newBlameId = (now: number) => `bl-${ulid(now)}`;
const newVerdictId = (now: number) => `vf-${ulid(now)}`;

/** A run's labels that can name a failure: every one but `good`, in the order they were given. */
export function fixLabels(run: Pick<RunRecord, 'meta'> | null | undefined): string[] {
  return (run?.meta?.labels ?? []).filter((l) => typeof l === 'string' && l && l !== GOOD_LABEL);
}

/** The key of a check: its canonical JSON, so the same check written another way is the same failure. */
export function checkKey(expect: unknown): string {
  return `check:${expect === null || expect === undefined ? 'exit' : canonicalize(expect)}`;
}

/** A title as stored: one line, trimmed, at most 160 characters. */
export function cleanTitle(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1)}…` : one;
}

/** A pull or merge request's number, from its URL on GitHub, GitLab or Bitbucket. */
export function prNumber(url: string): number | null {
  const m = /\/(?:pull|merge_requests|pull-requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** A fix id that matches no fix (`unknown`), or more than one (`ambiguous`). */
export class FixIdError extends Error {
  constructor(
    message: string,
    readonly reason: 'unknown' | 'ambiguous',
  ) {
    super(message);
    this.name = 'FixIdError';
  }
}

/**
 * Finds a fix by its id or a unique prefix of it, with or without `fx-`, in any case. Null when
 * nothing matches, or when no id characters are given (`fx-` alone); a prefix that matches several
 * fixes throws a FixIdError.
 */
export function resolveFix(store: StoreOf<'fixes'>, idOrPrefix: string): StoredFix | null {
  const q = idOrPrefix.trim().replace(/^fx-/i, '');
  if (!/^[0-9a-z]+$/i.test(q)) return null;
  const id = `fx-${q.toUpperCase()}`;
  const exact = store.getFix(id);
  if (exact) return exact;
  const found = store.listFixes().filter((f) => f.fixId.startsWith(id));
  if (found.length > 1) throw new FixIdError(`fix id prefix "${idOrPrefix.trim()}" is ambiguous: it matches ${found.length} fixes`, 'ambiguous');
  return found[0] ?? null;
}

// ---- Grouping ------------------------------------------------------------------------------------

/**
 * The labels a fix groups runs by: the ones its failing runs carry now, so a fix picks up a label
 * its runs are given later and drops one taken off them; when none of its runs is left in the
 * store, the ones they carried when they joined. `label` is the one it goes by: the label most of
 * its runs carry, the first given on a tie.
 */
export function fixLabelInfo(store: StoreOf<'recording' | 'fixes'>, fix: StoredFix): { labels: string[]; label: string | null } {
  const count = new Map<string, number>();
  let found = false;
  for (const link of store.fixLinks(fix.fixId, 'failing')) {
    const run = store.getRun(link.ref);
    if (!run) continue;
    found = true;
    for (const l of fixLabels(run)) count.set(l, (count.get(l) ?? 0) + 1);
  }
  if (!found) return { labels: [...fix.labels], label: fix.labels[0] ?? null };
  let label: string | null = null;
  for (const [l, n] of count) if (label === null || n > count.get(label)!) label = l;
  return { labels: [...count.keys()], label };
}

/** The fix a run fails in: one not yet applied (the latest opened), else the latest applied one. */
export function fixOfRun(store: StoreOf<'fixes'>, runId: string): StoredFix | null {
  const fixes = store
    .linksTo(runId, 'failing')
    .map((l) => store.getFix(l.fixId))
    .filter((f): f is StoredFix => f !== null)
    .sort((a, b) => b.openedAt - a.openedAt);
  return fixes.find((f) => f.status !== 'applied') ?? fixes[0] ?? null;
}

/**
 * The fix not yet applied that a failing run joins, or null for a failure of its own. Labels are
 * how people group runs, so they come first, and the check (`--expect`, compared canonically)
 * decides where they can't:
 *
 * 1. a fix that shares a label with the run and has the same check;
 * 2. else a fix that holds every label the run has, whatever its check: the label decides;
 * 3. else, with `byCheck`, a fix with no labels and the same check.
 *
 * A run with a label the fix doesn't hold, and another check, is likely another failure, so it
 * opens a fix of its own rather than hide in that one. A run with no labels joins (`byCheck`) the
 * unlabelled fix with its check, else the one labelled fix with it when there is only one. Ties go
 * to the fix sharing more labels, then to the first opened. An applied fix is finished: the same
 * failure seen again in a new run is a new one.
 */
export function joinableFix(store: StoreOf<'recording' | 'fixes'>, run: Pick<RunRecord, 'meta'> | null, expect: unknown, o: { byCheck?: boolean } = {}): StoredFix | null {
  const byCheck = o.byCheck ?? true;
  const labels = fixLabels(run);
  const key = checkKey(expect);
  const candidates = store
    .listFixes()
    .filter((f) => f.status !== 'applied')
    .reverse()
    .map((fix) => {
      const held = fixLabelInfo(store, fix).labels;
      return { fix, held, shared: labels.filter((l) => held.includes(l)).length, sameCheck: fix.check.key === key };
    });
  // A stable sort: on a tie, the first opened stays first.
  const best = (xs: typeof candidates) => [...xs].sort((a, b) => b.shared - a.shared)[0]?.fix ?? null;
  if (labels.length) {
    const found = best(candidates.filter((x) => x.shared > 0 && x.sameCheck)) ?? best(candidates.filter((x) => x.shared === labels.length));
    if (found || !byCheck) return found;
    return candidates.find((x) => x.sameCheck && !x.held.length)?.fix ?? null;
  }
  if (!byCheck) return null;
  const same = candidates.filter((x) => x.sameCheck);
  return same.find((x) => !x.held.length)?.fix ?? (same.length === 1 ? same[0]!.fix : null);
}

/**
 * Whether an oracle checks everything a fix's check asks: the same check however it is written,
 * or one that asks for more. Each label of an oracle is one thing a passing run does, so every
 * label of the fix's oracle must be among them; `missing` lists those left out.
 */
export function coversCheck(fix: Pick<StoredFix, 'check'>, oracle: readonly string[], expect: unknown): { covers: boolean; missing: string[] } {
  if (checkKey(expect) === fix.check.key) return { covers: true, missing: [] };
  const missing = fix.check.oracle.filter((l) => !oracle.includes(l));
  return { covers: missing.length === 0, missing };
}

/** Links failing runs to a fix and keeps their labels with it. A run that fails in another fix not yet applied stays there. */
function joinRuns(store: StoreOf<'recording' | 'fixes'>, fix: StoredFix, runIds: readonly string[], at: number): void {
  const before = store.getFix(fix.fixId)?.labels ?? fix.labels;
  const labels = [...before];
  for (const id of runIds) {
    const other = fixOfRun(store, id);
    if (other && other.fixId !== fix.fixId && other.status !== 'applied') continue;
    store.addFixLink(fix.fixId, 'failing', id, at);
    for (const l of fixLabels(store.getRun(id))) if (!labels.includes(l)) labels.push(l);
  }
  if (labels.length !== before.length) store.updateFix(fix.fixId, { labels });
}

/** The fixes failing runs belong to: the ones they fail in, else the ones their labels join. */
function fixesOfRuns(store: StoreOf<'recording' | 'fixes'>, runIds: readonly string[], expect: unknown): StoredFix[] {
  const found = new Map<string, StoredFix>();
  for (const id of runIds) {
    const fix = fixOfRun(store, id);
    if (fix) found.set(fix.fixId, fix);
  }
  if (!found.size) {
    for (const id of runIds) {
      const fix = joinableFix(store, store.getRun(id), expect, { byCheck: false });
      if (fix) found.set(fix.fixId, fix);
    }
  }
  return [...found.values()];
}

// ---- Recording what the commands did ---------------------------------------------------------

export interface BlameToRecord {
  /** The failed run that was blamed. */
  runId: string;
  report: BlameReport;
  /** The `--expect` the oracle came from, as given; null for the exit code alone. */
  expect: unknown;
  scope: string | null;
  /** A command that blames the run the same way again, as the CLI printed it: kept with its credentials masked (credentialFreeCommandLine). */
  command: string;
  /** The flags it ran with beyond its report, which Blame again runs it with (`StepRerun`), kept as they ran. */
  rerun?: StepRerun | null;
  /** For a fix this blame opens: its title and its check in words, derived from the check. */
  title: string;
  checkText: string;
  at?: number;
  /** Who blamed it (resolveAuthor). */
  actor?: string | null;
  /** The CI provider it ran under, which a fix it opens keeps as where it came from. */
  ci?: string | null;
}

export interface RecordedBlame {
  blame: StoredBlame;
  fix: StoredFix;
  /** This blame opened the fix. */
  created: boolean;
}

/**
 * Keeps a blame and puts its run in a fix: the fix it already fails in, else the one its labels or
 * check join (`joinableFix`), else a new open fix. A run already in a fix keeps its blames there,
 * applied or not: its recording can't show the failure coming back after the fix shipped, and a
 * new run that fails again opens a new fix. Every outcome counts: blame replayed the run and saw
 * it fail before it probed anything, so even a search that stopped early reproduced the failure.
 */
export function recordBlame(store: StoreOf<'recording' | 'fixes'>, input: BlameToRecord): RecordedBlame {
  const at = input.at ?? Date.now();
  const expect = input.expect ?? null;
  const blame: StoredBlame = { blameId: newBlameId(at), runId: input.runId, at, outcome: input.report.outcome, report: input.report, expect, scope: input.scope, command: credentialFreeCommandLine(input.command), ...(input.rerun ? { rerun: input.rerun } : {}) };
  // Immediate: two blames finishing at once must not both open a fix for the same failure.
  return store.transaction(() => {
    store.putBlame(blame);
    const run = store.getRun(input.runId);
    let fix = fixOfRun(store, input.runId) ?? joinableFix(store, run, expect);
    let created = false;
    if (!fix) {
      const data: FixData = {};
      if (input.ci) data.source = { ci: input.ci };
      if (input.actor) data.openedBy = input.actor;
      fix = {
        fixId: newFixId(at),
        title: cleanTitle(input.title) || 'A run failed',
        labels: [],
        check: { expect, key: checkKey(expect), oracle: [...input.report.oracle], text: input.checkText },
        status: 'open',
        openedAt: at,
        verifiedAt: null,
        appliedAt: null,
        data,
      };
      store.insertFix(fix);
      created = true;
    }
    store.addFixLink(fix.fixId, 'blame', blame.blameId, at);
    joinRuns(store, fix, [input.runId], at);
    return { blame, fix: store.getFix(fix.fixId)!, created };
  }, 'immediate');
}

export interface VerdictToRecord {
  report: VerifyReport;
  expect: unknown;
  /** The command it ran, as the CLI printed it: kept with its credentials masked (credentialFreeCommandLine). */
  command: string;
  /** The flags it ran with beyond its report, which Run more attempts and Verify again run it with (`StepRerun`). */
  rerun?: StepRerun | null;
  /** The repair whose candidate this verified, and which candidate. */
  repairId?: string | null;
  candidate?: number | null;
  at?: number;
  /** The fixes it is about, when the caller knows them; otherwise found from its failing runs. */
  fixIds?: string[];
}

export interface RecordedVerdict {
  verdict: StoredVerdict;
  /** The fixes it was linked to, as they are now, and whether it counts for each. */
  fixes: Array<{ fix: StoredFix; standing: VerdictStanding }>;
}

/**
 * Keeps a verdict, whatever it was, and links it to the fix of its failing runs (the fixes they
 * fail in, else the ones their labels join). For each fix it says whether the verdict counts there
 * (`VerdictStanding`). One that counts brings its runs to the fix: failing runs that didn't pass as
 * recorded, and good runs that did. An accepted verdict that counts turns an open fix verified; a
 * fix stays verified whatever a later verdict says.
 */
export function recordVerdict(store: StoreOf<'recording' | 'fixes'>, input: VerdictToRecord): RecordedVerdict {
  return store.transaction(() => keepVerdict(store, input));
}

function keepVerdict(store: StoreOf<'recording' | 'fixes'>, input: VerdictToRecord): RecordedVerdict {
  const at = input.at ?? Date.now();
  const r = input.report;
  const expect = input.expect ?? null;
  const verdict: StoredVerdict = { verifyId: newVerdictId(at), at, verdict: r.verdict, repairId: input.repairId ?? null, candidate: input.candidate ?? null, report: r, expect, command: credentialFreeCommandLine(input.command), ...(input.rerun ? { rerun: input.rerun } : {}) };
  store.putVerdict(verdict);
  const failing = r.runs.filter((x) => x.role !== 'good');
  const fixes = input.fixIds ? input.fixIds.map((id) => store.getFix(id)).filter((f): f is StoredFix => f !== null) : fixesOfRuns(store, failing.map((x) => x.runId), expect);
  const kept: RecordedVerdict['fixes'] = [];
  for (const fix of fixes) {
    const { covers, missing } = coversCheck(fix, r.oracle, expect);
    // Only a verdict on the fix's own check says anything about which runs fail or pass it.
    if (covers) {
      joinRuns(store, fix, failing.filter((x) => x.recorded.passed !== true).map((x) => x.runId), at);
      for (const x of r.runs) if (x.role === 'good' && x.recorded.passed !== false) store.addFixLink(fix.fixId, 'good', x.runId, at);
    }
    const mine = new Set(store.fixLinks(fix.fixId, 'failing').map((l) => l.ref));
    const ofFix = failing.filter((x) => mine.has(x.runId));
    const standing: VerdictStanding = !covers
      ? { counts: false, why: 'another-check', missing }
      : !ofFix.length
        ? { counts: false, why: 'no-runs' }
        : ofFix.every((x) => x.recorded.passed === true)
          ? { counts: false, why: 'already-passing' }
          : { counts: true, why: null };
    store.addFixLink(fix.fixId, 'verify', verdict.verifyId, at, standing);
    if (standing.counts && r.verdict === 'accepted' && fix.status === 'open') store.updateFix(fix.fixId, { status: 'verified', verifiedAt: at });
    kept.push({ fix: store.getFix(fix.fixId)!, standing });
  }
  return { verdict, fixes: kept };
}

export interface RepairToRecord {
  /** The repair's directory name, `repair-<time>`. */
  repairId: string;
  /** Its directory, relative to the folder it ran in. */
  dir: string;
  report: RepairReport;
  expect: unknown;
  /** The command that repairs the same way again, as the CLI printed it: kept with its credentials masked (credentialFreeCommandLine). */
  command: string;
  at?: number;
  /** With `--apply --goldens <dir>`: where the recordings of the fixed runs were copied in the project. */
  goldensCopied?: string[];
}

export interface RecordedRepair {
  repair: StoredRepair;
  /** The fixes it was linked to, as they are now, and whether the verdict it kept counts for each (null without one). */
  fixes: Array<{ fix: StoredFix; standing: VerdictStanding | null }>;
  /** The verdict kept for the candidate it accepted, or null when it accepted none. */
  verdict: StoredVerdict | null;
}

/**
 * Keeps a repair's report and links it to the fix of the runs it repaired, which its own blames
 * opened or joined. A repair that accepted a candidate also keeps that candidate's verification as
 * a verdict, so a fix it counts for turns verified, or applied when `--apply` left the change in
 * the working tree; one that accepted none leaves the fix open, with every candidate it tried and
 * why each was dropped. A pull request it opened becomes where the fix came from. Its failing runs
 * join the fix, but for one that passed the check as recorded, as its blame or a candidate's
 * verification replayed it.
 */
export function recordRepair(store: StoreOf<'recording' | 'fixes'>, input: RepairToRecord): RecordedRepair {
  const at = input.at ?? Date.now();
  const r = input.report;
  const expect = input.expect ?? null;
  const accepted = r.outcome === 'fixed' ? (r.candidates.find((c) => c.id === r.accepted) ?? null) : null;
  const repair: StoredRepair = { repairId: input.repairId, at, dir: input.dir, outcome: r.outcome, accepted: accepted !== null, report: r, expect, command: credentialFreeCommandLine(input.command) };
  return store.transaction(() => {
    store.putRepair(repair);
    const failing = [...new Set([...r.targets.map((t) => t.runId), ...r.holdout])];
    const fixes = fixesOfRuns(store, failing, expect);
    // How each recording fares against the repair's oracle, from any candidate it verified: the recording is the same for all.
    const recorded = new Map<string, boolean | null>();
    for (const c of r.candidates) for (const x of c.verify?.runs ?? []) if (!recorded.has(x.runId)) recorded.set(x.runId, x.recorded.passed);
    // Or from its blame, which replays each run as recorded first: one that passed was no failure, whatever --fixes said.
    for (const t of r.targets) if (t.outcome === 'passes' && !recorded.has(t.runId)) recorded.set(t.runId, true);
    for (const fix of fixes) {
      store.addFixLink(fix.fixId, 'repair', repair.repairId, at);
      if (coversCheck(fix, r.oracle, expect).covers) {
        joinRuns(store, fix, failing.filter((id) => recorded.get(id) !== true), at);
        for (const id of r.good) if (recorded.get(id) !== false) store.addFixLink(fix.fixId, 'good', id, at);
      }
      if (r.output.pr) store.mergeFixData(fix.fixId, { source: { pr: { url: r.output.pr, number: prNumber(r.output.pr), state: 'open', at } } });
    }
    const kept = accepted?.verify ? keepVerdict(store, { report: accepted.verify, expect, command: repair.command, repairId: repair.repairId, candidate: accepted.id, at, fixIds: fixes.map((f) => f.fixId) }) : null;
    // `repair --apply` left the change in the working tree: a fix it verified is applied already.
    if (kept && r.output.applied) {
      for (const { fix, standing } of kept.fixes) {
        if (standing.counts && fix.status !== 'applied') applyMark(store, fix.fixId, { patch: 'applied', repairId: repair.repairId, goldens: input.goldensCopied ?? [], tests: 'skipped', via: 'repair --apply' }, at);
      }
    }
    const standing = new Map((kept?.fixes ?? []).map((x) => [x.fix.fixId, x.standing]));
    return { repair, fixes: fixes.map((f) => ({ fix: store.getFix(f.fixId)!, standing: standing.get(f.fixId) ?? null })), verdict: kept?.verdict ?? null };
  }, 'immediate');
}

/** Marks a fix applied, inside a transaction the caller holds. A fix applied before keeps when it was applied; what was done is replaced. */
function applyMark(store: StoreOf<'fixes'>, fixId: string, applied: NonNullable<FixData['applied']>, at: number): void {
  const fix = store.getFix(fixId);
  if (!fix) throw new Error(`unknown fix ${fixId}`);
  if (fix.status !== 'applied') store.updateFix(fixId, { status: 'applied', appliedAt: at });
  store.mergeFixData(fixId, { applied: null });
  store.mergeFixData(fixId, { applied });
}

/** Marks a fix applied, with what `shadowlap fix apply` did. Applied before, it keeps when, and takes what was done now. */
export function markFixApplied(store: StoreOf<'fixes'>, fixId: string, applied: NonNullable<FixData['applied']>, at: number = Date.now()): StoredFix {
  return store.transaction(() => {
    applyMark(store, fixId, applied, at);
    return store.getFix(fixId)!;
  }, 'immediate');
}

/**
 * Applied fixes whose last test of their goldens failed, and which a test session has since passed
 * on every one of those goldens (`passed`, by their path in the project): their test is marked
 * passed, so they hold again. The usual way there: another fix changed what every request carries,
 * which left these goldens behind, and `shadowlap test --update` re-recorded them. Returns the fixes
 * it marked.
 */
export function settleAppliedFixes(store: StoreOf<'fixes'>, passed: ReadonlySet<string>, at: number = Date.now()): StoredFix[] {
  const path = (p: string) => p.split(/[\\/]+/).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
  const ok = new Set([...passed].map(path));
  return store.transaction(() => {
    const settled: StoredFix[] = [];
    for (const fix of store.listFixes()) {
      const applied = fix.data.applied;
      if (fix.status !== 'applied' || applied?.tests !== 'failed' || !applied.goldens.length) continue;
      if (!applied.goldens.every((g) => ok.has(path(g)))) continue;
      applyMark(store, fix.fixId, { ...applied, tests: 'passed' }, at);
      settled.push(store.getFix(fix.fixId)!);
    }
    return settled;
  }, 'immediate');
}

/**
 * Gives a fix a title of its own; blames that join it later keep it. When it was given goes with
 * it, so a teammate's copy renamed earlier never puts its title back (mergeFixDocs).
 */
export function setFixTitle(store: StoreOf<'fixes'>, fixId: string, title: string, at: number = Date.now()): StoredFix {
  const clean = cleanTitle(title);
  if (!clean) throw new Error('a title needs some text');
  return store.transaction(() => {
    if (!store.getFix(fixId)) throw new Error(`unknown fix ${fixId}`);
    store.updateFix(fixId, { title: clean });
    store.mergeFixData(fixId, { titleEdited: true, titleEditedAt: at });
    return store.getFix(fixId)!;
  }, 'immediate');
}

// ---- Reading a fix back -----------------------------------------------------------------------

export interface FixRecords {
  fix: StoredFix;
  /** Failing and good run ids, in the order they were linked. */
  failing: string[];
  good: string[];
  /** Blames, repairs and verdicts, the first made first. */
  blames: StoredBlame[];
  repairs: StoredRepair[];
  verdicts: StoredVerdict[];
  /** Whether each verdict counts for the fix, by its id. */
  standing: Map<string, VerdictStanding>;
}

const COUNTS: VerdictStanding = { counts: true, why: null };

export function fixRecords(store: StoreOf<'fixes'>, fix: StoredFix): FixRecords {
  const links = store.fixLinks(fix.fixId);
  const refs = (kind: string) => links.filter((l) => l.kind === kind).map((l) => l.ref);
  const byAt = <T extends { at: number }>(xs: Array<T | null>) => xs.filter((x): x is T => x !== null).sort((a, b) => a.at - b.at);
  return {
    fix,
    failing: refs('failing'),
    good: refs('good'),
    blames: byAt(refs('blame').map((id) => store.getBlame(id))),
    repairs: byAt(refs('repair').map((id) => store.getRepair(id))),
    verdicts: byAt(refs('verify').map((id) => store.getVerdict(id))),
    standing: new Map(links.filter((l) => l.kind === 'verify').map((l) => [l.ref, l.data ?? COUNTS])),
  };
}

/** Whether a verdict counts for the fix these records are of. */
export const verdictCounts = (rec: Pick<FixRecords, 'standing'>, v: Pick<StoredVerdict, 'verifyId'>): boolean => (rec.standing.get(v.verifyId) ?? COUNTS).counts;

/**
 * The repair whose change a fix is applied with: the one it was applied with, else the latest that
 * accepted a candidate with a patch whose verdict counts for the fix. Null for a fix verified on the
 * working tree, which has no patch.
 */
export function repairToApply(rec: FixRecords): StoredRepair | null {
  const applied = rec.fix.data.applied;
  if (applied) return applied.repairId ? (rec.repairs.find((r) => r.repairId === applied.repairId) ?? null) : null;
  return [...rec.repairs].reverse().find((r) => r.accepted && r.report.patch && rec.verdicts.some((v) => v.repairId === r.repairId && verdictCounts(rec, v))) ?? null;
}

/**
 * What applying a fix left undone, for one applied with a repair's patch: recordings of the fixed
 * runs not copied into the project (`repair --apply` without `--goldens`), or a test of them that
 * hasn't passed (it failed, or was skipped). Null when nothing is left. A repair that came with a
 * pull (`pulled`) left its recordings on the machine that ran it: none are wanted here.
 */
export function applyLeft(fix: StoredFix, repair: StoredRepair | null, o: { pulled?: boolean } = {}): { goldens: boolean; test: boolean } | null {
  const applied = fix.data.applied;
  if (fix.status !== 'applied' || !applied || applied.patch === 'none' || !repair) return null;
  const wanted = o.pulled ? 0 : repair.report.output.goldens.length;
  const left = { goldens: applied.goldens.length < wanted, test: wanted > 0 && applied.tests !== 'passed' };
  return left.goldens || left.test ? left : null;
}

/** A path with forward slashes on every system. */
const slashed = (p: string) => p.split(/[\\/]+/).join('/');
/** A path's last part: a golden's name. */
const lastPart = (p: string) => slashed(p).replace(/\/+$/, '').split('/').at(-1) ?? '';

/**
 * The recordings applying a fix copies into the goldens folder, one for each run its repair fixed:
 * `run`, the short id its folder in the repair's goldens/ is named by, `source` that folder, and
 * `copied` where a copy of it went before, else null: one `fix apply` made, under whatever name, by
 * the run it kept beside it (`applied.from`), or one `repair --apply --goldens` made, named by the
 * run. A path outside the project is no copy. None for a repair a pull brought: its recordings
 * stayed on the machine that ran it.
 */
export function applyGoldens(fix: StoredFix, repair: StoredRepair | null, o: { pulled?: boolean } = {}): Array<{ run: string; source: string; copied: string | null }> {
  if (!repair || o.pulled) return [];
  const applied = fix.data.applied;
  const from = applied?.from ?? {};
  const before = (applied?.goldens ?? []).map(slashed).filter((p) => !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.split('/').includes('..'));
  return repair.report.output.goldens.map((g) => {
    const run = lastPart(g);
    return { run, source: slashed(g), copied: before.find((p) => (from[p] ?? lastPart(p)) === run) ?? null };
  });
}

export interface FixCost {
  /** Replays that ran something live: blame probes, verify attempts, and the attempts of candidates a repair rejected. */
  attempts: number;
  /** Requests that reached a provider. */
  upstreamRequests: number;
  /** Approximate USD spent on them, and on the repairer. */
  spent: number;
}

/**
 * What everything behind fixes took. A blame a repair ran is a blame of its own, and the verify of
 * the candidate a repair accepted is a verdict of its own, so a repair adds only the repairer and
 * the candidates it dropped. Records shared by several fixes count once. What judge checks' calls
 * sent and spent (a report's `judge`) is part of it: they were asked for the fix too.
 */
export function fixCost(records: Array<Pick<FixRecords, 'blames' | 'repairs' | 'verdicts'>>): FixCost {
  const seen = new Set<string>();
  const total: FixCost = { attempts: 0, upstreamRequests: 0, spent: 0 };
  const add = (id: string, attempts: number, upstream: number, spent: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    total.attempts += attempts || 0;
    total.upstreamRequests += upstream || 0;
    total.spent += spent || 0;
  };
  for (const r of records) {
    for (const b of r.blames) add(b.blameId, b.report.attempts, b.report.upstreamRequests + (b.report.judge?.upstreamRequests ?? 0), b.report.spent + (b.report.judge?.spent ?? 0));
    for (const v of r.verdicts) add(v.verifyId, v.report.attempts, v.report.upstreamRequests + (v.report.judge?.upstreamRequests ?? 0), v.report.spent + (v.report.judge?.spent ?? 0));
    for (const p of r.repairs) {
      const dropped = p.report.candidates.filter((c) => c.verify && !(p.accepted && c.id === p.report.accepted));
      add(
        p.repairId,
        dropped.reduce((s, c) => s + (c.verify?.attempts ?? 0), 0),
        dropped.reduce((s, c) => s + (c.verify?.upstreamRequests ?? 0) + (c.verify?.judge?.upstreamRequests ?? 0), 0),
        dropped.reduce((s, c) => s + (c.verify?.spent ?? 0) + (c.verify?.judge?.spent ?? 0), 0) + (p.report.cost.repairer ?? 0),
      );
    }
  }
  return total;
}
