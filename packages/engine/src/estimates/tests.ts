import { BISECT_PARTS, INJECTION_PART, JUDGE_UNASKED, moreAttemptsParts, updatePart } from '../cost-words.js';
import type { PlantReport } from '../injection.js';
import { counted, CUT_SHORT_LINE, liveFrom, noEstimate, noPriceWords, type Estimate, type ExpectedFigure, type PricedCall } from './estimate.js';
import { FORK_LIVE, goldenTestEstimate, spendNone, spendOf, type GateSpend, type SessionResult } from './golden-test.js';
import { injectionAgainEstimate } from './injection.js';
import { amountWords, centsWords } from './spending.js';

export { goldenTestEstimate, type GateSpend, type SessionResult } from './golden-test.js';

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



/**
 * Run tests: `live`, how many goldens would run something live (marked fork, an injection gate, a
 * judge asked live); `last`, what they spent the last time each ran: the newest test of each golden
 * that forks, and what each injection gate's newest test spent, null for one that hasn't run yet; or
 * null when none ran. One that runs nothing live is Free and starts at once; one that does is priced
 * at what they spent live (`≈$2.31 · what the last session spent live`), and has no estimate until
 * each has run once, or when they spent nothing live (its fork goldens replayed clean, say), which
 * says nothing of what this one bills.
 */
export function testsEstimate(live: number, last: { results: ReadonlyArray<SessionResult | null>; injection?: ReadonlyArray<GateSpend | null> } | null): Estimate {
  if (!live) return { kind: 'tests', usd: 0, ceiling: false, parts: ['every golden replays offline'] };
  const kept = last ? [...last.results, ...(last.injection ?? [])] : [];
  if (!last || (kept.length && kept.every((x) => x === null))) return noEstimate('tests', 'no estimate until a session has run');
  if (kept.includes(null)) return noEstimate('tests', 'no estimate until every golden that runs live has run once');
  const spend = spendOf(
    last.results.filter((r): r is SessionResult => r !== null),
    last.injection?.filter((g): g is GateSpend => g !== null),
  );
  const none = spendNone(spend, 'the last session spent nothing live, so what this one bills is unknown');
  if (none) return noEstimate('tests', none);
  return { kind: 'tests', usd: spend.usd, ceiling: false, parts: ['what the last session spent live'], last: { usd: spend.usd, attempts: null } };
}

/**
 * How a golden's test runs live, in its estimate's parts (goldenRerunEstimate): from where it forks,
 * writes blocked, for one marked fork, then from each read its injection gate plants in, writes
 * stubbed. None for one that replays offline. A card whose price shows only an amount says them in
 * its sentence (Revert's).
 */
export const goldenLiveParts = (runs: { fork: boolean; injection: boolean }): string[] => [...(runs.fork ? [FORK_LIVE] : []), ...(runs.injection ? [INJECTION_PART] : [])];

/**
 * Run test on one golden of Tests, as its session runs it, `runs` saying whether any of it runs
 * live, and what (the dashboard's tests-live.ts `liveReasons`): Free only where nothing does. One
 * marked fork is priced as goldenTestEstimate prices it; an injection gate on a golden that replays,
 * at what the gate's newest test spent (injectionAgainEstimate); both, at what the two spent, with
 * no estimate until each has run once.
 */
export function goldenRerunEstimate(runs: { live: boolean; fork: boolean; injection: boolean }, last: SessionResult | null, gate: Pick<PlantReport, 'totals' | 'baselines' | 'cost'> | null): Estimate {
  if (!runs.injection) return goldenTestEstimate(runs.live, last);
  if (!runs.fork) return injectionAgainEstimate(gate);
  const parts = goldenLiveParts(runs);
  if (!last?.data) return noEstimate('tests', 'no estimate until it has run once', parts);
  if (!gate) return noEstimate('tests', 'no estimate until its injection test has run once', parts);
  return testsEstimate(1, { results: [last], injection: [gate.cost] });
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
  const parts = moreAttemptsParts(more.most);
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
      if (g.judge === null) return { ...noEstimate('update', JUDGE_UNASKED), always };
      usd += g.judge;
      continue;
    }
    const cost = liveFrom(g.calls, 0);
    if (cost.usd === null) return { ...noEstimate('update', noPriceWords(cost)), always };
    usd += cost.usd;
  }
  const one = goldens.length === 1;
  const judges = goldens.every((g) => g.judge !== undefined);
  return { kind: 'update', usd, ceiling: false, always, parts: [updatePart(one, judges)] };
}

/** The price's card line for a bisect's ceiling: a commit it can't decide at is skipped, and the nearest other tested (cli bisect), on top of what it counts. */
const BISECT_SKIP_LINE = 'A commit left inconclusive is skipped and the nearest other one tested, on top of these.';

/** The commits a bisect over `commits` tests at most: the bad one, the good one, then the range halved, a commit skipped aside. */
export const bisectCommits = (commits: number): number => 2 + Math.ceil(Math.log2(Math.max(1, commits)));

/**
 * Find breaking commit for a golden (`bisect <golden> --good <rev>`), `commits` apart from the good
 * one to the bad: a golden that replays is replayed offline at each, Free; one marked fork runs its
 * gate live at every commit it tests, up to `attempts` each (its gate's max, or with `count` its
 * repeat), each attempt at most `each` (its last session's costliest, its judge's calls with it); none
 * until it has run once, nor when its attempts spent nothing live. `commit`, what a commit's gate is
 * expected to cost (what its gate spent in its last session, its judge's calls with it), is on the
 * price's card to the cent.
 */
export function bisectEstimate(commits: number, golden: { fork: boolean; attempts: number; each: number | null; commit?: number | null; count?: boolean }): Estimate {
  if (!golden.fork) return { kind: 'bisect', usd: 0, ceiling: false, parts: [BISECT_PARTS.offline] };
  const where = BISECT_PARTS.fork;
  if (golden.each === null) return noEstimate('bisect', 'no estimate until it has run once', [where]);
  if (golden.each <= 0) return noEstimate('bisect', 'its last session’s attempts spent nothing live, so what one costs is unknown', [where]);
  const tested = bisectCommits(commits);
  return {
    kind: 'bisect',
    usd: tested * golden.attempts * golden.each,
    ceiling: true,
    parts: [`up to ${counted(tested, 'commit')}, ${counted(golden.attempts, 'attempt')} each`, where],
    // A gate starts up to twice its max; a repeat counts an attempt the provider cut short toward it, so none comes on top.
    card: { title: 'If every commit’s gate ran to its limit', lines: [`An attempt costs at most ${amountWords(golden.each)}, as its last session’s costliest did.`, golden.commit ? `A gate stops once it decides: about ${centsWords(golden.commit)} a commit.` : 'A gate stops once it decides.', BISECT_SKIP_LINE, ...(golden.count ? [] : [CUT_SHORT_LINE])] },
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
    parts: [`up to ${counted(tested, 'commit')}`, BISECT_PARTS.run],
    card: { title: 'If every commit but its own ran live', lines: [`A replay costs at most ${amountWords(cost.usd)}, live from where it parts to its end, as the run did.`, 'One live replay decides a commit: a failure that doesn’t happen every time can pass at one that has it.'] },
    attempts: tested - 1,
    each: cost.usd,
  };
}
