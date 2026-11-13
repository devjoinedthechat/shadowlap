import { STATUS_WORDS } from '../../engine/src/check-status.js';
import { RULES_ON_CALLS } from '../../engine/src/checks/labels.js';
import type { CheckStatus } from '../../engine/src/types.js';
import { goldenName } from './format.js';
import { type CardAsk, divergedWhy, exitWords, firstWords, FIXED_SUB, INTERRUPTED, LIVE, type OutcomeTip, upper } from './outcome-tip.js';
import type { JudgedLike, OutcomeOf, RunLike, RunOutcomeWords } from './runs.js';

/**
 * What a run's status says on hover, the same card on Runs' Status and a run's first fact: titled by
 * its verdict ("Check failed", "Inconclusive", "Checks") or by what judged it ("Judged when it was
 * imported", "Today’s checks, judged from the recording"), a line under it, and each check with how
 * it came out. The run page loads it as the pointer or the focus first reaches its status, and keeps
 * what a screen reader is told of it (outcome-tip.ts). No DOM here: the tests import it.
 */

const COLOUR: Readonly<Record<CheckStatus, string>> = { passed: 'var(--cq-lime)', failed: 'var(--cq-red)', inconclusive: 'var(--cq-amber)', 'not-applicable': 'var(--cq-muted)' };

/** A check as the card lists it: its label, then its verdict and what decided it, the last clause of a chain where it did not apply (`escalate was never called`). */
function rowOf(c: { label: string; status: CheckStatus; detail: string | null }): [string, string, string] {
  const detail = c.detail ? (c.status === 'not-applicable' ? c.detail.split(': ').pop()! : c.detail) : null;
  return [c.label, `${STATUS_WORDS[c.status]}${detail ? ` · ${detail}` : ''}`, COLOUR[c.status]];
}

/** `refund’s`, `refund’s and refund-twice’s`: whose checks they are. */
const whose = (goldens: readonly string[]): string => goldens.map((g) => `${goldenName(g)}’s`).join(' and ');

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

/**
 * How one comes to judge a run no check judges. Where the page offers Add check… on its tool calls,
 * a check is added from one there; elsewhere (a capture, an exported copy, a read-only dashboard) it
 * is told where a golden's checks go.
 */
function howToCheck(tools: number, offered: boolean): string {
  if (!offered) return tools ? 'Pack it as a golden with checks, or give a golden of its family checks under "tests" in shadowlap.config.json.' : 'It made no tool call, and a check on calls reads them.';
  return tools ? 'Pick a tool call and use Add check… in the inspector, or pack the run as a golden with its checks.' : 'It made no tool call, and a check is added from one.';
}

/**
 * The card for a run's status: `out` is its outcome as outcomeOf says it; `tools`, the tool calls it
 * made (null on a list, which doesn't count them); `offered`, whether the page offers Add check… on them.
 */
export function outcomeTip(r: RunLike, out: RunOutcomeWords & { of: OutcomeOf }, tools: number | null = null, offered = false): OutcomeTip {
  const j = r.judged;
  const plain = (title: string, sub: string | null = null): OutcomeTip => ({ title, sub, rows: [], said: sub });
  switch (out.of) {
    case 'judged': {
      const t = judgedTip(j!);
      return { title: t.title, sub: t.sub, rows: t.rows ? (j!.checks ?? []).map(rowOf) : [], said: firstWords(j!) };
    }
    case 'live':
      return plain('Still recording', LIVE);
    case 'fixed':
      return plain('Passes since', FIXED_SUB(r));
    case 'diverged':
      return plain(`Diverged at #${out.at!.callNo}`, divergedWhy(r));
    case 'check':
      return plain('Check failed', r.outcome?.check ?? null);
    case 'exit':
      return plain(exitWords(r.exitCode));
    case 'inconclusive':
      return plain('Inconclusive', r.outcome?.check ?? null);
    case 'passed':
      return plain('Checks');
    case 'interrupted':
      return plain('Stopped before it ended', INTERRUPTED);
    default:
      return { title: 'No check applies to this run', sub: tools === null ? null : howToCheck(tools, offered && !r.source), rows: [], said: null };
  }
}

/** A run's first fact's card: the one worked out with it, else the one its checks give (metrics.ts `outcomeFact`). */
export function factCard(f: { tip: OutcomeTip | null; card: CardAsk | null }): OutcomeTip | null {
  return f.tip ?? (f.card ? outcomeTip(f.card.r, f.card.out, f.card.tools, f.card.offered) : null);
}
