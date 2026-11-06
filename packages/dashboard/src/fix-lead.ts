import { ACTIONS, type FixRecords, repairArgv, repairJobArgv, repairToApply, shownBlame, type Store } from '@shadowlap/engine';
import { blameNext } from './fix-blame-step.js';
import { APPLY_SUB, BLAME_STRONGER_SUB, blameAgainSub, MARK_APPLIED, repairSub } from './fix-lead-words.js';
import { commandLine, type PatchCheck, patchMerged, short } from './fix-shared.js';

/**
 * A fix's lead step, what its row leads with on Needs a look and on Fixes: Apply fix on a verified
 * fix with a patch, Mark applied on one with none or whose patch is in the tree already; on an open
 * fix, Run blame again while its blame couldn't settle or stopped part way, Run blame with stronger
 * model… where asking the recorded model again rescued it from no call, else Run repair where it
 * has failing runs to repair from. `sub` is the card's sentence, `command` what it runs as a person
 * would type it.
 */
export interface FixLead {
  key: 'repair' | 'blame-again' | 'blame-stronger' | 'apply' | 'mark';
  label: string;
  sub: string | null;
  command: string | null;
}

const shortIds = (argv: readonly string[]) => argv.map((a) => (/^[0-9A-Z]{26}$/.test(a) ? short(a) : a));

/** A fix's lead step, or null for one applied, or open with nothing to start from here. */
export function fixLead(store: Store, rec: FixRecords, o: { patchInTree?: PatchCheck | undefined; repairer?: string | null } = {}): FixLead | null {
  const fix = rec.fix;
  const apply = commandLine(['fix', 'apply', fix.fixId]);
  if (fix.status === 'verified') {
    const mark = !repairToApply(rec) || patchMerged(rec, o.patchInTree);
    return mark ? { key: 'mark', label: MARK_APPLIED, sub: null, command: apply } : { key: 'apply', label: ACTIONS.applyFix.label, sub: APPLY_SUB, command: apply };
  }
  if (fix.status !== 'open') return null;
  const next = blameNext(store, rec, shownBlame(rec));
  if (next.blameAgain) return { key: 'blame-again', label: ACTIONS.runBlameAgain.label, sub: blameAgainSub(next.blameAgain), command: next.blameAgain.command };
  if (next.blameStronger) return { key: 'blame-stronger', label: ACTIONS.runBlameStronger.label, sub: BLAME_STRONGER_SUB, command: next.blameStronger.command };
  const argv = repairArgv(store, rec);
  if (!argv.length) return null;
  const repairer = o.repairer?.trim() || null;
  return { key: 'repair', label: ACTIONS.runRepair.label, sub: repairSub(repairer), command: commandLine(repairJobArgv(shortIds(argv), repairer)) };
}
