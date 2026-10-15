import { num, shortId } from '../format.js';
import type { BisectOffer, BlameOffer } from '../types.js';

/**
 * What the run page offers beyond the run's record, in words, without the DOM: Run blame and the
 * check it uses, Find the commit's dialog, and the fork menu's whole-run part. The tests import it.
 */

/** A shell-quoted value, as the command lines the page shows have it. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The blame a Run blame button starts, as the command it runs: with its check, or on the exit status alone. */
export function blameCommand(runId: string, expect: unknown): string {
  return `shadowlap blame ${shortId(runId)}${expect === null || expect === undefined ? '' : ` --expect ${quote(JSON.stringify(expect))}`}`;
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
