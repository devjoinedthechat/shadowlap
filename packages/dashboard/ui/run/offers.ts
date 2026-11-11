import type { CostWords, FactWords } from '../actions.js';
import { goldenName, num, shortId } from '../format.js';
import { commandText } from '../goldens.js';
import { divergedWhere, insteadOf, recordingCost, replacedIf, updateSteps, type UpdatePlan } from '../update-words.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { bisectBadFact, bisectCost, FLAKY_NOTE, revisionTally, type GoodChoice } from '../runspage/find-commit.js';
import type { BisectOffer, BlameOffer, TestBannerOffer } from '../types.js';

/**
 * What the run page offers beyond the run's record, in words and choices, without the DOM: Run blame
 * (whether it applies, and the check it would likely use; Fixes' button sends it), the diverged
 * test's Add normalizer, and Find breaking commit's dialog. The tests import it.
 */

/** A shell-quoted value, as the command lines the page shows have it. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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

/**
 * Update golden on a test replay's page, as the Tests screen words it. `replayChecks`, how many checks
 * this replay was judged by, stands in for the golden's own from a server that doesn't send them (or
 * for a golden no longer on disk, which an update refuses).
 */
export function updateGoldenCopy(t: TestBannerOffer, callNo: number, canNormalize: boolean, replayChecks = 0): UpdatePlan {
  const v = t.volatile;
  const own = Array.isArray(t.checks) ? t.checks.length : null;
  const name = goldenName(t.golden);
  const perRun = !!v?.certain && !t.normalized;
  const run = perRun && canNormalize ? (updatesAfterRules(t) ? 'normalize-update' : 'normalize') : null;
  const instead = run ? insteadOf(run, t.normalizeAndTest ?? [], t.golden, false) : null;
  const replaced = own === null && !replayChecks ? 'Replaced only if its checks pass' : replacedIf(own ?? replayChecks);
  return {
    title: `Update ${name}?`,
    lead: `Re-records ${name}, for a change you meant.`,
    doc: 'goldenUpdates',
    facts: [],
    goldens: [{ path: t.golden, name, where: divergedWhere({ callNo, volatile: v ?? null }) }],
    steps: updateSteps(replaced, perRun ? (v?.looks ?? 'value') : null),
    advise: perRun && v ? { title: 'A normalizer fixes this for good', text: `is ${v.looks}, new every run. ${instead ? `${instead.label} masks it first.` : 'Updating re-records it, and the next run diverges again.'}`, path: v.path } : null,
    instead,
    note: null,
    command: commandText(['test', t.golden, '--update']),
    cost: recordingCost(true),
    ok: perRun ? 'Update anyway' : confirmWords(ACTIONS.updateGolden.label),
  };
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

export interface BisectCopy {
  title: string;
  /** Its confirm: the menu item's name without the ellipsis. */
  ok: string;
  lead: string;
  /** Good commit, or Start from for a run that passed. */
  label: string;
  /** The revisions to pick from, newest first, each with how its runs went; any other is accepted too. */
  choices: GoodChoice[];
  initial: string;
  facts: FactWords[];
  cost: CostWords;
  /** What one live replay can't settle, for a fork. */
  note: string | null;
  /** The command with a good commit filled in. */
  command: (good: string) => string;
}

/**
 * What the server may add to Find breaking commit's choices: each commit's subject, from the project's git
 * (`c91d0f4 · Escalate refunds above the limit`), and the check each replay is judged by, for a run
 * blame found failing one though it exited 0 (`--expect`).
 */
type BisectFrom = Omit<BisectOffer, 'revisions'> & { revisions: ReadonlyArray<BisectOffer['revisions'][number] & { subject?: string | null }>; expect?: Record<string, unknown> | null };

/** The command Find breaking commit runs from `good`: what it searches (a run, or the golden a test replay came from), up to which commit, and how each is judged. */
function bisectLine(b: BisectFrom, good: string): string {
  const target = b.target.kind === 'golden' ? b.target.golden : shortId(b.target.runId);
  const expect = b.expect && Object.keys(b.expect).length ? ` --expect ${quote(JSON.stringify(b.expect))}` : '';
  return `shadowlap bisect ${target} --good ${good}${b.bad ? ` --bad ${b.bad}` : ''}${expect}${b.fork ? ' --fork' : ''}`;
}

/** Find breaking commit's command for its hover card, before its dialog asks for a commit: from the one the server knows, else `<commit>`. */
/** A Find breaking commit with nothing known about the run's revisions: the dialog asks for a commit, on the run's page and from Needs a look. */
export const unknownBisect = (runId: string): BisectOffer => ({ target: { kind: 'run', runId }, failed: true, good: null, bad: null, revisions: [], fork: false, live: false, unavailable: null, args: null });

export const bisectCardCommand = (offer: BisectOffer): string => `$ ${bisectLine(offer, offer.good ?? '<commit>')}`;

/**
 * Find breaking commit's dialog, from what the server offers: a run that failed looks for where it
 * started failing, from a commit where it still worked up to its own; one that passed, for the first
 * commit after its own that changes what it does. Replays are free unless they run live past where
 * they differ. Each commit is named by its subject when the server knows it, as the design does.
 */
export function bisectCopy(runId: string, offer: BisectOffer): BisectCopy {
  const b = offer as BisectFrom;
  const target = b.target.kind === 'golden' ? b.target.golden : shortId(b.target.runId);
  const whose = b.target.kind === 'golden' ? target : 'the run';
  const runs = (r: { runs: number }) => `${r.runs === 1 ? '1 run' : `${num(r.runs)} runs`} of its command`;
  const choices: GoodChoice[] = b.revisions.map((r) => ({ value: r.rev, subject: r.subject ?? null, how: `${runs(r)} · ${revisionTally(r)}` }));
  if (b.good && !choices.some((c) => c.value === b.good)) choices.unshift({ value: b.good, subject: null, how: b.failed ? 'where it last passed' : 'this run' });
  return {
    title: b.failed ? `Find breaking commit for ${shortId(runId)}` : `Find commit that changed ${shortId(runId)}`,
    ok: confirmWords(bisectLabel(b).label),
    lead: b.failed ? `Finds the first commit that broke ${whose}, from one where it worked.` : `Finds the first commit after its own that changed what ${whose === 'the run' ? 'the run does' : `${whose} does`}.`,
    label: b.failed ? 'Good commit' : 'Start from',
    choices,
    initial: b.good ?? choices[0]?.value ?? '',
    facts: b.failed ? [bisectBadFact(b)] : [],
    cost: bisectCost(b),
    note: b.fork ? FLAKY_NOTE : null,
    command: (good) => bisectLine(b, !good || good === '…' ? '…' : quote(good)),
  };
}

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
