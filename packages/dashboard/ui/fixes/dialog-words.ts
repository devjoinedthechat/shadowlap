import { repairParts, repairRunsNothing } from '../../../engine/src/cost-words.js';
import { shortId } from '../format.js';
import { commandText } from '../goldens.js';
import { ACTIONS, confirmWords } from '../labels.js';
import type { FixDetail } from '../types.js';
import { recordingCost, updateSteps, type UpdatePlan } from '../update-plan.js';
import type { OutdatedGolden } from './model.js';

/** What Fixes' dialogs say: the page's words, so the first look doesn't load them. No DOM here: the tests import it. */

/**
 * What Mark applied says before it runs `fix apply`: for a patch already in the working tree, what
 * apply still does (copies the goldens it is missing and runs them, unless the repair's recordings
 * stayed on a teammate's machine); for a change of request fields, which ones, since no patch
 * carries them; for a change verified on the working tree as it is, that there is no patch to apply.
 */
export function markLead(apply: Pick<NonNullable<FixDetail['actions']['apply']>, 'inTree' | 'goldens' | 'change'>): string {
  if (apply.change) return `Marks the fix applied once your agent sends ${apply.change}.`;
  if (!apply.inTree) return 'Marks the fix applied: it was verified on your working tree as it is.';
  return apply.goldens ? 'Copies the goldens it is missing into goldens/, runs them and marks the fix applied.' : 'Marks the fix applied; its patch is in your working tree already.';
}

/** What the team store's patch can't do here: said where it runs nothing. */
export const PULLED_LINE = 'It came from the team store, so nothing here runs it: the recordings stay on the machine that ran the repair';

/**
 * Apply fix's steps, in the order they change the working tree: every file the patch changes, the
 * recordings the fixed code made, and the replays after them. A teammate's patch, from the team
 * store, runs nothing here: the patch alone.
 */
export function applySteps(apply: Pick<NonNullable<FixDetail['actions']['apply']>, 'files' | 'pulled' | 'goldens'>): Array<{ what: string; where: string }> {
  const files = apply.files;
  const named = !files.length ? 'your files' : files.length === 1 ? files[0]! : `${files.slice(0, -1).join(', ')} and ${files.at(-1)!}`;
  const patch = { what: 'Patch applied', where: `${named}, with git apply` };
  if (apply.pulled) return [patch];
  const copied = apply.goldens === 1 ? 'Recording copied' : apply.goldens ? `${apply.goldens} recordings copied` : 'Recordings copied';
  return [patch, { what: copied, where: 'into goldens/' }, { what: apply.goldens === 1 ? 'Golden replayed' : 'Goldens replayed', where: 'shadowlap test, offline' }, { what: 'Other goldens replayed', where: 'any that diverge are named' }];
}

/** The good runs a repair must keep passing, as its command line gives them (`--keeps a b`), a run by its short id. */
export function keepsOf(argv: readonly string[]): string[] {
  const at = argv.indexOf('--keeps');
  if (at < 0) return [];
  const next = argv.findIndex((a, i) => i > at && a.startsWith('--'));
  return argv.slice(at + 1, next < 0 ? argv.length : next).map((a) => (/^[0-9A-Z]{26}$/.test(a) ? shortId(a) : a));
}

/** What Run repair bills, or that nothing runs where it would end "No fix to try". */
export function repairCost(repair: NonNullable<FixDetail['actions']['repair']>, stopped: boolean): { price: string; parts: string[] } {
  if (repair.noFixWhy) return { price: 'Free', parts: [repairRunsNothing(repair.noFixWhy)] };
  return { price: 'Billed by your provider', parts: repairParts(repair.candidates, stopped) };
}

/**
 * What the apply drawer's Update goldens asks before it re-records them, as the Tests screen's Update
 * goldens does: which, where the patch made them diverge, what an update does, and the command.
 */
export function updateOutdatedAsk(outdated: readonly OutdatedGolden[]): UpdatePlan & { fields: Record<string, unknown> } {
  const names = outdated.map((g) => g.golden);
  const one = names.length === 1;
  const short = (g: string) => g.split('/').pop()!;
  return {
    title: one ? `Update ${short(names[0]!)}?` : `Update ${names.length} diverged goldens?`,
    lead: `${one ? `Re-records ${short(names[0]!)}` : `Re-records the ${names.length} goldens`}, for a change you meant.`,
    doc: 'goldenUpdates',
    facts: [],
    goldens: outdated.map((g) => ({ path: g.golden, name: short(g.golden), where: `#${g.callNo} ~ ${g.path}` })),
    steps: updateSteps(one ? 'Replaced only if its checks pass' : 'Each replaced only if its checks pass', null),
    advise: null,
    instead: null,
    note: null,
    command: commandText(['test', ...names, '--update']),
    cost: recordingCost(one),
    ok: one ? confirmWords(ACTIONS.updateGolden.label) : `Update ${names.length} goldens`,
    fields: one ? { golden: names[0] } : { goldens: names },
  };
}
