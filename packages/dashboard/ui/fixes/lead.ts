import { JOB_KINDS } from '../api.js';
import { shortId } from '../format.js';
import { testsBusy } from '../goldens.js';
import { ACTIONS } from '../labels.js';
import type { FixLead, VerifyStep } from '../types.js';
import { pluralS } from '../../../engine/src/words.js';
import { repairSub } from './estimates.js';
import { blameAgainTip, STRONGER_TIP, treeBusy, type TreeJob } from './model.js';

/**
 * A fix's lead as a list row draws it (fix-lead.ts `fixLead`), on Fixes and on Needs a look alike:
 * the job it starts, what its wait says it does, whether its dialog shows the fix's detail, its card
 * and its wait. Light on purpose: the Overview loads it, and none of a fix's page.
 */

/** Verify your change's card and its ask's lead: what it verifies, and on which runs. */
export const VERIFY_CHANGE_TIP = 'Verifies your change, the code as it is now, on the failing runs, the runs held out and the good runs kept';

/** Verify this run's card: the failing runs it verifies, by their short ids, on the code as it is now. */
export const verifyLeftCard = (runs: readonly string[]): string =>
  `Verifies the code as it is now on ${runs.map(shortId).join(', ')}, the failing run${pluralS(runs.length)} this change wasn’t verified on`;

/** What Run more attempts or Verify again does, on its card and as its ask's lead. */
export const verifyTip = (more: Pick<NonNullable<VerifyStep['more']>, 'kind' | 'max'>): string => (more.kind === 'more' ? `Verifies the change again from the start, up to ${more.max} attempts a run` : 'Verifies the same runs again from the start, once the check can be judged');

/** The job each lead starts. */
export const LEAD_KIND: Readonly<Record<FixLead['key'], string>> = {
  'blame-again': JOB_KINDS.blame,
  'blame-stronger': JOB_KINDS.blame,
  repair: JOB_KINDS.repair,
  apply: JOB_KINDS.applyFix,
  more: JOB_KINDS.verify,
  again: JOB_KINDS.verify,
  'verify-left': JOB_KINDS.verify,
  'verify-change': JOB_KINDS.verify,
  bisect: JOB_KINDS.bisect,
  revert: JOB_KINDS.revert,
};

/** What a lead does once the working tree is free, as its wait says it: "repair once it is done". */
export const LEAD_VERB: Readonly<Record<FixLead['key'], string>> = {
  'blame-again': 'blame again',
  'blame-stronger': 'blame it',
  repair: 'repair',
  apply: 'apply the patch',
  more: 'run more attempts',
  again: 'verify again',
  'verify-left': 'verify it',
  'verify-change': 'verify your change',
  bisect: 'find the breaking commit',
  revert: 'revert it',
};

/** A lead whose dialog shows the fix's detail, read when it is pressed: the rest ask from the lead's own fields. */
export const leadReadsFix = (lead: Pick<FixLead, 'key'>): boolean => lead.key === 'blame-stronger' || lead.key === 'repair' || lead.key === 'apply';

const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** A lead's card sentence, under its label: the words the fix's own page gives the same button. */
export function leadCard(lead: FixLead): string | null {
  switch (lead.key) {
    case 'blame-again':
      return blameAgainTip({ kind: lead.stopped ? 'stopped' : 'unsettled', gate: lead.gate, count: lead.count, underCheck: lead.underCheck });
    case 'blame-stronger':
      return STRONGER_TIP;
    case 'repair':
      return repairSub(lead.repairer);
    case 'apply':
      return lead.pending ? capital(lead.pending) : lead.label === ACTIONS.applyFix.label ? 'Asks first: it changes your working tree' : null;
    case 'verify-left':
      return verifyLeftCard(lead.runs);
    case 'verify-change':
      return VERIFY_CHANGE_TIP;
    case 'bisect':
    case 'revert':
      // A crash's own step, in the words its run's page gives it.
      return lead.step.sub ?? null;
    default:
      return verifyTip({ kind: lead.key, max: lead.max });
  }
}

/** A job leadWait reads: one using the working tree, and what Tests' waits read of it. */
export type LeadJob = TreeJob & Parameters<typeof testsBusy>[0][number];

/**
 * Why a lead can't start now, or null: a job this dashboard doesn't run, or one holding the working
 * tree it would use. A crash's Find breaking commit and Revert wait for Tests' jobs too, as on its
 * run's page (`stepJob`): Revert, which changes the tree, for every job using it.
 */
export function leadWait(lead: FixLead, o: { jobs: readonly LeadJob[]; folder: string | null; projectId?: string | null; hasKind: (kind: string) => boolean }): string | null {
  if (!o.hasKind(LEAD_KIND[lead.key])) return 'This dashboard doesn’t run it: run the command in a terminal.';
  const tests = lead.key === 'bisect' || lead.key === 'revert' ? testsBusy(o.jobs, LEAD_VERB[lead.key], o.projectId ?? null) : null;
  return tests ?? treeBusy(o.jobs, lead.use, LEAD_VERB[lead.key], o.folder);
}
