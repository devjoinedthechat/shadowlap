import type { BlameReport } from './blame.js';
import { canonicalize } from './canonical.js';
import { ulid } from './ids.js';
import type { RepairReport } from './repair.js';
import type { FixData, FixStatus, Store, StoredBlame, StoredFix, StoredRepair, StoredVerdict } from './store.js';
import type { RunRecord } from './types.js';
import type { VerifyReport } from './verify.js';

/**
 * Fixes: one failure, from the blame that reproduced it to a change that held. The commands that
 * do the work record it here, so the dashboard and `shadowlap fix` can show a failure's whole
 * story without re-running anything:
 *
 * - **blame** creates a fix or joins one. A run that already fails in a fix stays in it; otherwise
 *   it joins the fix of another run with the same label (`refund-over-limit`), or, when it has no
 *   label, the fix with the same check. A fix starts from a blame, so every fix has one.
 * - **verify** links to the fix of the failing runs it was given, and the good runs it kept become
 *   the fix's good runs. An accepted verdict turns an open fix verified; a rejected one is kept.
 * - **repair** links the same way, and the verify it ran on the candidate it accepted is kept as a
 *   verdict of its own, so a repair that fixes the runs turns the fix verified.
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

export const labelKey = (label: string): string => `label:${label}`;

/** The group key of a check: its canonical JSON, so the same check written another way is the same failure. */
export function checkKey(expect: unknown): string {
  return `check:${expect === null || expect === undefined ? 'exit' : canonicalize(expect)}`;
}

/** A title as stored: one line, trimmed, at most 160 characters. */
export function cleanTitle(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1)}…` : one;
}

/** The fix a run fails in: one not yet applied (the latest opened), else the latest applied one. */
export function fixOfRun(store: Store, runId: string): StoredFix | null {
  const fixes = store
    .linksTo(runId, 'failing')
    .map((l) => store.getFix(l.fixId))
    .filter((f): f is StoredFix => f !== null)
    .sort((a, b) => b.openedAt - a.openedAt);
  return fixes.find((f) => f.status !== 'applied') ?? fixes[0] ?? null;
}

/**
 * A fix not yet applied that a run's failure belongs to: one grouped by a label of the run, else,
 * for a run with no label and when `byCheck`, one grouped by the same check. An applied fix is
 * finished: the same failure coming back after it shipped is a new one.
 */
export function joinableFix(store: Store, run: Pick<RunRecord, 'meta'> | null, expect: unknown, byCheck = true): StoredFix | null {
  const labels = fixLabels(run);
  for (const label of labels) {
    const fix = store.fixesByGroup(labelKey(label)).find((f) => f.status !== 'applied');
    if (fix) return fix;
  }
  if (labels.length || !byCheck) return null;
  return store.fixesByGroup(checkKey(expect)).find((f) => f.status !== 'applied') ?? null;
}

/** Finds a fix by its id or a unique prefix of it, with or without `fx-`, in any case. */
export function resolveFix(store: Store, idOrPrefix: string): StoredFix | null {
  const q = idOrPrefix.trim();
  if (!q) return null;
  const id = `fx-${q.replace(/^fx-/i, '').toUpperCase()}`;
  const exact = store.getFix(id);
  if (exact) return exact;
  const found = store.listFixes().filter((f) => f.fixId.startsWith(id));
  if (found.length > 1) throw new Error(`fix id prefix "${idOrPrefix}" is ambiguous`);
  return found[0] ?? null;
}

// ---- Recording what the commands did ---------------------------------------------------------

export interface BlameToRecord {
  /** The failed run that was blamed. */
  runId: string;
  report: BlameReport;
  /** The `--expect` the oracle came from, as given; null for the exit code alone. */
  expect: unknown;
  scope: string | null;
  /** A command that blames the run the same way again. */
  command: string;
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
 * Keeps a blame and puts its run in a fix: the fix it already fails in, else the one its label or
 * check joins, else a new open fix. Every outcome counts: blame replayed the run and saw it fail
 * before it probed anything, so even a search that stopped early reproduced the failure.
 */
export function recordBlame(store: Store, input: BlameToRecord): RecordedBlame {
  const at = input.at ?? Date.now();
  const expect = input.expect ?? null;
  const blame: StoredBlame = { blameId: newBlameId(at), runId: input.runId, at, outcome: input.report.outcome, report: input.report, expect, scope: input.scope, command: input.command };
  // Immediate: two blames finishing at once must not both open a fix for the same label.
  return store.transaction(() => {
    store.putBlame(blame);
    const run = store.getRun(input.runId);
    let fix = fixOfRun(store, input.runId) ?? joinableFix(store, run, expect);
    let created = false;
    if (!fix) {
      const label = fixLabels(run)[0] ?? null;
      const data: FixData = {};
      if (input.ci) data.source = { ci: input.ci };
      if (input.actor) data.openedBy = input.actor;
      fix = {
        fixId: newFixId(at),
        title: cleanTitle(input.title) || 'A run failed',
        groupKey: label ? labelKey(label) : checkKey(expect),
        label,
        check: { expect, text: input.checkText },
        status: 'open',
        openedAt: at,
        verifiedAt: null,
        appliedAt: null,
        data,
      };
      store.insertFix(fix);
      created = true;
    }
    store.addFixLink(fix.fixId, 'failing', input.runId, at);
    store.addFixLink(fix.fixId, 'blame', blame.blameId, at);
    return { blame, fix, created };
  }, 'immediate');
}

export interface VerdictToRecord {
  report: VerifyReport;
  expect: unknown;
  command: string;
  /** The repair whose candidate this verified, and which candidate. */
  repairId?: string | null;
  candidate?: number | null;
  at?: number;
  /** The fixes it is about, when the caller knows them; otherwise found from its failing runs. */
  fixIds?: string[];
}

export interface RecordedVerdict {
  verdict: StoredVerdict;
  /** The fixes it was linked to, as they are now. */
  fixes: StoredFix[];
}

/**
 * Keeps a verdict, whatever it was, and links it to the fix of its failing runs (the fixes they fail
 * in, else the ones their labels join). Its good runs become the fix's good runs. An accepted
 * verdict turns an open fix verified; a fix stays verified whatever a later verdict says.
 */
export function recordVerdict(store: Store, input: VerdictToRecord): RecordedVerdict {
  return store.transaction(() => keepVerdict(store, input), 'immediate');
}

function keepVerdict(store: Store, input: VerdictToRecord): RecordedVerdict {
  const at = input.at ?? Date.now();
  const r = input.report;
  const verdict: StoredVerdict = { verifyId: newVerdictId(at), at, verdict: r.verdict, repairId: input.repairId ?? null, candidate: input.candidate ?? null, report: r, expect: input.expect ?? null, command: input.command };
  store.putVerdict(verdict);
  const failing = r.runs.filter((x) => x.role !== 'good').map((x) => x.runId);
  const good = r.runs.filter((x) => x.role === 'good').map((x) => x.runId);
  const fixes = input.fixIds ? input.fixIds.map((id) => store.getFix(id)).filter((f): f is StoredFix => f !== null) : fixesOfRuns(store, failing);
  for (const fix of fixes) {
    store.addFixLink(fix.fixId, 'verify', verdict.verifyId, at);
    linkRuns(store, fix, failing, good, at);
    if (r.verdict === 'accepted' && fix.status === 'open') store.updateFix(fix.fixId, { status: 'verified', verifiedAt: at });
  }
  return { verdict, fixes: fixes.map((f) => store.getFix(f.fixId)!) };
}

export interface RepairToRecord {
  /** The repair's directory name, `repair-<time>`. */
  repairId: string;
  /** Its directory, relative to the folder it ran in. */
  dir: string;
  report: RepairReport;
  expect: unknown;
  command: string;
  at?: number;
}

export interface RecordedRepair {
  repair: StoredRepair;
  fixes: StoredFix[];
  /** The verdict kept for the candidate it accepted, or null when it accepted none. */
  verdict: StoredVerdict | null;
}

/**
 * Keeps a repair's report and links it to the fix of the runs it repaired, which its own blames
 * opened or joined. A repair that accepted a candidate also keeps that candidate's verification as
 * a verdict, so the fix turns verified, or applied when `--apply` left the change in the working
 * tree; one that accepted none leaves the fix open, with every candidate it tried and why each was
 * dropped. A pull request it opened becomes where the fix came from.
 */
export function recordRepair(store: Store, input: RepairToRecord): RecordedRepair {
  const at = input.at ?? Date.now();
  const r = input.report;
  const accepted = r.outcome === 'fixed' ? (r.candidates.find((c) => c.id === r.accepted) ?? null) : null;
  const repair: StoredRepair = { repairId: input.repairId, at, dir: input.dir, outcome: r.outcome, accepted: accepted !== null, report: r, expect: input.expect ?? null, command: input.command };
  return store.transaction(() => {
    store.putRepair(repair);
    const failing = [...r.targets.map((t) => t.runId), ...r.holdout];
    const fixes = fixesOfRuns(store, failing);
    for (const fix of fixes) {
      store.addFixLink(fix.fixId, 'repair', repair.repairId, at);
      linkRuns(store, fix, failing, r.good, at);
      if (r.output.pr) {
        const number = Number(/\/pull\/(\d+)/.exec(r.output.pr)?.[1]);
        store.updateFix(fix.fixId, { data: { ...fix.data, source: { ...fix.data.source, pr: { url: r.output.pr, number: Number.isInteger(number) ? number : null } } } });
      }
    }
    const verdict = accepted?.verify ? keepVerdict(store, { report: accepted.verify, expect: input.expect, command: input.command, repairId: repair.repairId, candidate: accepted.id, at, fixIds: fixes.map((f) => f.fixId) }).verdict : null;
    // `repair --apply` left the change in the working tree: the fix is applied already.
    if (accepted && r.output.applied) {
      for (const fix of fixes) {
        const now = store.getFix(fix.fixId)!;
        if (now.status !== 'applied') store.updateFix(fix.fixId, { status: 'applied', appliedAt: at, data: { ...now.data, applied: { patch: 'applied', repairId: repair.repairId, goldens: [], tests: 'skipped' } } });
      }
    }
    return { repair, fixes: fixes.map((f) => store.getFix(f.fixId)!), verdict };
  }, 'immediate');
}

/** The fixes failing runs belong to: the ones they fail in, else the ones their labels join. */
function fixesOfRuns(store: Store, runIds: readonly string[]): StoredFix[] {
  const found = new Map<string, StoredFix>();
  for (const id of runIds) {
    const fix = fixOfRun(store, id);
    if (fix) found.set(fix.fixId, fix);
  }
  if (!found.size) {
    for (const id of runIds) {
      const fix = joinableFix(store, store.getRun(id), null, false);
      if (fix) found.set(fix.fixId, fix);
    }
  }
  return [...found.values()];
}

/** Links failing and good runs to a fix. A run that fails in another fix not yet applied stays there. */
function linkRuns(store: Store, fix: StoredFix, failing: readonly string[], good: readonly string[], at: number): void {
  for (const id of failing) {
    const other = fixOfRun(store, id);
    if (other && other.fixId !== fix.fixId && other.status !== 'applied') continue;
    store.addFixLink(fix.fixId, 'failing', id, at);
  }
  for (const id of good) store.addFixLink(fix.fixId, 'good', id, at);
}

/** Marks a fix applied, with what `shadowlap fix apply` did. */
export function markFixApplied(store: Store, fixId: string, applied: NonNullable<FixData['applied']>, at: number = Date.now()): StoredFix {
  const fix = store.getFix(fixId);
  if (!fix) throw new Error(`unknown fix ${fixId}`);
  store.updateFix(fixId, { status: 'applied', appliedAt: at, data: { ...fix.data, applied } });
  return store.getFix(fixId)!;
}

/** Gives a fix a title of its own; blames that join it later keep it. */
export function setFixTitle(store: Store, fixId: string, title: string): StoredFix {
  const fix = store.getFix(fixId);
  if (!fix) throw new Error(`unknown fix ${fixId}`);
  const clean = cleanTitle(title);
  if (!clean) throw new Error('a title needs some text');
  store.updateFix(fixId, { title: clean, data: { ...fix.data, titleEdited: true } });
  return store.getFix(fixId)!;
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
}

export function fixRecords(store: Store, fix: StoredFix): FixRecords {
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
  };
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
 * the candidates it dropped. Records shared by several fixes count once.
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
    for (const b of r.blames) add(b.blameId, b.report.attempts, b.report.upstreamRequests, b.report.spent);
    for (const v of r.verdicts) add(v.verifyId, v.report.attempts, v.report.upstreamRequests, v.report.spent);
    for (const p of r.repairs) {
      const dropped = p.report.candidates.filter((c) => c.verify && !(p.accepted && c.id === p.report.accepted));
      add(
        p.repairId,
        dropped.reduce((s, c) => s + (c.verify?.attempts ?? 0), 0),
        dropped.reduce((s, c) => s + (c.verify?.upstreamRequests ?? 0), 0),
        dropped.reduce((s, c) => s + (c.verify?.spent ?? 0), 0) + (p.report.cost.repairer ?? 0),
      );
    }
  }
  return total;
}
