import { gateOdds, gateOf, type GateResult } from '../stats.js';
import type { TestResultData } from '../store.js';
import { counted, liveFrom, noEstimate, noPriceWords, type Estimate, type PricedCall, type Prices } from './estimate.js';
import { amountWords } from './spending.js';

/**
 * What Tests' jobs bill. Run tests: what the last session spent live, its fork goldens' attempts,
 * their judges and its injection gates, or nothing when every golden replays offline. Run more
 * attempts on a gate still inconclusive: every attempt up to its higher limit, each as dear as its
 * costliest so far, with what the gate is expected to take. Update golden(s): each golden recorded
 * again, about what its recording cost. Find breaking commit on a golden marked fork: every commit it
 * may test, its gate run live at each; on a run, one live replay a commit.
 */

/** A session's result for one golden, as the store keeps it: what its attempts and its judges spent live. */
export type SessionResult = { data: Pick<TestResultData, 'spent' | 'judge'> | null };

/**
 * Run tests: `live`, how many goldens would run something live (marked fork, an injection gate, a
 * judge asked live); `last`, the last session's results and what its injection gates spent, or null
 * when none ran. One that runs nothing live is Free and starts at once; one that does is priced at
 * what the last session spent live (`≈$2.31 · what the last session spent live`), and has no estimate
 * until a session has run.
 */
export function testsEstimate(live: number, last: { results: readonly SessionResult[]; injection?: number } | null): Estimate {
  if (!live) return { kind: 'tests', usd: 0, ceiling: false, parts: ['every golden replays offline'] };
  if (!last) return noEstimate('tests', 'no estimate until a session has run');
  const usd = last.results.reduce((s, r) => s + (r.data?.spent ?? 0) + (r.data?.judge?.spent ?? 0), last.injection ?? 0);
  return { kind: 'tests', usd, ceiling: false, parts: ['what the last session spent live'], last: { usd, attempts: null } };
}

/**
 * Run test on one golden (one a coverage group was just packed into, a gate's Re-run test): one that
 * replays is replayed offline, Free; one marked fork runs live from where the agent parts from its
 * recording, priced at what its last result spent live, with no estimate until it has run once.
 */
export function goldenTestEstimate(fork: boolean, last: SessionResult | null): Estimate {
  if (!fork) return { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
  const parts = ['live from where it forks, writes blocked'];
  if (!last?.data) return noEstimate('tests', 'no estimate until it has run once', parts);
  const usd = (last.data.spent ?? 0) + (last.data.judge?.spent ?? 0);
  return { kind: 'tests', usd, ceiling: false, note: 'as its last test spent', parts, last: { usd, attempts: null } };
}

/**
 * Tests' Run more attempts on a golden whose gate came out inconclusive (`test <golden>
 * --max-attempts <max> --continue`): every attempt up to `max`, each as dear as the costliest of
 * `spends` (each attempt so far, its judge's calls with it), as its ceiling; what the gate is
 * expected to take, at what its attempts have cost on average, on the price's card.
 */
export function moreEstimate(gate: GateResult, max: number, spends: readonly number[]): Estimate {
  const most = max - gate.attempts;
  if (most <= 0) return noEstimate('more', `its gate has run ${counted(gate.attempts, 'attempt')} already, which is ${max} or more`);
  if (!spends.length) return noEstimate('more', 'what its attempts cost was not kept', [`up to ${most} more attempts`]);
  const each = Math.max(...spends);
  const average = spends.reduce((s, x) => s + x, 0) / spends.length;
  const history = gate.evidence?.kind === 'baseline' ? gate.evidence.history : null;
  const odds = gateOdds({ ...gateOf(gate), max }, gate.attempts ? gate.passes / gate.attempts : 0.5, history, { passes: gate.passes, attempts: gate.attempts });
  const expected = Math.max(0, Math.round(odds.attempts - gate.attempts));
  return {
    kind: 'more',
    usd: most * each,
    ceiling: true,
    parts: [`up to ${most} more attempts`, 'live from where the golden forks, writes blocked'],
    card: { title: 'If every attempt ran, each as dear as its costliest so far', lines: [`About ${amountWords(expected * average)} for the ${expected} it is expected to take, at what its ${counted(spends.length, 'attempt')} have cost.`] },
    attempts: most,
    each,
    expected: { usd: expected * average, attempts: expected },
  };
}

/**
 * Update golden(s) (`test <goldens> --update`): each golden recorded again live, writes stubbed,
 * about what its recording cost, its judges' calls with it; a golden whose replay is clean and only
 * lacks a judge's verdict asks that judge once (`judge`, what one of its calls costs). It asks first
 * whatever Spending says, since it replaces goldens.
 */
export function updateEstimate(goldens: ReadonlyArray<{ calls: readonly PricedCall[]; judge?: number | null }>, prices?: Prices): Estimate {
  const always = 'it replaces goldens';
  let usd = 0;
  for (const g of goldens) {
    if (g.judge !== undefined) {
      if (g.judge === null) return { ...noEstimate('update', 'its judge has not been asked yet, so what a call of it costs is unknown'), always };
      usd += g.judge;
      continue;
    }
    const cost = liveFrom(g.calls, 0, { prices });
    if (cost.usd === null) return { ...noEstimate('update', noPriceWords(cost)), always };
    usd += cost.usd;
  }
  const one = goldens.length === 1;
  const judges = goldens.every((g) => g.judge !== undefined);
  return { kind: 'update', usd, ceiling: false, always, parts: [judges ? (one ? 'its judge’s one call' : 'each judge’s one call') : one ? 'as its recording cost' : 'as their recordings cost'] };
}

/** The commits a bisect over `commits` tests at most: the bad one, the good one, then the range halved. */
export const bisectCommits = (commits: number): number => 2 + Math.ceil(Math.log2(Math.max(1, commits)));

/**
 * Find breaking commit for a golden (`bisect <golden> --good <rev>`), `commits` apart from the good
 * one to the bad: a golden that replays is replayed offline at each, Free; one marked fork runs its
 * gate live at every commit it tests, up to `attempts` each (its gate's max, or its repeat), each
 * attempt at most `each` (its last session's costliest, its judge's calls with it).
 */
export function bisectEstimate(commits: number, golden: { fork: boolean; attempts: number; each: number | null }): Estimate {
  if (!golden.fork) return { kind: 'bisect', usd: 0, ceiling: false, parts: ['bisect replays offline'] };
  if (golden.each === null) return noEstimate('bisect', 'no estimate until it has run once', ['live at each commit, as a golden marked fork runs']);
  const tested = bisectCommits(commits);
  return {
    kind: 'bisect',
    usd: tested * golden.attempts * golden.each,
    ceiling: true,
    parts: [`up to ${counted(tested, 'commit')}, ${counted(golden.attempts, 'attempt')} each`, 'live at each commit, as a golden marked fork runs'],
    card: { title: 'If every commit’s gate ran to its limit', lines: [`An attempt costs at most ${amountWords(golden.each)}, as its last session’s costliest did.`, 'A gate stops once it decides.'] },
    attempts: tested * golden.attempts,
    each: golden.each,
  };
}

/**
 * Find breaking commit for a run that failed a check (`bisect <run> --good <rev> --fork`), `commits`
 * apart: one live replay at each commit it tests but its own, where its replay is clean, each at
 * most what the run cost from its first model call to its end.
 */
export function runBisectEstimate(calls: readonly PricedCall[], commits: number, prices?: Prices): Estimate {
  const cost = liveFrom(calls, 0, { prices });
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
