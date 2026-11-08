import { updatePart } from '../../engine/src/cost-words.js';
import type { CostWords, FactWords } from './actions.js';
import type { DocKey } from './docs-links.js';
import { commandText, n } from './goldens.js';
import { ACTIONS } from './labels.js';

/**
 * What every Update golden says, as a test replay's page shows it up front: the dialog's shape, its
 * steps, what it bills, where a golden diverged and the lime way on beside it. The plans Tests and
 * the apply drawer build from them are in ./update-plan.ts, which only those dialogs load, so the
 * run page carries none of them. No DOM here: the tests import it.
 */

export interface UpdatePlan {
  title: string;
  lead: string;
  doc: DocKey;
  /** What a judge's update decides by: what the pack holds, and whose key asks it. */
  facts: FactWords[];
  /** The golden as a row, or the diverged goldens as a list; none when the title names the one golden and nothing diverged. */
  goldens: Array<{ path: string; name: string; where: string }>;
  steps: Array<[string, string]>;
  /**
   * The advice: a value that changes every run diverged and no rule masks it yet, so a normalizer is
   * the lasting fix; or, for one golden, the rule for it is in the config now and alone makes the
   * replay match, so a re-run passes without an update; or a judge's verdict in the pack was given on
   * other material, which a value that changes every run would make again, so its normalizer comes first.
   */
  advise: { title: string; text: string; path: string | null } | null;
  /** The lime way on beside it, named for what it runs, with its command and what it bills: null when the server runs none of it, or there is none. */
  instead: OneInstead | SeveralInstead | null;
  /** A plain line above the command, a path set in code: several goldens' rules are in the config already, so a re-run is the fix. */
  note: Array<string | { code: string }> | null;
  command: string;
  cost: CostWords;
  ok: string;
}

/** One golden's way on beside Update anyway: its normalizer and a re-run, its normalizer and the update, or a re-run. */
export interface OneInstead {
  label: string;
  golden: string;
  run: 'normalize' | 'normalize-update' | 'rerun';
  command: readonly string[];
  cost: CostWords;
}

/**
 * Several goldens': Add normalizer and update, one job (`test-update` with `normalize`) that adds the
 * rules the server found for them, then updates them all. It bills what the update does, which the
 * line under Update anyway says for both.
 */
export interface SeveralInstead {
  label: string;
  goldens: readonly string[];
  run: 'normalize-update-all';
  command: readonly string[];
  cost: null;
}

/** The amber box's button, by what it runs in place of the update. */
const INSTEAD: Record<OneInstead['run'], string> = {
  normalize: ACTIONS.addNormalizerAndRerun.label,
  // The rule alone can't make the replay match: it is added, and the golden updated after it.
  'normalize-update': ACTIONS.addNormalizerAndUpdate.label,
  rerun: 'Re-run instead',
};

/** What re-recording bills: until a price is known, who bills it. */
export const recordingCost = (one: boolean): CostWords => ({ price: 'Billed by your provider', parts: [updatePart(one, false)] });

/** Its checks, as the step that replaces it says them: an update is kept only if they pass, or with none, if it exits 0. */
export const replacedIf = (checks: number) => (checks === 0 ? 'Replaced only if it exits 0' : checks === 1 ? 'Replaced only if its check passes' : `Replaced only if its ${n(checks, 'check')} pass`);

/** Re-recorded, kept only if it passes, replayed as the next test will, and reviewed. */
export function updateSteps(replaced: string, diverges: string | null): Array<[string, string]> {
  return [
    ['Re-recorded live', 'writes stubbed'],
    [replaced, 'in your working tree'],
    ['Replayed offline, as the next test will', diverges ? `a new ${diverges.replace(/^an? /, '')} diverges again` : 'it should replay clean'],
    ['You review the change', 'in your pull request'],
  ];
}

/** Where a golden diverged, as a row says it: the call, and the path where one value did. */
export const divergedWhere = (d: { callNo: number; volatile: { path: string } | null }) => (d.volatile?.path ? `#${d.callNo} ~ ${d.volatile.path}` : `diverged at call ${d.callNo}`);

/**
 * The lime way on beside Update anyway: what it runs, and what that bills. A re-run after the rules
 * replays offline, unless the golden may fork; one whose last step updates it re-records.
 */
export function insteadOf(run: OneInstead['run'], steps: readonly (readonly string[])[], golden: string, fork: boolean): OneInstead {
  const lines = (run === 'rerun' ? steps.slice(-1) : steps).map((c) => commandText(c));
  const cost: CostWords = run === 'normalize-update' ? recordingCost(true) : fork ? { price: 'Billed by your provider', parts: ['live from where it forks'] } : { price: 'Free', parts: ['replays offline'] };
  return { label: INSTEAD[run], golden, run, command: lines, cost };
}
