import { costLine, costWords } from '../../../engine/src/estimates/spending.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { normalizeAction } from '../normalize.js';
import type { ActionItem, BlameBeside, GateEntry, NextStep, RunDetail } from '../types.js';
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

/** A step's hover card: its title, its sentence, and its rows, what it bills and runs. */
export interface StepCard {
  title: string;
  sub: string | null;
  rows: Array<{ label: string; value: string }>;
}

/**
 * What a job's hover says of what it bills and runs: the amount alone until Spending says whether it
 * asks first, none for what bills nothing. A job's dialog says the rest.
 */
function cardRows(o: Pick<NextStep, 'estimate' | 'command'>): StepCard['rows'] {
  const cost = o.estimate ? costWords(o.estimate, null, { form: true }) : null;
  return [...(cost ? [{ label: 'Costs', value: cost }] : []), ...(o.command ? [{ label: '$', value: o.command }] : [])];
}

/** What a step's hover says: its title, its sentence, and what it bills and runs. */
export function stepCard(step: NextStep): StepCard {
  const own = step.key === 'fix' ? fixStatusWords(step.status).why : step.key === 'blame' ? blameTitle(step.offer) : null;
  return { title: step.title ?? confirmWords(step.label), sub: step.sub ?? own, rows: cardRows(step) };
}

/** What the Run blame beside a crash's Find breaking commit says on hover. */
export function blameBesideCard(blame: BlameBeside): StepCard {
  return { title: ACTIONS.runBlame.label, sub: blame.sub, rows: cardRows(blame) };
}

/** What a step's dialog says of what it bills, as an ask's cost line says it: `≈$3.11, as the last test’s 6 attempts · live from each read, writes stubbed`. */
export function stepCost(step: NextStep): string | null {
  return step.estimate ? costLine(step.estimate).join(' · ') : null;
}

/** What a step's dialog says: its sentence, then what it bills. */
export function stepAsk(step: NextStep): string {
  const cost = stepCost(step);
  return step.sub && cost ? `${step.sub}. ${cost}` : (step.sub ?? cost ?? '');
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
