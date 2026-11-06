import { ACTIONS, checkKey, type FixRecords, type SprtGate } from '@shadowlap/engine';
import { commandLine, counting, type FixActions, rungOf } from './fix-shared.js';
import { verifyMore } from './fix-verify-step.js';

/**
 * The step a fix leads with, worked out on the server for a list to carry in the words its page
 * uses: what its Fixes row runs or asks, from its records and what its buttons would run
 * (fix-actions.ts), never a call. A lead carries only what a row draws and sends: its label (the
 * engine's `ACTIONS`, or the page's own Mark applied and Finish applying), the command it runs, the
 * working tree's use its wait reads (`writes` for repair and apply, which change it), and per kind
 * what its card says. Null when the fix has no step to lead with: its row opens it.
 */
export type FixLead =
  | { key: 'blame-again'; label: string; command: string; use: 'reads'; stopped: boolean; gate: SprtGate | null }
  | { key: 'blame-stronger'; label: string; command: string; use: 'reads' }
  /** `repairer`: the one shadowlap.config.json names, which its card says it asks; null for your own Claude Code. */
  | { key: 'repair'; label: string; command: string; use: 'writes'; repairer: string | null }
  /** The verdict it settles, and how many attempts a run it goes up to. */
  | { key: 'more' | 'again'; label: string; command: string; use: 'reads'; verifyId: string; max: number }
  /** `pending`: what applying left undone, which Finish applying does; null otherwise. */
  | { key: 'apply'; label: string; command: string; use: 'writes'; pending: string | null };

/**
 * A repair that tried candidates and accepted none, under the fix's check as it is, with no blame
 * since: running it again would try the same, so the fix waits for what its last verdict left, if
 * anything, or for someone to change the check or blame it again.
 */
function repairSpent(rec: FixRecords): boolean {
  const last = rec.repairs.at(-1);
  if (!last || last.accepted || !last.report.candidates.some((c) => c.state !== 'invalid' && c.state !== 'untried')) return false;
  return checkKey(last.expect) === rec.fix.check.key && !rec.blames.some((b) => b.at > last.at);
}

/** Run more attempts or Verify again, for the newest verdict that counts when it is incomplete and can be settled; else none. */
function verifyLead(rec: FixRecords): FixLead | null {
  const v = counting(rec).at(-1);
  const more = v ? verifyMore(v) : null;
  if (!v || !more) return null;
  return { key: more.kind, label: more.kind === 'more' ? ACTIONS.runMoreAttempts.label : ACTIONS.verifyAgain.label, command: more.command, use: 'reads', verifyId: v.verifyId, max: more.max };
}

/** An open fix's lead: what its spent repair's last verdict left, blame again or with a stronger model, or Run repair when it can run the agent. */
function openLead(rec: FixRecords, actions: FixActions, repairer: string | null): FixLead | null {
  if (repairSpent(rec)) return verifyLead(rec);
  const again = actions.blameAgain;
  if (again) return { key: 'blame-again', label: ACTIONS.runBlameAgain.label, command: again.command, use: 'reads', stopped: again.kind === 'stopped', gate: again.gate };
  const stronger = actions.blameStronger;
  if (stronger) return { key: 'blame-stronger', label: ACTIONS.runBlameStronger.label, command: stronger.command, use: 'reads' };
  // A repair that would end "No fix to try" runs nothing: the row opens the fix, which says why.
  const repair = actions.repair;
  return repair && !repair.noFix ? { key: 'repair', label: ACTIONS.runRepair.label, command: repair.command, use: 'writes', repairer: repairer?.trim() || null } : null;
}

/**
 * The fix's lead: an open fix's (`openLead`); a verified or applied fix's Apply fix, Mark applied
 * once its change is in the working tree or has no patch, or Finish applying what applying left
 * undone. None for a fix merged with its pull request, a patch `fix apply` refuses, or a fix applied
 * with nothing left to do.
 */
export function fixLead(rec: FixRecords, actions: FixActions, o: { repairer: string | null }): FixLead | null {
  if (rec.fix.status === 'open') return openLead(rec, actions, o.repairer);
  const apply = actions.apply;
  if (rungOf(rec) === 'merged' || !apply || apply.refused || (actions.applied && !apply.pending)) return null;
  const label = actions.applied ? 'Finish applying' : apply.kind === 'mark' || apply.inTree ? 'Mark applied' : ACTIONS.applyFix.label;
  return { key: 'apply', label, command: commandLine(apply.argv), use: 'writes', pending: actions.applied ? apply.pending : null };
}
