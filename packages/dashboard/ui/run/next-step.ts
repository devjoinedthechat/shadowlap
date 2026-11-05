import { costLine, costWords } from '../../../engine/src/estimates/spending.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { normalizeAction } from '../normalize.js';
import type { PaletteEntry } from '../palette.js';
import { keyColumn, type ShortcutId } from '../shortcuts.js';
import type { ActionItem, BlameBeside, GateEntry, NextStep, NextStepRow, RunDetail } from '../types.js';
import { blameTitle } from './offers.js';

/**
 * The step the run page leads with, as the server works it out (src/next-step.ts): the header's one
 * lime button, the palette's first entry, and what the banner doesn't offer again. No DOM here: the
 * tests import it.
 */

/** A run's next step: null for an answer that has none, as an exported copy's that holds no comparison to make. */
export function nextStepOf(run: Pick<RunDetail, 'next'>): NextStep | null {
  return run.next ?? null;
}

/** The action a Replay brings for a recording with no command of its own, which asks for yours, as a page's actions are read. */
export function replayAction(step: NextStep | null): ActionItem | null {
  return step?.key === 'replay' && step.action ? normalizeAction(step.action as unknown as ActionItem) : null;
}

/**
 * What a step that runs a job waits for, by the verb its button says it in: a Tests job for a job
 * replaying or rewriting the goldens too, every one for what holds the working tree.
 */
const STEP_JOBS: Partial<Record<NextStep['key'], { verb: string; tests: boolean }>> = {
  normalizer: { verb: 'add the normalizer', tests: true },
  'update-golden': { verb: 'update it', tests: true },
  'rerun-test': { verb: 'run it again', tests: true },
  'gate-again': { verb: 'run it again', tests: true },
  bisect: { verb: 'find the breaking commit', tests: true },
  blame: { verb: 'blame', tests: false },
  'injection-test': { verb: 'test it', tests: false },
  'injection-again': { verb: 'test it', tests: false },
};

/** The job a step runs, for what it waits for and how its button words that; none for a link, or a step that waits for no job. */
export const stepJob = (step: NextStep | null): { verb: string; tests: boolean } | null => (step && !step.href ? (STEP_JOBS[step.key] ?? null) : null);

/** The key of the header button a step presses, by what the step does, never read from its label: Replay, Compare or Run blame, as the table of keys has them. */
const STEP_KEYS: Partial<Record<NextStep['key'], ShortcutId>> = { replay: 'replay', compare: 'compare', blame: 'blame' };

/** A run's next step as This run's first entry, or a list's row carries it: what the header's lime button says, what it runs or where it goes, and its key; while it waits, why (`wait`). */
export function stepEntry(step: NextStep | NextStepRow, wait: string | null = null): PaletteEntry {
  const id = STEP_KEYS[step.key];
  const key = id ? keyColumn(id) : null;
  return { group: 'This run', label: step.label, hint: wait ?? step.command ?? step.title ?? '', ...(step.href ? {} : { job: true }), ...(key ? { key } : {}), ...(wait ? { wait } : {}) };
}

/** A step's hover card: its title, its sentence, its rows, what it bills, and what it runs, up to its first arguments as every card has a command. */
export interface StepCard {
  title: string;
  sub: string | null;
  rows: Array<{ label: string; value: string }>;
  cmd: string | null;
}

/**
 * What a job's hover says of what it bills and runs: the amount alone until Spending says whether it
 * asks first, none for what bills nothing. A job's dialog says the rest.
 */
function billsAndRuns(o: Pick<NextStep, 'estimate' | 'command'>): Pick<StepCard, 'rows' | 'cmd'> {
  const cost = o.estimate ? costWords(o.estimate, null, { form: true }) : null;
  return { rows: cost ? [{ label: 'Costs', value: cost }] : [], cmd: o.command ? `$ ${o.command}` : null };
}

/** What a step's hover says: its title, its sentence, and what it bills and runs. */
export function stepCard(step: NextStep): StepCard {
  const own = step.key === 'fix' ? fixStatusWords(step.status).why : step.key === 'blame' ? blameTitle(step.offer) : null;
  return { title: step.title ?? confirmWords(step.label), sub: step.sub ?? own, ...billsAndRuns(step) };
}

/** What the Run blame beside a crash's Find breaking commit says on hover. */
export function blameBesideCard(blame: BlameBeside): StepCard {
  return { title: ACTIONS.runBlame.label, sub: blame.sub, ...billsAndRuns(blame) };
}

/** What a step's dialog bills, as an ask's cost line says it, the price first: `≈$3.11, as the last test’s 6 attempts · live from each read, writes stubbed`; none for a step that bills nothing. */
export function stepCostLine(step: NextStep): { price: string; parts: string[] } | null {
  if (!step.estimate) return null;
  const [price = '', ...parts] = costLine(step.estimate);
  return { price, parts };
}

/** The entry under `tests` that gives a golden its injection gate, for its folder as it stands in the dialog. */
export const gateEntry = (folder: string, gate: GateEntry): string => `"tests": { ${JSON.stringify(folder)}: { "injection": { "obeyed": ${gate.obeyed}, "repeat": ${gate.repeat} } } }`;

/**
 * A fix's status as the run page's Open fix says it on hover and its banner beside it: open until a
 * change is verified, then verified, then applied.
 */
export function fixStatusWords(status: string): { tone: 'warn' | 'ok'; text: string; why: string } {
  if (status === 'open') return { tone: 'warn', text: 'fix open', why: 'open: no change has been verified for it yet' };
  if (status === 'applied') return { tone: 'ok', text: 'fix applied', why: 'applied: its change is in your working tree' };
  return { tone: 'ok', text: `fix ${status}`, why: `${status}: a change fixed its failing runs, ready to apply` };
}
