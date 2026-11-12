import { goldenName, shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import type { BisectOffer, BlameOffer, TestBannerOffer } from '../types.js';

/**
 * What the run page offers beyond the run's record, in words and choices, without the DOM: Run blame
 * (whether it applies, and the check it would likely use; Fixes' button sends it), the diverged
 * test's Add normalizer, and whether Find breaking commit can run. The words of its dialog and Update
 * golden's plan are in dialog-copy.ts, which only the dialogs load. The tests import it.
 */

const BLAME_HOVER: Record<BlameOffer['from'], string> = {
  run: 'with the checks it was replayed with',
  golden: 'with its golden’s checks in shadowlap.config.json',
  fix: 'with the check of the fix its labels point to',
  exit: 'on its exit status: a passing run exits 0',
  ask: 'once you give the check a passing run meets',
};

/**
 * Run blame's hover when nothing stops it: what it does, and the check it would likely use. The job
 * decides the check itself, and asks when nothing names it; a read-only dashboard or a working tree
 * held by a repair says why on the button instead.
 */
export function blameTitle(offer: BlameOffer): string {
  return `Find the model call where this run was lost, ${BLAME_HOVER[offer.from]}`;
}

/**
 * Whether the rules alone can't make the diverged test's replay match (the request carries a field
 * the recording never had, or more changed), so adding them updates the golden after them: the steps
 * end in `test <golden> --update`, as the Tests screen reads them.
 */
export function updatesAfterRules(t: Pick<TestBannerOffer, 'normalizeAndTest'>): boolean {
  return !!t.normalizeAndTest && (t.normalizeAndTest.at(-1) ?? []).includes('--update');
}

/** A golden as the Tests screen names it (format.ts). */
export { goldenName };

/**
 * The diverged test's actions. Once every rule Add normalizer adds is in the config, the banner says
 * "normalizer added", with the passing replay that followed when there is one. Before that, Add
 * normalizer is the tests' `normalize-and-test` job (shown disabled with why where jobs can't run),
 * or, on a server without it, the run's own normalizer action (the rule alone). When the rule alone
 * makes the replay match, the job adds it and runs the golden again, in one click. When it can't,
 * the job re-records the golden live after it: the button reads "Add normalizer and update", and
 * `asks` holds the commands the Tests screen's dialog lists before the job starts. Update golden is
 * the tests' `test-update` job, offered until the rule is in, and after that while the rule alone
 * can't make the replay match and no replay has passed since.
 */
export type NormalizerChoice =
  | { kind: 'added'; passingRun: string | null }
  | { kind: 'job'; label: string; off: string | null; title: string | null; asks: string[][] | null }
  | { kind: 'action' }
  | null;

export function divergedActions(o: {
  test: TestBannerOffer | null;
  hasNormalizeJob: boolean;
  hasUpdateJob: boolean;
  /** The run's own normalizer action (`n`), when it has one. */
  action: boolean;
  actionsOff: string | null;
}): { normalizer: NormalizerChoice; update: boolean } {
  const t = o.test;
  const updates = !!t && updatesAfterRules(t);
  if (t?.normalized) return { normalizer: { kind: 'added', passingRun: t.passingRun }, update: o.hasUpdateJob && updates && !t.passingRun };
  const normalizer: NormalizerChoice =
    t?.normalizeAndTest && o.hasNormalizeJob
      ? { kind: 'job', label: updates ? ACTIONS.addNormalizerAndUpdate.label : ACTIONS.addNormalizerAndRerun.label, off: o.actionsOff, title: o.actionsOff ?? t.volatile?.command ?? null, asks: updates ? t.normalizeAndTest : null }
      : o.action && !o.actionsOff
        ? { kind: 'action' }
        : null;
  return { normalizer, update: !!t && o.hasUpdateJob };
}

/** What Run blame says before it runs: where its check came from. */
export function blameSource(offer: BlameOffer): string {
  switch (offer.from) {
    case 'run':
      return 'the checks this run was replayed with';
    case 'golden':
      return 'its golden’s checks in shadowlap.config.json';
    case 'fix':
      return 'the check of the fix its labels point to';
    case 'exit':
      return 'the exit status: a passing run exits 0';
    case 'ask':
      return 'a check you give';
  }
}

/** A Find breaking commit with nothing known about the run's revisions: the dialog asks for a commit, on the run's page and from Needs a look. */
export const unknownBisect = (runId: string): BisectOffer => ({ target: { kind: 'run', runId }, failed: true, good: null, bad: null, revisions: [], fork: false, live: false, unavailable: null, args: null });

/**
 * Find breaking commit…'s name in the fork menu and the palette, as the terminal UI's names it, and
 * its hover when it can run: the commit that broke a run that failed (or one nothing is known of);
 * for a run that passed, the first commit after its own that changed what it does. It asks for a
 * commit first, so it ends in an ellipsis.
 */
export function bisectLabel(b: Pick<BisectOffer, 'failed'> | null | undefined): { label: string; hint: string } {
  return b && !b.failed
    ? { label: ACTIONS.findChangingCommit.label, hint: 'Names the first commit after its own where it does something else' }
    : { label: ACTIONS.findBreakingCommit.label, hint: 'Replays it at commits between a good one and its own, halving each time' };
}

/**
 * Why Find breaking commit can't run from here, for the disabled item's hover: what the server says about
 * the run, or that this dashboard has no bisect job (with the command to run instead); null when it can.
 */
export function bisectBlocked(runId: string, b: BisectOffer | null, hasJob: boolean): string | null {
  if (b?.unavailable) return b.unavailable;
  if (!hasJob) return `This dashboard can’t run it: shadowlap bisect ${shortId(runId)} --good <commit>`;
  return null;
}
