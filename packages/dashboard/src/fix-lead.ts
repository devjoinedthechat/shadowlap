import { ACTIONS, checkKey, type FixRecords, type SprtGate } from '@shadowlap/engine';
import { counting, type FixActions, rungOf } from './fix-shared.js';
import { FINISH_APPLYING, MARK_APPLIED } from './fix-lead-words.js';
import { verifyMore } from './fix-verify-step.js';
import type { CrashStep } from './next-step.js';

/**
 * The step a fix leads with, worked out on the server for a list to carry in the words its page
 * uses: what its Fixes row runs or asks, from its records and what its buttons would run
 * (fix-actions.ts), never a call. A lead carries only what a row draws and sends: its label (the
 * engine's `ACTIONS`, or the page's own Mark applied and Finish applying), the command it runs, the
 * working tree's use its wait reads (`writes` for repair and apply, which change it), and per kind
 * what its card says. Null when the fix has no step to lead with: its row opens it.
 */
export type FixLead =
  /** As its ask says it: where the last search stopped (`soFar`), or the gate it raises and the last blame's rescue rate. */
  | { key: 'blame-again'; label: string; command: string; use: 'reads'; stopped: boolean; gate: SprtGate | null; soFar: number | null; lastGood: number | null }
  | { key: 'blame-stronger'; label: string; command: string; use: 'reads' }
  /** `repairer`: the one shadowlap.config.json names, which its card says it asks; null for your own Claude Code. */
  | { key: 'repair'; label: string; command: string; use: 'writes'; repairer: string | null }
  /** The verdict it settles, how many attempts a run it goes up to, and the attempts so far, which start over. */
  | { key: 'more' | 'again'; label: string; command: string; use: 'reads'; verifyId: string; max: number; attempts: number }
  /** `pending`: what applying left undone, which Finish applying does; null otherwise. */
  | { key: 'apply'; label: string; command: string; use: 'writes'; pending: string | null }
  /** Verify this run: the failing runs (`runs`, by id) no accepted verdict checked, on the code as it is now (`actions.verifyLeft`). */
  | { key: 'verify-left'; label: string; command: string; use: 'reads'; runs: string[] }
  /**
   * The blamed run's own step, where it crashed and no model rescued it (fix-crash.ts): Find breaking
   * commit, which holds no working tree, or Revert once that named the commit, which changes it. A row
   * presses it as Needs a look presses a run's step, from `step` and the run.
   */
  | { key: 'bisect'; label: string; command: string; use: 'reads'; runId: string; step: Extract<CrashStep, { key: 'bisect' }> }
  | { key: 'revert'; label: string; command: string; use: 'writes'; runId: string; step: Extract<CrashStep, { key: 'revert' }> };

/** A crash's step as the fix leads with it. */
const crashLead = (runId: string, step: CrashStep): FixLead =>
  step.key === 'bisect' ? { key: 'bisect', label: step.label, command: step.command ?? '', use: 'reads', runId, step } : { key: 'revert', label: step.label, command: step.command ?? '', use: 'writes', runId, step };

/**
 * A repair that tried candidates and accepted none, under the fix's check as it is, with no blame
 * since: running it again would try the same, so the fix waits for what its last verdict left, if
 * anything, or for someone to change the check or blame it again.
 */
export function repairSpent(rec: FixRecords): boolean {
  const last = rec.repairs.at(-1);
  if (!last || last.accepted || !last.report.candidates.some((c) => c.state !== 'invalid' && c.state !== 'untried')) return false;
  return checkKey(last.expect) === rec.fix.check.key && !rec.blames.some((b) => b.at > last.at);
}

/** Run more attempts or Verify again, for the newest verdict that counts when it is incomplete and can be settled; else none. */
function verifyLead(rec: FixRecords, keptMax: number | null): FixLead | null {
  const v = counting(rec).at(-1);
  const more = v ? verifyMore(v, keptMax) : null;
  if (!v || !more) return null;
  return { key: more.kind, label: more.kind === 'more' ? ACTIONS.runMoreAttempts.label : ACTIONS.verifyAgain.label, command: more.command, use: 'reads', verifyId: v.verifyId, max: more.max, attempts: v.report.attempts };
}

/**
 * An open fix's lead: what its spent repair's last verdict left, blame again, a crash's own step once
 * no model rescued it (`crash`: Find breaking commit, then Revert), blame with a stronger model, or
 * Run repair when it can run the agent.
 */
function openLead(rec: FixRecords, actions: FixActions, o: FixLeadOptions): FixLead | null {
  if (repairSpent(rec)) return verifyLead(rec, o.keptMax ?? null);
  const again = actions.blameAgain;
  if (again) return { key: 'blame-again', label: ACTIONS.runBlameAgain.label, command: again.command, use: 'reads', stopped: again.kind === 'stopped', gate: again.gate, soFar: again.soFar, lastGood: again.lastGood };
  if (o.crash) return crashLead(o.crash.runId, o.crash.step);
  const stronger = actions.blameStronger;
  if (stronger) return { key: 'blame-stronger', label: ACTIONS.runBlameStronger.label, command: stronger.command, use: 'reads' };
  // A repair that would end "No fix to try" runs nothing: the row opens the fix, which says why.
  const repair = actions.repair;
  return repair && !repair.noFix ? { key: 'repair', label: ACTIONS.runRepair.label, command: repair.command, use: 'writes', repairer: o.repairer?.trim() || null } : null;
}

/**
 * What a fix's lead reads besides its records: the repairer the config names, its blamed run's crash
 * step, which its caller works out (fix-crash.ts), and the config's `verify.max` (`keptMax`), which Run
 * more attempts keeps a good run's pairs to.
 */
export interface FixLeadOptions {
  repairer: string | null;
  crash?: { runId: string; step: CrashStep } | null;
  keptMax?: number | null;
}

/**
 * The fix's lead: an open fix's (`openLead`); a verified fix's Verify this run, while a failing run
 * no accepted verdict checked is left and its change is in the working tree, then its Apply fix, or
 * Mark applied once its change is in the working tree or has no patch; an applied fix's Finish
 * applying what applying left undone. None for a fix merged with its pull request, a patch `fix
 * apply` refuses, or a fix applied with nothing left to do.
 */
export function fixLead(rec: FixRecords, actions: FixActions, o: FixLeadOptions): FixLead | null {
  if (rec.fix.status === 'open') return openLead(rec, actions, o);
  const left = actions.applied ? null : actions.verifyLeft;
  if (left) return { key: 'verify-left', label: (left.runs.length === 1 ? ACTIONS.verifyThisRun : ACTIONS.verifyTheseRuns).label, command: left.command, use: 'reads', runs: left.runs };
  const apply = actions.apply;
  if (rungOf(rec) === 'merged' || !apply || apply.refused || (actions.applied && !apply.pending)) return null;
  const label = actions.applied ? FINISH_APPLYING : apply.kind === 'mark' || apply.inTree ? MARK_APPLIED : ACTIONS.applyFix.label;
  return { key: 'apply', label, command: apply.command, use: 'writes', pending: actions.applied ? apply.pending : null };
}
