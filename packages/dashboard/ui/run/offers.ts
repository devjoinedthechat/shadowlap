import { num, shortId } from '../format.js';
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
  if (failed.length && f.ownExpect && typeof f.ownExpect === 'object' && !Array.isArray(f.ownExpect)) return { from: 'run', expect: f.ownExpect, failed };
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
 * The diverged test's actions. Once every rule Add normalizer adds is in the config, the banner says
 * "normalizer added", with the passing replay that followed when there is one. Before that, Add
 * normalizer is the tests' `normalize-and-test` job (adds the rule and runs the golden again; shown
 * disabled with why where jobs can't run), or, on a server without it, the run's own normalizer
 * action; Update golden is the tests' `test-update` job.
 */
export type NormalizerChoice = { kind: 'added'; passingRun: string | null } | { kind: 'job'; lead: boolean; off: string | null; title: string | null } | { kind: 'action' } | null;

export function divergedActions(o: {
  test: TestBannerOffer | null;
  hasNormalizeJob: boolean;
  hasUpdateJob: boolean;
  /** The run's own normalizer action (`n`), when it has one. */
  action: boolean;
  actionsOff: string | null;
}): { normalizer: NormalizerChoice; update: boolean } {
  const t = o.test;
  if (t?.normalized) return { normalizer: { kind: 'added', passingRun: t.passingRun }, update: false };
  // An id that may be a real change: neither button leads.
  const lead = t ? t.normalizerFixes && !t.maybeReal : true;
  const normalizer: NormalizerChoice =
    t?.normalizeAndTest && o.hasNormalizeJob ? { kind: 'job', lead, off: o.actionsOff, title: o.actionsOff ?? t.volatile?.command ?? null } : o.action && !o.actionsOff ? { kind: 'action' } : null;
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

export interface BisectCopy {
  title: string;
  text: string;
  label: string;
  /** The revisions to pick from, newest first, each with how its runs went; any other is accepted too. */
  choices: Array<{ value: string; label: string }>;
  initial: string;
  /** The command with a good commit filled in. */
  command: (good: string) => string;
}

/**
 * Find the commit's dialog, from what the server offers: a run that failed looks for where it
 * started failing, from a commit where it still worked up to its own; one that passed, for the first
 * commit after its own that changes what it does. Replays are free unless they run live past where
 * they differ.
 */
export function bisectCopy(runId: string, b: BisectOffer): BisectCopy {
  const target = b.target.kind === 'golden' ? b.target.golden : shortId(b.target.runId);
  const upTo = b.bad ?? 'HEAD';
  const cost = b.live ? 'Each replay runs live from where its requests differ, so this costs tokens.' : 'Replays are free, so this costs no tokens.';
  const choices = b.revisions.map((r) => ({ value: r.rev, label: `${r.rev} · ${r.runs === 1 ? '1 run' : `${num(r.runs)} runs`}${r.failed ? `, ${num(r.failed)} failed` : ''}` }));
  if (b.good && !choices.some((c) => c.value === b.good)) choices.unshift({ value: b.good, label: b.failed ? `${b.good} · where it last passed` : `${b.good} · this run` });
  return {
    title: `${bisectLabel(b).label.replace(/ it$/, '')} ${shortId(runId)}`,
    text: b.failed
      ? `Replays ${b.target.kind === 'golden' ? target : 'the run'} at commits between a good one and ${upTo}, halving each time, and names the first where it fails. ${cost}`
      : `Replays ${b.target.kind === 'golden' ? target : 'the run'} at commits from ${b.good ?? 'its own'} to HEAD, halving each time, and names the first where it does something else. ${cost}`,
    label: b.failed ? 'A commit where it still worked' : 'Start from',
    choices,
    initial: b.good ?? choices[0]?.value ?? '',
    command: (good) => `shadowlap bisect ${target} --good ${!good || good === '…' ? '…' : quote(good)}${b.bad ? ` --bad ${b.bad}` : ''}${b.fork ? ' --fork' : ''}`,
  };
}

/**
 * Find the commit's name in the fork menu and the palette, and its hover when it can run: the commit
 * that broke a run that failed (or one nothing is known of); for a run that passed, the first commit
 * after its own that changed what it does.
 */
export function bisectLabel(b: Pick<BisectOffer, 'failed'> | null | undefined): { label: string; hint: string } {
  return b && !b.failed
    ? { label: 'Find the commit that changed it', hint: 'Replays it at the commits after its own, halving each time, and names the first where it does something else' }
    : { label: 'Find the commit that broke it', hint: 'Replays it at commits between a good one and its own, halving each time' };
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
