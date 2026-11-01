import type { CostReport } from '../injection.js';
import type { TestResultData } from '../store.js';
import { counted, CUT_SHORT_LINE, liveFrom, noEstimate, noPriceWords, type Estimate, type ExpectedFigure, type PricedCall } from './estimate.js';
import { amountWords, centsWords } from './spending.js';

/**
 * What Tests' jobs bill. Run tests: what the last session spent live, its fork goldens' attempts,
 * their judges and its injection gates, or nothing when every golden replays offline. Run more
 * attempts on a gate still inconclusive: every attempt up to its higher limit, each as dear as its
 * costliest so far, with what the gate is expected to take. Update golden(s): each golden recorded
 * again, about what its recording cost. Find breaking commit on a golden marked fork: every commit it
 * may test, its gate run live at each; on a run, one live replay a commit. A job that runs something
 * live and is priced at what one before it spent has no estimate when that spent nothing live, or met
 * a model with no price: neither says what the next one bills.
 */

/** A session's result for one golden, as the store keeps it: what its attempts and its judges spent live. */
export type SessionResult = { data: Pick<TestResultData, 'spent' | 'judge'> | null };

/** What an injection gate's test spent, as its report keeps it. */
export type GateSpend = Pick<CostReport, 'spent' | 'unknownModels'>;

/** What results spent live, their judges' calls with theirs, and the models among them with no price. */
function spendOf(results: readonly SessionResult[], gates: readonly GateSpend[] = []): { usd: number; unpriced: string[] } {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const r of results) {
    usd += (r.data?.spent ?? 0) + (r.data?.judge?.spent ?? 0);
    for (const m of r.data?.judge?.unknownModels ?? []) unpriced.add(m);
  }
  for (const g of gates) {
    usd += g.spent;
    for (const m of g.unknownModels) unpriced.add(m);
  }
  return { usd, unpriced: [...unpriced] };
}

/** Why a spend says nothing of what the next job bills: a model with no price among it, or nothing spent live (`nothing`); null when it says what it should. */
function spendNone(spend: { usd: number; unpriced: readonly string[] }, nothing: string): string | null {
  if (spend.unpriced.length) return noPriceWords({ unpriced: spend.unpriced });
  return spend.usd > 0 ? null : nothing;
}

/**
 * Run tests: `live`, how many goldens would run something live (marked fork, an injection gate, a
 * judge asked live); `last`, the last session's results and what its injection gates' tests spent,
 * or null when none ran. One that runs nothing live is Free and starts at once; one that does is
 * priced at what the last session spent live (`≈$2.31 · what the last session spent live`), and has
 * no estimate until a session has run, or when the last spent nothing live (its fork goldens replayed
 * clean, say), which says nothing of what this one bills.
 */
export function testsEstimate(live: number, last: { results: readonly SessionResult[]; injection?: readonly GateSpend[] } | null): Estimate {
  if (!live) return { kind: 'tests', usd: 0, ceiling: false, parts: ['every golden replays offline'] };
  if (!last) return noEstimate('tests', 'no estimate until a session has run');
  const spend = spendOf(last.results, last.injection);
  const none = spendNone(spend, 'the last session spent nothing live, so what this one bills is unknown');
  if (none) return noEstimate('tests', none);
  return { kind: 'tests', usd: spend.usd, ceiling: false, parts: ['what the last session spent live'], last: { usd: spend.usd, attempts: null } };
}

/**
 * Run test on one golden, as Not covered runs the golden a pack just made: one that replays is
 * replayed offline, Free; one marked fork runs live from where the agent parts from its recording
 * (the ask's lead says where: `live from there, writes blocked`), priced at what its last test spent
 * live, with no estimate until it has run once, nor when that spent nothing live.
 */
export function goldenTestEstimate(fork: boolean, last: SessionResult | null): Estimate {
  if (!fork) return { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
  const parts = ['live from there, writes blocked'];
  if (!last?.data) return noEstimate('tests', 'no estimate until it has run once', parts);
  const spend = spendOf([last]);
  const none = spendNone(spend, 'its last test spent nothing live, so what this one bills is unknown');
  if (none) return noEstimate('tests', none, parts);
  return { kind: 'tests', usd: spend.usd, ceiling: false, note: 'as its last test spent', parts, last: { usd: spend.usd, attempts: null } };
}

/**
 * Run more attempts on a golden's gate, as the gate's own view works it out (Tests' `more`, which its
 * sentence on Tests reads too): the limit it continues to, the most attempts that adds, and what it
 * is expected to take and cost.
 */
export interface MoreFigure extends ExpectedFigure {
  attempts: number;
  most: number;
}

/**
 * Tests' Run more attempts on a golden whose gate came out inconclusive (`test <golden>
 * --max-attempts <max> --continue`): every attempt it may add, each as dear as the costliest of
 * `spends` (each attempt so far, its judge's calls with it), as its ceiling; what the gate is expected
 * to take, and to cost, is the gate's own figure (`more`), on the price's card to the cent.
 */
export function moreEstimate(more: MoreFigure, spends: readonly number[]): Estimate {
  const parts = [`up to ${counted(more.most, 'more attempt')}`, 'live from where the golden forks, writes blocked'];
  if (more.most <= 0) return noEstimate('more', `its gate has taken its ${counted(more.attempts, 'attempt')} already`);
  if (!spends.length) return noEstimate('more', 'what its attempts cost was not kept', parts);
  const each = spends.reduce((m, x) => Math.max(m, x), 0);
  if (each <= 0) return noEstimate('more', 'its attempts so far spent nothing live, so what more cost is unknown', parts);
  const expected = Math.round(more.expected);
  return {
    kind: 'more',
    usd: more.most * each,
    ceiling: true,
    parts,
    ...(more.cost !== null ? { card: { title: 'If every attempt ran, each as dear as its costliest so far', lines: [`About ${centsWords(more.cost)} for the ${expected.toLocaleString('en-US')} it is expected to take, at what its ${spends.length.toLocaleString('en-US')} have cost.`, CUT_SHORT_LINE] }, expected: { usd: more.cost, attempts: expected } } : {}),
    attempts: more.most,
    each,
  };
}

/**
 * Update golden(s) (`test <goldens> --update`): each golden recorded again live, writes stubbed,
 * about what its recording cost, its judges' calls with it; a golden whose replay is clean and only
 * lacks a judge's verdict asks that judge once (`judge`, what one of its calls costs). It asks first
 * whatever Spending says, since it replaces goldens.
 */
export function updateEstimate(goldens: ReadonlyArray<{ calls: readonly PricedCall[]; judge?: number | null }>): Estimate {
  const always = 'it replaces goldens';
  let usd = 0;
  for (const g of goldens) {
    if (g.judge !== undefined) {
      if (g.judge === null) return { ...noEstimate('update', 'its judge has not been asked yet, so what a call of it costs is unknown'), always };
      usd += g.judge;
      continue;
    }
    const cost = liveFrom(g.calls, 0);
    if (cost.usd === null) return { ...noEstimate('update', noPriceWords(cost)), always };
    usd += cost.usd;
  }
  const one = goldens.length === 1;
  const judges = goldens.every((g) => g.judge !== undefined);
  return { kind: 'update', usd, ceiling: false, always, parts: [judges ? (one ? 'its judge’s one call' : 'each judge’s one call') : one ? 'as its recording cost' : 'as their recordings cost'] };
}

/** The price's card line for a bisect's ceiling: a commit it can't decide at is skipped, and the nearest other tested (cli bisect), on top of what it counts. */
const BISECT_SKIP_LINE = 'A commit left inconclusive is skipped and the nearest other one tested, on top of these.';

/** The commits a bisect over `commits` tests at most: the bad one, the good one, then the range halved, a commit skipped aside. */
export const bisectCommits = (commits: number): number => 2 + Math.ceil(Math.log2(Math.max(1, commits)));

/**
 * Find breaking commit for a golden (`bisect <golden> --good <rev>`), `commits` apart from the good
 * one to the bad: a golden that replays is replayed offline at each, Free; one marked fork runs its
 * gate live at every commit it tests, up to `attempts` each (its gate's max, or its repeat), each
 * attempt at most `each` (its last session's costliest, its judge's calls with it); none until it has
 * run once, nor when its attempts spent nothing live. `commit`, what a commit's gate is expected to
 * cost (what its gate spent in its last session, its judge's calls with it), is on the price's card
 * to the cent.
 */
export function bisectEstimate(commits: number, golden: { fork: boolean; attempts: number; each: number | null; commit?: number | null }): Estimate {
  if (!golden.fork) return { kind: 'bisect', usd: 0, ceiling: false, parts: ['bisect replays offline'] };
  const where = 'live at each commit, as a golden marked fork runs';
  if (golden.each === null) return noEstimate('bisect', 'no estimate until it has run once', [where]);
  if (golden.each <= 0) return noEstimate('bisect', 'its last session’s attempts spent nothing live, so what one costs is unknown', [where]);
  const tested = bisectCommits(commits);
  return {
    kind: 'bisect',
    usd: tested * golden.attempts * golden.each,
    ceiling: true,
    parts: [`up to ${counted(tested, 'commit')}, ${counted(golden.attempts, 'attempt')} each`, where],
    card: { title: 'If every commit’s gate ran to its limit', lines: [`An attempt costs at most ${amountWords(golden.each)}, as its last session’s costliest did.`, golden.commit ? `A gate stops once it decides: about ${centsWords(golden.commit)} a commit.` : 'A gate stops once it decides.', BISECT_SKIP_LINE, CUT_SHORT_LINE] },
    attempts: tested * golden.attempts,
    each: golden.each,
  };
}

/**
 * Find breaking commit for a run that failed a check (`bisect <run> --good <rev> --fork`), `commits`
 * apart: one live replay at each commit it tests but its own, where its replay is clean, each at
 * most what the run cost from its first model call to its end.
 */
export function runBisectEstimate(calls: readonly PricedCall[], commits: number): Estimate {
  const cost = liveFrom(calls, 0);
  if (cost.usd === null) return noEstimate('bisect', noPriceWords(cost));
  const tested = bisectCommits(commits);
  return {
    kind: 'bisect',
    usd: (tested - 1) * cost.usd,
    ceiling: true,
    parts: [`up to ${counted(tested, 'commit')}`, 'one live replay each, writes blocked'],
    card: { title: 'If every commit but its own ran live', lines: [`A replay costs at most ${amountWords(cost.usd)}, live from where it parts to its end, as the run did.`, 'One live replay decides a commit: a failure that doesn’t happen every time can pass at one that has it.'] },
    attempts: tested - 1,
    each: cost.usd,
  };
}
