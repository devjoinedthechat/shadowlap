import { commitTitle, fixCost, fixRecords, lostWords, NO_REPAIRER, noRepairerOf, repairToApply, type RunRecord, shownBlame, type StoredRepair, type StoreOf, unrescuedWords, unsettledFirst } from '@shadowlap/engine';
import { loadRunIndex } from './run-index.js';
import { acceptedCandidate, brokenOf, checkSuggestion, counting, fieldsOf, fixHref, isUnblamedFailure, labelledFixes, noAnswerLost, type PatchCheck, patchMerged, rejectedSinceApplied, runHref, short, shownRepair, unrepairedVerdict } from './fix-shared.js';

/** The Overview's fixes: how many there are by status and week, and those that need a look. */

export interface FixesSummary {
  /** Fixes still open, and verified fixes not applied yet. */
  open: number;
  readyToApply: number;
  /** Applied fixes that don't hold: their test failed, or a verify rejected them after they were applied. */
  broken: number;
  /**
   * How far failures got: every failure (fixes, and failed runs never blamed), those blamed to a
   * finished verdict, those with a verified fix (applied ones too), and those applied.
   */
  funnel: { failures: number; blamed: number; verified: number; applied: number };
  /** The attempts behind every fix, and what they and the repairers cost, in USD. */
  attempts: number;
  upstreamRequests: number;
  spent: number;
  /**
   * Failures blame reproduced (it replays a run exactly before it probes), by the time of each fix's
   * first blame: a failure is a fix, however many of its runs were blamed, as the funnel counts it.
   */
  reproduced: { thisWeek: number; lastWeek: number; total: number };
  /** Accepted verdicts that count for a fix. */
  verified: { thisWeek: number; lastWeek: number; total: number };
  /** Rejected verdicts that count for a fix, given before it was applied: changes rejected before they shipped. */
  rejected: { thisWeek: number; lastWeek: number; total: number };
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** A week as the Overview counts it: from its first instant, up to (not including) `to`. */
export interface WeekWindows {
  week: { from: number; to: number };
  lastWeek: { from: number; to: number };
}

/**
 * What fixes came to, for the Overview: this week is the 7 days up to `now`, last week the 7
 * before, unless `windows` names them. The Overview passes its own, the viewer's days, so a blame
 * counts in the same week as the runs beside it.
 */
export function fixesSummary(store: StoreOf<'recording' | 'readModels' | 'fixes'>, now: number = Date.now(), windows?: WeekWindows, options: { patchInTree?: PatchCheck } = {}): FixesSummary {
  const fixes = store.listFixes();
  const records = fixes.map((f) => fixRecords(store, f));
  const cost = fixCost(records);
  const w = windows ?? { week: { from: now - WEEK + 1, to: now + 1 }, lastWeek: { from: now - 2 * WEEK + 1, to: now - WEEK + 1 } };
  const week = (at: number) => (at >= w.week.from && at < w.week.to ? 'this' : at >= w.lastWeek.from && at < w.lastWeek.to ? 'last' : null);
  const tally = (ats: number[]) => ({ thisWeek: ats.filter((a) => week(a) === 'this').length, lastWeek: ats.filter((a) => week(a) === 'last').length, total: ats.length });

  // A failure is a fix, as the funnel and Fixes count it: blaming three of its runs reproduced one failure.
  const firstBlames = records.flatMap((r) => (r.blames[0] ? [r.blames[0].at] : []));
  // A verdict shared by several fixes is one verdict.
  const accepted = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const rec of records) {
    for (const v of counting(rec)) {
      if (v.verdict === 'accepted') accepted.set(v.verifyId, v.at);
      else if (v.verdict === 'rejected' && (rec.fix.appliedAt === null || v.at < rec.fix.appliedAt)) rejected.set(v.verifyId, v.at);
    }
  }

  const blamed = records.filter((r) => r.blames.some((b) => b.outcome !== 'stopped')).length;
  return {
    open: fixes.filter((f) => f.status === 'open').length,
    // A patch already in the working tree is no more to apply.
    readyToApply: records.filter((r) => r.fix.status === 'verified' && !patchMerged(r, options.patchInTree)).length,
    broken: records.filter((r) => brokenOf(r) !== null).length,
    funnel: { failures: fixes.length + unblamedFailures(store).length, blamed, verified: fixes.filter((f) => f.status !== 'open').length, applied: fixes.filter((f) => f.status === 'applied').length },
    attempts: cost.attempts,
    upstreamRequests: cost.upstreamRequests,
    spent: cost.spent,
    reproduced: tally(firstBlames),
    verified: tally([...accepted.values()]),
    rejected: tally([...rejected.values()]),
  };
}

function unblamedFailures(store: StoreOf<'recording' | 'readModels' | 'fixes'>): RunRecord[] {
  const index = loadRunIndex(store);
  return store.allRuns().filter((r) => isUnblamedFailure(store, r, index));
}

export interface NeedsLookItem {
  /**
   * `broken`: an applied fix that doesn't hold; `open`: a failure with no fix yet; `unblamed`: a
   * failed run never blamed; `ready`: a verified fix not applied.
   */
  kind: 'broken' | 'open' | 'unblamed' | 'ready';
  href: string;
  /** The glyph the mock gives it: blame, fail or fixok. */
  icon: 'blame' | 'fail' | 'fixok';
  title: string;
  detail: string;
  action: 'Open' | 'Fix it' | 'Run blame' | 'Apply' | 'Mark applied';
  fixId: string | null;
  runId: string | null;
  at: number;
  /** For a failed run never blamed: the check of a fix its labels point to, which a blame of it can use. */
  expect?: unknown;
}

/**
 * Why a repair that accepted nothing found no fix, when its repairer was never asked and nothing
 * else was tried: in a few words, `the repairer could not be asked` (claude was not found, say), or
 * that none is configured or it had nothing to rewrite. Null for a repair that looked for a fix.
 */
function unaskedWords(r: StoredRepair): string | null {
  if (r.accepted || r.report.candidates.length) return null;
  const none = noRepairerOf(r.report)?.text;
  if (!none) return null;
  return none.startsWith(NO_REPAIRER.notAsked) ? NO_REPAIRER.notAsked : none;
}

/**
 * What needs a look about fixes, most urgent first: applied fixes that don't hold, failures with no
 * fix yet (open fixes, then failed runs never blamed), then verified fixes not applied.
 */
export function needsLookFixes(store: StoreOf<'recording' | 'readModels' | 'fixes'>, options: { limit?: number; patchInTree?: PatchCheck } = {}): NeedsLookItem[] {
  const broken: NeedsLookItem[] = [];
  const open: NeedsLookItem[] = [];
  const ready: NeedsLookItem[] = [];
  for (const fix of store.listFixes()) {
    const rec = fixRecords(store, fix);
    if (fix.status === 'open') {
      const b = shownBlame(rec);
      // At the call blame names, or gradually around two when no one call lost the run.
      const where = b?.outcome === 'blamed' && b.report.blamed ? lostWords(b.report.blamed.callNo, b.report.range, 'calls') : b?.outcome === 'unrescuable' ? unrescuedWords(unsettledFirst(b.report)) : 'blame stopped early';
      // No answer of the model's lost it: a repair of the prompt is no fix, so the row opens the fix and says where to look.
      const elsewhere = noAnswerLost(b);
      // A repair whose repairer was never asked looked for no fix: it says why, not that none was found.
      const last = rec.repairs.at(-1);
      const repaired = last ? (unaskedWords(last) ?? 'no fix found yet') : 'no fix yet';
      open.push({ kind: 'open', href: fixHref(fix.fixId), icon: 'blame', title: fix.title, detail: `${where} · ${elsewhere ? 'look at the tools, the harness or the command' : repaired}`, action: elsewhere ? 'Open' : 'Fix it', fixId: fix.fixId, runId: null, at: fix.openedAt });
    } else if (fix.status === 'verified') {
      // Its patch is in the working tree already: nothing is ready to apply, and the fix's page offers Mark applied.
      if (patchMerged(rec, options.patchInTree)) continue;
      const p = shownRepair(rec);
      const c = p && acceptedCandidate(p);
      // No patch to apply, so the fix's page leads with Mark applied, and the line says it too: for a
      // change of request fields, which ones your agent is to make first.
      const mark = !repairToApply(rec);
      const v = mark ? unrepairedVerdict(rec) : null;
      const fields = v ? fieldsOf(v) : null;
      const detail = fields ? `make ${fields} in your agent, then mark it applied` : c ? commitTitle(c) : fix.title;
      ready.push({ kind: 'ready', href: fixHref(fix.fixId, c ? 'repair' : 'verify'), icon: 'fixok', title: 'A verified fix is ready', detail, action: mark ? 'Mark applied' : 'Apply', fixId: fix.fixId, runId: null, at: fix.verifiedAt ?? fix.openedAt });
    } else {
      const why = brokenOf(rec);
      if (!why) continue;
      const rejected = rejectedSinceApplied(rec);
      broken.push({ kind: 'broken', href: rejected ? fixHref(fix.fixId, 'verify', rejected.verifyId) : fixHref(fix.fixId), icon: 'fail', title: "An applied fix doesn't hold", detail: `${fix.title} · ${why}`, action: 'Open', fixId: fix.fixId, runId: null, at: rejected?.at ?? fix.appliedAt ?? fix.openedAt });
    }
  }
  const failed = unblamedFailures(store);
  const fixes = failed.length ? labelledFixes(store) : [];
  const unblamed: NeedsLookItem[] = failed.map((run) => {
    const suggested = checkSuggestion(run, fixes);
    return {
      kind: 'unblamed' as const,
      href: runHref(run.runId),
      icon: 'fail' as const,
      title: `A run failed: ${short(run.runId)}`,
      // A run is named by its id (decision 10): its labels are no name. The Overview puts the run's
      // about line in place of its command for the lines it shows.
      detail: `${run.command.argv.join(' ')} · not blamed yet`,
      action: 'Run blame' as const,
      fixId: null,
      runId: run.runId,
      at: run.startedAt,
      ...(suggested ? { expect: suggested.expect } : {}),
    };
  });
  const newest = (a: NeedsLookItem, b: NeedsLookItem) => b.at - a.at;
  const all = [...broken.sort(newest), ...open.sort(newest), ...unblamed.sort(newest), ...ready.sort(newest)];
  return options.limit ? all.slice(0, options.limit) : all;
}
