import { ACTIONS } from '../labels.js';
import type { RowScope } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { FixRow, StepKey } from '../types.js';
import { fixName } from './model.js';

/**
 * ⌘K on a row of fixes: a fix's row on Fixes, or a verify's row on Changes › Verdicts, offers the fix
 * and each of its steps; the unblamed row offers its runs and its Run blame. Light on purpose: the
 * Changes page loads it too.
 */

export const STEP_NAMES: Readonly<Record<StepKey, string>> = { blame: 'Blame', repair: 'Repair', verify: 'Verify' };

const STEPS: readonly StepKey[] = ['blame', 'repair', 'verify'];

/**
 * A fix's row, under the fix's name: Open fix, its title the hint, then Blame, Repair and Verify, each
 * opening that step, hinted with its word in the list (`lost at #5`) where the row has its steps.
 */
export function fixRowScope(f: Pick<FixRow, 'fixId' | 'label' | 'title'> & { steps?: ReadonlyArray<Pick<FixRow['steps'][number], 'key' | 'short'>> }): RowScope {
  return {
    name: fixName(f),
    items: () => [
      { label: ACTIONS.openFix.label, hint: f.title, run: () => navigate(href.fixes(f.fixId)) },
      ...STEPS.map((key) => ({ label: STEP_NAMES[key], hint: f.steps?.find((st) => st.key === key)?.short ?? '', run: () => navigate(href.fixes(f.fixId, key)) })),
    ],
  };
}

/**
 * The unblamed row, under its title: Open, its runs under Failed, then Run blame, which presses the
 * row's own button and waits as it waits; a job unless it opens the run's page (`job: false`, a capture's).
 */
export function unblamedScope(o: { name: string; command: string | null; job?: boolean; wait: string | null; press: () => void }): RowScope {
  const to = href.runs({ types: 'failed' });
  return {
    name: o.name,
    items: () => [
      { label: 'Open', hint: to, run: () => navigate(to) },
      ...(o.command === null ? [] : [{ label: ACTIONS.runBlame.label, hint: o.command, ...(o.job === false ? {} : { job: true }), ...(o.wait ? { wait: o.wait } : {}), run: o.press }]),
    ],
  };
}
