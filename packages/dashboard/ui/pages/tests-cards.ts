import { GOLDEN_JOB_WORDS } from '../../../engine/src/action-words.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { DivergenceView, MoreAttempts, TestsView } from '../api.js';
import type { TestsCard } from '../fixes/TestsJobButton.js';
import { commandText } from '../goldens.js';
import { ACTIONS, confirmWords } from '../labels.js';

type Price = Estimate | null | undefined;

/**
 * A Tests job's button past its wait (JobButton): its card, the estimate the card says, and a press
 * that runs `go` with that estimate either way. A job posts from it at once, as the server's question
 * is its ask where it runs goldens live, and Spending answers that (tests-ask.ts), so it never asks
 * twice; one that asks for what it does (Update golden) opens its dialog from it.
 */
export function testsJob(card: TestsCard, estimate: Price, go: (e: Price) => unknown) {
  const press = () => void go(estimate);
  return { ...card, estimate, start: press, ask: press };
}

/** Run tests' card: every golden replays offline, and those marked fork run live from where they fork. */
export function runTestsCard(view: Pick<TestsView, 'rows' | 'commands'>): TestsCard {
  const n = view.rows.filter((r) => r.mode === 'fork').length;
  const live = n === 0 ? '' : `; ${n === 1 ? 'a golden marked fork runs' : `${n} goldens marked fork run`} live from where ${n === 1 ? 'it forks' : 'they fork'}`;
  return { tip: ACTIONS.runTests.label, sub: `Replays every golden offline${live}`, command: commandText(view.commands.run) };
}

/** Update golden's card: it re-records the golden, or asks its judge once where a verdict is all it lacks (`args`, its command then). */
export function updateCard(golden: string, judge: readonly string[] | null = null): TestsCard {
  return { tip: ACTIONS.updateGolden.label, sub: judge ? GOLDEN_JOB_WORDS.judgeOnce : GOLDEN_JOB_WORDS.remade, command: commandText(judge ?? ['test', golden, '--update']) };
}

/** A diverged golden's way on: Re-run once its rule is in, else Add normalizer, which replays the golden or re-records it after the rule. */
export function normalizeCard(d: Pick<DivergenceView, 'golden' | 'normalizeAndTest'>, n: { label: string; run: 'rerun' | 'normalize' | 'normalize-update' }): TestsCard {
  if (n.run === 'rerun') return { tip: n.label, sub: GOLDEN_JOB_WORDS.ruleIn, command: commandText(['test', d.golden]) };
  return { tip: n.label, sub: n.run === 'normalize' ? GOLDEN_JOB_WORDS.masksThenReplays : GOLDEN_JOB_WORDS.masksThenRemakes, command: (d.normalizeAndTest ?? []).map(commandText).join(' && ') };
}

/** Run more attempts' card, a golden's: the limit it goes on to for this session, and how often that settles it. */
export function moreCard(more: Pick<MoreAttempts, 'args' | 'attempts' | 'most' | 'expected' | 'settles'>): TestsCard {
  const ran = more.attempts - more.most;
  return { tip: ACTIONS.runMoreAttempts.label, sub: `Raises its limit to ${more.attempts} for this session only and carries its ${ran} attempts over. That settles it ${Math.round(more.settles * 100)}% of the time, in about ${Math.round(more.expected)} more.`, command: commandText(more.args) };
}

/** Update goldens…' card: the command that re-records every diverged golden. */
export function updatesCard(paths: readonly string[]): TestsCard {
  return { tip: ACTIONS.updateGoldens.label, command: commandText(['test', ...paths, '--update']) };
}

type Bisected = Pick<DivergenceView, 'golden' | 'bisect' | 'missed'>;

/** Whether a golden's Find breaking commit runs live at each commit: as its range says, else as the golden is marked. */
export function bisectLive(view: Pick<TestsView, 'rows'>, f: Bisected): boolean {
  const range = f.missed ? null : f.bisect;
  return range?.live ?? view.rows.find((r) => r.path === f.golden)?.mode === 'fork';
}

/**
 * Find breaking commit's card, a golden's: it asks for an older commit once a search named none, for
 * one where it worked with no range known, or runs live at each commit for a golden marked fork;
 * otherwise it replays the commits since the one it passed at, offline. Its command is the dialog's.
 */
export function bisectCard(f: Bisected, live: boolean): TestsCard {
  const range = f.missed ? null : f.bisect;
  const sub = f.missed ? `Asks for an older commit${f.missed.good ? `: the last search found it failing at ${f.missed.good}` : ''}` : live ? 'Runs live at each commit, so it costs tokens' : range ? `Replays the golden at the commits since ${range.good}, where it passed, offline: no tokens` : 'Asks for a commit where it worked';
  return { tip: confirmWords(ACTIONS.findBreakingCommit.label), sub, command: commandText(['bisect', f.golden, '--good', range?.good ?? '<commit>', ...(range?.bad ? ['--bad', range.bad] : [])]) };
}
