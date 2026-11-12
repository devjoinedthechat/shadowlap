import { JOB_KINDS } from '../api.js';
import type { Fact } from '../components/Facts.js';
import { failedRunsWords } from '../failed-runs.js';
import { cents } from '../format.js';
import { exitWords } from '../outcome-tip.js';
import type { FailedCheck, FixesView, FixesViewRow, FixRow, JobListItem, StepKey, UnblamedRow } from '../types.js';
import { pluralS as s } from '../../../engine/src/words.js';
import type { FixChip } from './model.js';
export { LEAD_KIND, LEAD_VERB, leadCard, leadReadsFix, leadWait } from './lead.js';
export { STEP_NAMES } from './row-scope.js';

/**
 * How the Fixes list reads its answer (`GET /api/fixes`): the header's figures, what each chip says
 * with nothing in it, a row's status on the ladder and its chips' and links' cards, and its three
 * steps with a running job's word in place of one. Its next step's job, card and wait are lead.ts',
 * which Needs a look shares. Only the Fixes page loads it, so none of it is in the first look; no
 * DOM here: the tests import it.
 */

// ---------------------------------------------------------------------------------------------- the header

/** What the attempts' money figure holds: every live attempt of blame, repair and verify, and nothing replayed. */
const SPENT_CARD = 'Blame, repair and verify ran each attempt live from where it forked; everything before replayed free.';

const count = (n: number): string => n.toLocaleString('en-US');

/** The header's figures: fixes verified, open, the failing runs, and what the attempts behind them took. None while there is no fix. */
export function fixFacts(v: Pick<FixesView, 'counts' | 'totals'>): Fact[] {
  if (!v.counts.all) return [];
  const done = v.counts.verified;
  const { failing, attempts, spent } = v.totals;
  return [
    { value: count(done), words: done === 1 ? 'fix verified' : 'fixes verified', tone: 'ok' },
    { value: count(v.counts.open), words: 'open' },
    { value: count(failing), words: `failing run${s(failing)}` },
    ...(attempts > 0 ? [{ value: count(attempts), words: `attempt${s(attempts)} behind them` }] : []),
    ...(spent > 0 ? [{ value: cents(spent), words: 'spent live', money: true, tip: { title: 'What the attempts cost', parts: [SPENT_CARD] } }] : []),
  ];
}

/** What a chip says when it keeps no row. */
export const CHIP_EMPTY: Readonly<Record<FixChip, string>> = {
  all: 'No fixes yet.',
  open: 'No open fixes. Every failure has a fix that held.',
  ready: 'No verified fix waits to be applied.',
  applied: 'No fix applied yet.',
};

/** The unblamed row shows under All and Open only: its runs have no fix yet. */
export const unblamedShows = (chip: FixChip): boolean => chip === 'all' || chip === 'open';

// ---------------------------------------------------------------------------------------------- a row

export { rungStatus } from './rung-status.js';

/** The `from CI` chip's card: what Fix on failure did in CI, and where its pull request stands. */
export function ciCard(f: Pick<FixesViewRow, 'pr'>): string {
  const pr = f.pr;
  if (!pr) return 'A blame in CI opened it.';
  const opened = `Fix on failure blamed, repaired and verified it in CI, then opened ${pr.number === null ? 'a pull request' : `pull request #${pr.number}`} with its evidence`;
  return pr.state === null ? `${opened}.` : `${opened}; it ${pr.state === 'open' ? 'is' : 'was'} ${pr.state}.`;
}

/**
 * The failing runs' link's card: how many runs failed the fix's check, the first five by id, and
 * where it leads. It counts the runs the link opens under Failed (`failedCheck`), where any are
 * there, else the fix's own; the link's words keep the fix's own count, as Verify replays them.
 */
export function failingCard(f: Pick<FixesViewRow, 'failing' | 'failingIds'> & { failedCheck?: FailedCheck | null }): { title: string; text: string } {
  const n = f.failedCheck?.count ?? f.failing;
  return { title: `${n} run${s(n)} failed its check`, text: failedRunsWords(f.failedCheck?.ids ?? f.failingIds, n) };
}

/** A step's cell: its word, and its state, `busy` while a job of the fix's runs it. */
export interface StepCell {
  key: StepKey;
  state: FixRow['steps'][number]['state'] | 'busy';
  short: string;
}

/** What a step says while a job of its fix runs it. */
const RUNNING: Readonly<Record<StepKey, string>> = { blame: 'blaming…', repair: 'repairing…', verify: 'verifying…' };

const isStep = (kind: string | undefined): kind is StepKey => kind === JOB_KINDS.blame || kind === JOB_KINDS.repair || kind === JOB_KINDS.verify;

/** A fix's three steps, the one a running job of its own takes said as it runs (an apply takes none). */
export function rowCells(f: Pick<FixesViewRow, 'fixId' | 'steps'>, jobs: readonly Pick<JobListItem, 'done' | 'fixId' | 'kind'>[]): StepCell[] {
  const running = jobs.find((j) => !j.done && j.fixId === f.fixId && isStep(j.kind))?.kind;
  return f.steps.map((st) => (st.key === running ? { key: st.key, state: 'busy', short: RUNNING[st.key] } : { key: st.key, state: st.state, short: st.short }));
}

/** The unblamed row's steps: not blamed, and nothing after it yet. */
export const UNBLAMED_CELLS: readonly StepCell[] = [
  { key: 'blame', state: 'todo', short: 'not blamed' },
  { key: 'repair', state: 'todo', short: '—' },
  { key: 'verify', state: 'todo', short: '—' },
];

// ---------------------------------------------------------------------------------------------- the unblamed row

/** What its newest run failed: the check, in the engine's words, else its agent's exit. */
export const unblamedFailed = (u: Pick<UnblamedRow, 'failed'>): string => u.failed ?? exitWords(null);
