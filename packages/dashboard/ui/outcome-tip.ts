import { STATUS_WORDS } from '../../engine/src/check-status.js';
import { checkWords, RULES_ON_CALLS } from '../../engine/src/checks/labels.js';
import type { CheckStatus } from '../../engine/src/types.js';
import { goldenName } from './format.js';
import { DIVERGED } from './run/banner.js';
import type { JudgedLike, OutcomeOf, RunLike, RunOutcomeWords } from './runs.js';

/**
 * What a run's status says on hover, the same card on Runs' Status and a run's first fact: titled by
 * its verdict ("Check failed", "Inconclusive", "Checks") or by what judged it ("Judged when it was
 * imported", "Today’s checks, judged from the recording"), a line under it, and each check with how
 * it came out. No DOM here: the tests import it.
 */

export interface OutcomeTip {
  title: string;
  sub: string | null;
  /** Each check: its label, how it came out and what it found, and its colour. */
  rows: Array<[string, string, string]>;
  /** The first check that failed, or could not be decided, in a line: what a screen reader is told of the status. */
  said: string | null;
}

const COLOUR: Readonly<Record<CheckStatus, string>> = { passed: 'var(--cq-lime)', failed: 'var(--cq-red)', inconclusive: 'var(--cq-amber)', 'not-applicable': 'var(--cq-muted)' };

/** A check as the card lists it: its label, then its verdict and what decided it, the last clause of a chain where it did not apply (`escalate was never called`). */
function rowOf(c: { label: string; status: CheckStatus; detail: string | null }): [string, string, string] {
  const detail = c.detail ? (c.status === 'not-applicable' ? c.detail.split(': ').pop()! : c.detail) : null;
  return [c.label, `${STATUS_WORDS[c.status]}${detail ? ` · ${detail}` : ''}`, COLOUR[c.status]];
}

/** The check a status names, in a line: `send_email called at most 1 time, but called 2 times`, `judge "polite" answers yes: inconclusive · not judged: …`. */
function firstWords(j: JudgedLike): string | null {
  const f = j.first;
  if (!f) return j.why ?? null;
  const failed = j.verdict === 'failed';
  return checkWords({ label: f.label, detail: f.detail, ok: false, status: failed ? 'failed' : 'inconclusive' }, ', but ');
}

/** `refund’s`, `refund’s and refund-twice’s`: whose checks they are. */
const whose = (goldens: readonly string[]): string => goldens.map((g) => `${goldenName(g)}’s`).join(' and ');

const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** What judged a run, as the card's title and the line under it say. */
function judgedTip(j: JudgedLike): Pick<OutcomeTip, 'title' | 'sub'> & { rows: boolean } {
  if (j.by === 'family') {
    const names = whose(j.goldens ?? []);
    const why = j.why && !j.first ? ` ${upper(j.why)}.` : '';
    if (j.today) return { title: 'Today’s checks, judged from the recording', sub: `This run was recorded before them: ${names} checks, ${j.since === 'changed' ? 'changed since the golden was packed' : 'added with the golden'}.${why}`, rows: true };
    return { title: 'Its family’s checks', sub: `${names} checks, which it was made under.${why}`, rows: true };
  }
  if (j.by === 'import') return { title: j.today ? 'Judged again by today’s rules on calls' : 'Judged when it was imported', sub: j.verdict === 'not-applicable' && j.why ? `Not applicable: ${j.why}.` : `By ${RULES_ON_CALLS}.`, rows: true };
  if (j.verdict === 'failed') return { title: 'Check failed', sub: firstWords(j), rows: false };
  if (j.verdict === 'inconclusive') return { title: 'Inconclusive', sub: firstWords(j), rows: false };
  return { title: j.verdict === 'passed' ? 'Checks' : 'Not applicable', sub: null, rows: true };
}

/** What a divergence was, as a fork's banner says it: `a request changed`, with the path its diff found first where the run says it. */
function divergedWhy(r: Pick<RunLike, 'divergence'>): string | null {
  const d = r.divergence;
  if (!d) return null;
  const path = d.type === 'request_changed' ? d.diff?.[0]?.path : undefined;
  return `${upper(DIVERGED[d.type] ?? d.type)}${path ? ` (~ ${path})` : ''}.`;
}

/**
 * How one comes to judge a run no check judges. A check is added from a tool call: until Add check…
 * is on the page, by packing the run as a golden with checks, or giving a golden of its family some.
 */
function howToCheck(tools: number): string {
  return tools ? 'Pack it as a golden with checks, or give a golden of its family checks under "tests" in shadowlap.config.json.' : 'It made no tool call, and a check on calls reads them.';
}

/** The card for a run's status: `out` is its outcome as outcomeOf says it; `tools`, the tool calls it made (null on a list, which doesn't count them). */
export function outcomeTip(r: RunLike, out: RunOutcomeWords & { of: OutcomeOf }, tools: number | null = null): OutcomeTip {
  const j = r.judged;
  const plain = (title: string, sub: string | null = null): OutcomeTip => ({ title, sub, rows: [], said: sub });
  switch (out.of) {
    case 'judged': {
      const t = judgedTip(j!);
      return { title: t.title, sub: t.sub, rows: t.rows ? (j!.checks ?? []).map(rowOf) : [], said: firstWords(j!) };
    }
    case 'live':
      return plain('Still recording', 'It is judged once it finishes.');
    case 'diverged':
      return plain(`Diverged at #${out.at!.callNo}`, divergedWhy(r));
    case 'check':
      return plain('Check failed', r.outcome?.check ?? null);
    case 'exit':
      return plain(typeof r.exitCode === 'number' && r.exitCode !== 0 ? `The agent exited with code ${r.exitCode}` : 'The agent exited with an error');
    case 'inconclusive':
      return plain('Inconclusive', r.outcome?.check ?? null);
    case 'passed':
      return plain('Checks');
    case 'interrupted':
      return plain('Stopped before it ended', 'Ctrl-C, a kill or a crash: it stopped, and did not fail.');
    default:
      return { title: 'No check applies to this run', sub: tools === null ? null : howToCheck(tools), rows: [], said: null };
  }
}
