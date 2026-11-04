import { num, shortId } from '../format.js';
import { isObject } from '../../../engine/src/is-object.js';
import { bisectCost } from '../runspage/find-commit.js';
import type { BisectOffer, BlameOffer, RunOffers, TestBannerOffer } from '../types.js';

/**
 * What the run page offers beyond the run's record, in words and choices, without the DOM: Run blame
 * (whether it applies, and the check it would likely use; Fixes' button sends it), the diverged
 * test's Add normalizer, and Find the commit's dialog. The tests import it.
 */

/** A shell-quoted value, as the command lines the page shows have it. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** What the page knows of a run for Run blame when the server sends no offers (an older server). */
export interface BlameFacts {
  /** Blame has been run on it already. */
  blamed: boolean;
  /** It came from a capture, with no command to run again. */
  capture: boolean;
  argv: readonly string[];
  status: string;
  /** The labels of the checks it failed. */
  failed: string[];
  /** The check of the fix its labels point to (`blameExpect`). */
  fixExpect: unknown;
  /** Its own `--expect`. */
  ownExpect: unknown;
  /** How many model calls it made: blame asks them again, so a run with none has nothing to blame. */
  modelCalls: number;
}

/**
 * Run blame for a failed run: what the server offers, or, from a server that offers nothing, the
 * same worked out from the run: the check the fix's labels suggest, the run's own --expect, a check
 * to ask for, or the exit status. Null where blame doesn't apply, as on an interrupted run that
 * failed no check (blame needs a run that fails again as recorded).
 */
export function blameOfferFor(offers: Pick<RunOffers, 'blame'> | null, f: BlameFacts): BlameOffer | null {
  if (offers) return offers.blame;
  if (f.blamed || f.capture || !f.argv.length || f.status === 'running' || !f.modelCalls) return null;
  const failed = f.failed;
  if (!failed.length && f.status !== 'failed') return null;
  if (f.fixExpect !== undefined && f.fixExpect !== null) return { from: 'fix', expect: f.fixExpect, failed };
  if (failed.length && isObject(f.ownExpect)) return { from: 'run', expect: f.ownExpect, failed };
  if (failed.length) return { from: 'ask', failed };
  return { from: 'exit', expect: null, failed };
}

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

/** A golden as the Tests screen names it: its path without the goldens folder. */
export const goldenName = (golden: string): string => golden.replace(/^goldens\//, '');

/**
 * The diverged test's actions. Once every rule Add normalizer adds is in the config, the banner says
 * "normalizer added", with the passing replay that followed when there is one. Before that, Add
 * normalizer is the tests' `normalize-and-test` job (shown disabled with why where jobs can't run),
 * or, on a server without it, the run's own normalizer action (the rule alone). When the rule alone
 * makes the replay match, the job adds it and runs the golden again, in one click. When it can't,
 * the job re-records the golden live after it: the button reads "Add normalizer and update…", and
 * `asks` holds the commands the Tests screen's dialog lists before the job starts. Update golden is
 * the tests' `test-update` job, offered until the rule is in, and after that while the rule alone
 * can't make the replay match and no replay has passed since.
 */
export type NormalizerChoice =
  | { kind: 'added'; passingRun: string | null }
  | { kind: 'job'; label: 'Add normalizer' | 'Add normalizer and update…'; lead: boolean; off: string | null; title: string | null; asks: string[][] | null }
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
  // An id that may be a real change: neither button leads.
  const lead = t ? t.normalizerFixes && !t.maybeReal : true;
  const normalizer: NormalizerChoice =
    t?.normalizeAndTest && o.hasNormalizeJob
      ? { kind: 'job', label: updates ? 'Add normalizer and update…' : 'Add normalizer', lead, off: o.actionsOff, title: o.actionsOff ?? t.volatile?.command ?? null, asks: updates ? t.normalizeAndTest : null }
      : o.action && !o.actionsOff
        ? { kind: 'action' }
        : null;
  return { normalizer, update: !!t && o.hasUpdateJob };
}

/**
 * The run page's Update golden dialog in the Tests screen's words for one golden: where it diverged;
 * the checks the update runs (the golden's now, or its exit status when it has none); when what
 * diverged is a value that changes every run and no rule masks it yet, the amber note that a
 * normalizer is the lasting fix, with its button named for what it runs (`instead`: the rule and a
 * re-run, or the rule and this update when the rule alone can't make the replay match; null where
 * the server can't add it); or, once the rule is in the config, the line saying the run after this
 * update matches.
 */
export interface UpdateGoldenCopy {
  name: string;
  at: string;
  /** What "Its checks run" says: `2 checks`, `exit status`. */
  checks: string;
  advise: { path: string; text: string; instead: string | null } | null;
  /** The plain line above the command, its path set in code. */
  note: { path: string | null } | null;
  ok: 'Update' | 'Update anyway';
}

const checkCount = (n: number) => `${num(n)} ${n === 1 ? 'check' : 'checks'}`;

/**
 * `replayChecks`, how many checks this replay was judged by, stands in for the golden's own from a
 * server that doesn't send them (or for a golden no longer on disk, which an update refuses).
 */
export function updateGoldenCopy(t: TestBannerOffer, callNo: number, canNormalize: boolean, replayChecks = 0): UpdateGoldenCopy {
  const v = t.volatile;
  const own = Array.isArray(t.checks) ? t.checks.length : null;
  const checks = own !== null ? (own ? checkCount(own) : 'exit status') : replayChecks ? checkCount(replayChecks) : 'from shadowlap.config.json';
  const advise =
    v?.certain && !t.normalized
      ? {
          path: v.path,
          text: `${v.op === 'added' ? 'is new in every request and ' : ''}looks like ${v.looks}, which changes every run. Updating re-records it, and the next run diverges again.`,
          instead: canNormalize ? (updatesAfterRules(t) ? 'Add the normalizer and update' : 'Add the normalizer instead') : null,
        }
      : null;
  return {
    name: goldenName(t.golden),
    at: `diverged at call ${callNo}`,
    checks,
    advise,
    note: t.normalized && updatesAfterRules(t) ? { path: v?.path ?? null } : null,
    ok: advise ? 'Update anyway' : 'Update',
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
  text: string;
  label: string;
  /** The revisions to pick from, newest first, each with how its runs went; any other is accepted too. */
  choices: Array<{ value: string; label: string }>;
  initial: string;
  /** The command with a good commit filled in. */
  command: (good: string) => string;
}

/**
 * What the server may add to Find the commit's choices: each commit's subject, from the project's git
 * (`c91d0f4 · Escalate refunds above the limit`), and the check each replay is judged by, for a run
 * blame found failing one though it exited 0 (`--expect`).
 */
type BisectFrom = Omit<BisectOffer, 'revisions'> & { revisions: ReadonlyArray<BisectOffer['revisions'][number] & { subject?: string | null }>; expect?: Record<string, unknown> | null };

/**
 * Find the commit's dialog, from what the server offers: a run that failed looks for where it
 * started failing, from a commit where it still worked up to its own; one that passed, for the first
 * commit after its own that changes what it does. Replays are free unless they run live past where
 * they differ. Each commit is named by its subject when the server knows it, as the design does.
 */
export function bisectCopy(runId: string, offer: BisectOffer): BisectCopy {
  const b = offer as BisectFrom;
  const target = b.target.kind === 'golden' ? b.target.golden : shortId(b.target.runId);
  const upTo = b.bad ?? 'HEAD';
  // A run that failed on its own: one live replay decides each commit, which a failure that comes and goes can pass.
  const cost = bisectCost(b);
  const choices = b.revisions.map((r) => ({ value: r.rev, label: `${r.rev} · ${r.subject ? r.subject : `${r.runs === 1 ? '1 run' : `${num(r.runs)} runs`}${r.failed ? `, ${num(r.failed)} failed` : ''}${r.inconclusive ? `, ${num(r.inconclusive)} inconclusive` : ''}`}` }));
  const expect = b.expect && Object.keys(b.expect).length ? ` --expect ${quote(JSON.stringify(b.expect))}` : '';
  if (b.good && !choices.some((c) => c.value === b.good)) choices.unshift({ value: b.good, label: b.failed ? `${b.good} · where it last passed` : `${b.good} · this run` });
  return {
    title: b.failed ? `Find breaking commit for ${shortId(runId)}` : `Find commit that changed ${shortId(runId)}`,
    ok: bisectLabel(b).label.replace(/…$/, ''),
    text: b.failed
      ? `Replays ${b.target.kind === 'golden' ? target : 'the run'} at commits between a good one and ${upTo}, halving each time, and names the first where it fails. ${cost}`
      : `Replays ${b.target.kind === 'golden' ? target : 'the run'} at commits from ${b.good ?? 'its own'} to HEAD, halving each time, and names the first where it does something else. ${cost}`,
    label: b.failed ? 'A commit where it still worked' : 'Start from',
    choices,
    initial: b.good ?? choices[0]?.value ?? '',
    command: (good) => `shadowlap bisect ${target} --good ${!good || good === '…' ? '…' : quote(good)}${b.bad ? ` --bad ${b.bad}` : ''}${expect}${b.fork ? ' --fork' : ''}`,
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
    ? { label: 'Find commit that changed it…', hint: 'Replays it at the commits after its own, halving each time, and names the first where it does something else' }
    : { label: 'Find breaking commit…', hint: 'Replays it at commits between a good one and its own, halving each time' };
}

/**
 * Why Find the commit can't run from here, for the disabled item's hover: what the server says about
 * the run, or that this dashboard has no bisect job (with the command to run instead); null when it can.
 */
export function bisectBlocked(runId: string, b: BisectOffer | null, hasJob: boolean): string | null {
  if (b?.unavailable) return b.unavailable;
  if (!hasJob) return `This dashboard can’t run it: shadowlap bisect ${shortId(runId)} --good <commit>`;
  return null;
}
