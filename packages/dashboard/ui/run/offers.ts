import { num, shortId } from '../format.js';
import type { BisectOffer, BlameOffer, RunOffers, TestBannerOffer } from '../types.js';

/**
 * What the run page offers beyond the run's record, in words and choices, without the DOM: Run blame
 * (whether it applies, what it sends, what it does when the server asks for a check or a consent),
 * the diverged test's Add normalizer, and Find the commit's dialog. The tests import it.
 */

/** A shell-quoted value, as the command lines the page shows have it. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The blame a Run blame button starts, as the command it runs: with its check, on the exit status
 * alone (`null`), or with a check still to give (`undefined`, shown as `<check>`).
 */
export function blameCommand(runId: string, expect: unknown): string {
  const check = expect === undefined ? ` --expect '<check>'` : expect === null ? '' : ` --expect ${quote(JSON.stringify(expect))}`;
  return `shadowlap blame ${shortId(runId)}${check}`;
}

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
 * to ask for, or the exit status. Null where blame doesn't apply.
 */
export function blameOfferFor(offers: Pick<RunOffers, 'blame'> | null, f: BlameFacts): BlameOffer | null {
  if (offers) return offers.blame;
  if (f.blamed || f.capture || !f.argv.length || f.status === 'running' || !f.modelCalls) return null;
  const failed = f.failed;
  if (!failed.length && f.status !== 'failed' && f.status !== 'crashed') return null;
  if (f.fixExpect !== undefined && f.fixExpect !== null) return { from: 'fix', expect: f.fixExpect, failed };
  if (failed.length && f.ownExpect && typeof f.ownExpect === 'object' && !Array.isArray(f.ownExpect)) return { from: 'run', expect: f.ownExpect, failed };
  if (failed.length || f.status === 'crashed') return { from: 'ask', failed };
  return { from: 'exit', expect: null, failed };
}

/**
 * What Run blame sends to the fixes' `blame` job: the run, and a check only when one was typed (the
 * job finds the run's check itself, as the CLI judges it, and answers 422 when nothing names it);
 * `yes` once the user agreed to run the command of a run imported from someone else's pack.
 */
export function blameRequest(runId: string, o: { expect?: Record<string, unknown> | null; yes?: boolean } = {}): Record<string, unknown> {
  return { runId, ...(o.expect ? { expect: o.expect } : {}), ...(o.yes ? { yes: true } : {}) };
}

/**
 * What a refused Run blame asks of the page: the check (422: nothing names the check the run
 * failed), a consent (409: the run's command came from an imported pack, which runs only once
 * confirmed), or nothing (any other error, which the drawer shows).
 */
export function blameReply(err: { status?: number; message?: string } | null | undefined): 'check' | 'consent' | null {
  if (err?.status === 422) return 'check';
  if (err?.status === 409 && /imported pack/.test(err.message ?? '')) return 'consent';
  return null;
}

const BLAME_HOVER: Record<BlameOffer['from'], string> = {
  run: 'with the checks it was replayed with',
  golden: 'with its golden’s checks in shadowlap.config.json',
  fix: 'with the check of the fix its labels point to',
  exit: 'on its exit status: a passing run exits 0',
  ask: 'once you give the check a passing run meets',
};

/**
 * Run blame's hover: why it can't run here (with the command to run instead), or what it does and
 * the check it would likely use. The job decides the check itself, and asks when nothing names it.
 */
export function blameHover(runId: string, offer: BlameOffer, o: { canBlame: boolean; actionsOff: string | null }): string {
  if (o.actionsOff) return o.actionsOff;
  if (!o.canBlame) return `This dashboard can’t run blame: ${blameCommand(runId, offer.from === 'ask' ? undefined : offer.expect)}`;
  return `Find the model call where this run was lost, ${BLAME_HOVER[offer.from]}`;
}

/** The checks a run failed, quoted, for the blame dialog: “at most 3 model calls” and 1 more. */
export function failedChecksText(failed: readonly string[]): string | null {
  if (!failed.length) return null;
  return `“${failed[0]}”${failed.length > 1 ? ` and ${num(failed.length - 1)} more` : ''}`;
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

/** The check typed into the blame dialog: an object, as under `expect` in shadowlap.config.json; or why not. */
export function readExpect(text: string): { expect: Record<string, unknown> } | { error: string } {
  const t = text.trim();
  if (!t) return { error: 'Give the check a passing run must meet.' };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { error: 'That is not JSON: a check looks like {"tools":{"send_email":0}}.' };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'A check is an object, such as {"tools":{"send_email":0}}.' };
  return { expect: v as Record<string, unknown> };
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
    title: `Find the commit that broke ${shortId(runId)}`,
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
 * Why Find the commit can't run from here, for the disabled item's hover: what the server says about
 * the run, or that this dashboard has no bisect job (with the command to run instead); null when it can.
 */
export function bisectBlocked(runId: string, b: BisectOffer | null, hasJob: boolean): string | null {
  if (b?.unavailable) return b.unavailable;
  if (!hasJob) return `This dashboard can’t run it: shadowlap bisect ${shortId(runId)} --good <commit>`;
  return null;
}
