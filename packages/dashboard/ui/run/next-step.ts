import { costLine, costWords } from '../../../engine/src/estimates/spending.js';
import { confirmWords } from '../labels.js';
import type { NextStep, RunDetail } from '../types.js';
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

/**
 * What a step's hover says: its title, its sentence, and what it bills and runs: the amount alone
 * until Spending says whether it asks first, none for what bills nothing. A job's dialog says the rest.
 */
export function stepCard(step: NextStep): { title: string; sub: string | null; rows: Array<{ label: string; value: string }> } {
  const own = step.key === 'fix' ? fixStatusWords(step.status).why : step.key === 'blame' ? blameTitle(step.offer) : null;
  const cost = step.estimate ? costWords(step.estimate, null, { form: true }) : null;
  const rows = [...(cost ? [{ label: 'Costs', value: cost }] : []), ...(step.command ? [{ label: '$', value: step.command }] : [])];
  return { title: step.title ?? confirmWords(step.label), sub: step.sub ?? own, rows };
}

/** What a step's dialog says of what it bills, as an ask's cost line says it: `≈$3.11, as the last test’s 6 attempts · live from each read, writes stubbed`. */
export function stepCost(step: NextStep): string | null {
  return step.estimate ? costLine(step.estimate).join(' · ') : null;
}

/**
 * A fix's status as the run page's Open fix says it on hover and its banner beside it: open until a
 * change is verified, then verified, then applied.
 */
export function fixStatusWords(status: string): { tone: 'warn' | 'ok'; text: string; why: string } {
  if (status === 'open') return { tone: 'warn', text: 'fix open', why: 'open: no change has been verified for it yet' };
  if (status === 'applied') return { tone: 'ok', text: 'fix applied', why: 'applied: its change is in your working tree' };
  return { tone: 'ok', text: `fix ${status}`, why: `${status}: a change fixed its failing runs, ready to apply` };
}
