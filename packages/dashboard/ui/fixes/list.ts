import { JOB_KINDS } from '../api.js';
import type { Fact } from '../components/Facts.js';
import { cents, shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import { exitWords } from '../outcome-tip.js';
import type { FixesView, FixesViewRow, FixLead, FixRow, JobListItem, StepKey, UnblamedRow } from '../types.js';
import { pluralS as s } from '../../../engine/src/words.js';
import { repairSub } from './estimates.js';
import { blameAgainTip, STRONGER_TIP, treeBusy, type FixChip, type TreeJob } from './model.js';
export { STEP_NAMES } from './row-scope.js';
import { verifyLeftCard, verifyTip } from './VerifyStep.js';

/**
 * How the Fixes list reads its answer (`GET /api/fixes`): the header's figures, what each chip says
 * with nothing in it, a row's status on the ladder and its chips' and links' cards, its three steps
 * with a running job's word in place of one, and its next step's job, card and wait. Only the Fixes
 * page loads it, so none of it is in the first look; no DOM here: the tests import it.
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

/** A fix's place on the ladder, as a dot and a word: open and blamed muted, verified, applied and merged lime, an applied fix that doesn't hold red. */
export function rungStatus(f: Pick<FixesViewRow, 'rung' | 'pr' | 'broken' | 'status'>): { tone: 'mu' | 'ok' | 'err'; text: string } {
  if (f.status === 'applied' && f.broken) return { tone: 'err', text: 'broken' };
  if (f.rung === 'open' || f.rung === 'blamed') return { tone: 'mu', text: f.rung };
  return { tone: 'ok', text: f.rung === 'merged' && f.pr?.number != null ? `merged · PR #${f.pr.number}` : f.rung };
}

/** The `from CI` chip's card: what Fix on failure did in CI, and where its pull request stands. */
export function ciCard(f: Pick<FixesViewRow, 'pr'>): string {
  const pr = f.pr;
  if (!pr) return 'A blame in CI opened it.';
  const opened = `Fix on failure blamed, repaired and verified it in CI, then opened ${pr.number === null ? 'a pull request' : `pull request #${pr.number}`} with its evidence`;
  return pr.state === null ? `${opened}.` : `${opened}; it ${pr.state === 'open' ? 'is' : 'was'} ${pr.state}.`;
}

/** The failing runs' link's card: how many, the first five by id, and where it leads. */
export function failingCard(f: Pick<FixesViewRow, 'failing' | 'failingIds'>): { title: string; text: string } {
  const n = f.failing;
  const ids = f.failingIds.join(', ') + (n > f.failingIds.length ? ` and ${n - f.failingIds.length} more` : '');
  return { title: `${n} run${s(n)} failed its check`, text: `${f.failingIds.length ? `${ids}. ` : ''}${n === 1 ? 'Opens it' : 'Opens them'} on Runs, under Failed` };
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

export const unblamedTitle = (u: Pick<UnblamedRow, 'count'>): string => `${count(u.count)} failing run${s(u.count)} nobody has blamed`;

/** What its newest run failed: the check, in the engine's words, else its agent's exit. */
export const unblamedFailed = (u: Pick<UnblamedRow, 'failed'>): string => u.failed ?? exitWords(null);

/** Run blame's card on the unblamed row: the run it blames, and what it does. */
export const unblamedBlameCard = (u: Pick<UnblamedRow, 'count' | 'runId'>): string =>
  `Blames ${u.count > 1 ? 'the newest, ' : ''}${shortId(u.runId)}: finds the model call that lost it, and joins it to the fix its failure belongs to`;

// ---------------------------------------------------------------------------------------------- the next step

/** The job each lead starts. */
export const LEAD_KIND: Readonly<Record<FixLead['key'], string>> = {
  'blame-again': JOB_KINDS.blame,
  'blame-stronger': JOB_KINDS.blame,
  repair: JOB_KINDS.repair,
  apply: JOB_KINDS.applyFix,
  more: JOB_KINDS.verify,
  again: JOB_KINDS.verify,
  'verify-left': JOB_KINDS.verify,
};

/** What a lead does once the working tree is free, as its wait says it: "repair once it is done". */
export const LEAD_VERB: Readonly<Record<FixLead['key'], string>> = {
  'blame-again': 'blame again',
  'blame-stronger': 'blame it',
  repair: 'repair',
  apply: 'apply the patch',
  more: 'run more attempts',
  again: 'verify again',
  'verify-left': 'verify it',
};

/** A lead whose dialog shows the fix's detail, read when it is pressed: the rest ask from the lead's own fields. */
export const leadReadsFix = (lead: Pick<FixLead, 'key'>): boolean => lead.key === 'blame-stronger' || lead.key === 'repair' || lead.key === 'apply';

const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** A lead's card sentence, under its label: the words the fix's own page gives the same button. */
export function leadCard(lead: FixLead): string | null {
  switch (lead.key) {
    case 'blame-again':
      return blameAgainTip({ kind: lead.stopped ? 'stopped' : 'unsettled', gate: lead.gate });
    case 'blame-stronger':
      return STRONGER_TIP;
    case 'repair':
      return repairSub(lead.repairer);
    case 'apply':
      return lead.pending ? capital(lead.pending) : lead.label === ACTIONS.applyFix.label ? 'Asks first: it changes your working tree' : null;
    case 'verify-left':
      return verifyLeftCard(lead.runs);
    default:
      return verifyTip({ kind: lead.key, max: lead.max });
  }
}

/** Why a lead can't start now, or null: a job this dashboard doesn't run, or one holding the working tree it would use. */
export function leadWait(lead: FixLead, o: { jobs: readonly TreeJob[]; folder: string | null; hasKind: (kind: string) => boolean }): string | null {
  if (!o.hasKind(LEAD_KIND[lead.key])) return 'This dashboard doesn’t run it: run the command in a terminal.';
  return treeBusy(o.jobs, lead.use, LEAD_VERB[lead.key], o.folder);
}
