import { ACTIONS, confirmWords, forceLiveLabel, STRONGER_MODEL } from '../../engine/src/action-words.js';
import { plural } from './format.js';

/**
 * The dashboard's words for its actions, read by every place that offers one: its buttons, menu
 * items and ⌘K entries, its dialogs' titles and confirms, its drawers and its toasts. Each action has
 * one name (the engine's `ACTIONS`, which the terminal UI and the server's job titles read too): its
 * dialog is titled and confirmed with it, without the ellipsis; its drawer says it in the -ing form,
 * and its toast in the past tense. No DOM here: the tests import it.
 */

export { ACTIONS, confirmWords, forceLiveLabel, STRONGER_MODEL };

/** Each -ing word a job's title starts with, and its past tense: `Running tests` ends as `Ran tests`. */
const PAST: Readonly<Record<string, string>> = {
  Adding: 'Added',
  Applying: 'Applied',
  Blaming: 'Blamed',
  Calibrating: 'Calibrated',
  Changing: 'Changed',
  Checking: 'Checked',
  Cleaning: 'Cleaned',
  Connecting: 'Connected',
  Deleting: 'Deleted',
  Exporting: 'Exported',
  Finding: 'Found',
  Forking: 'Forked',
  Importing: 'Imported',
  Finishing: 'Finished',
  Inspecting: 'Inspected',
  Installing: 'Installed',
  Marking: 'Marked',
  Migrating: 'Migrated',
  Packing: 'Packed',
  Planting: 'Planted',
  Previewing: 'Previewed',
  Pulling: 'Pulled',
  Pushing: 'Pushed',
  Reading: 'Read',
  Recording: 'Recorded',
  'Re-running': 'Re-ran',
  Repairing: 'Repaired',
  Repeating: 'Repeated',
  Replaying: 'Replayed',
  Reverting: 'Reverted',
  Running: 'Ran',
  Scoring: 'Scored',
  Sending: 'Sent',
  Sharing: 'Shared',
  Testing: 'Tested',
  Updating: 'Updated',
  Verifying: 'Verified',
};

/**
 * The -ing words whose past tense says only that the job ran, whatever came of it: `Ran tests · 1
 * failed`, `Replayed · diverged at #3`. Every other one's says it did what it set out to (imported,
 * exported, deleted, repaired, blamed), which a job that came out badly didn't.
 */
const RAN: ReadonlySet<string> = new Set(['Checking', 'Forking', 'Inspecting', 'Planting', 'Previewing', 'Reading', 'Recording', 'Re-running', 'Repeating', 'Replaying', 'Running', 'Testing']);

/** What ran, for a verb whose own words for it are not `Tried <verb>`: a verify checked, a search searched. */
const TRIED: Readonly<Record<string, string>> = {
  Finding: 'Searched for',
  Verifying: 'Checked',
};

/**
 * How a job came out, as its toast words its title: it did what its title says (`ok`); it ran, and
 * came out badly (`ran`: tests that failed, a replay that diverged, a search that found nothing); or
 * it never did (`not`: refused before it ran, or an error and nothing more).
 */
export type JobEnd = 'ok' | 'ran' | 'not';

/**
 * A job's title in the past tense, for the toast that says it ended, where that claims no more than
 * happened: word by word, each -ing word in its past tense (`Adding normalizer and updating golden`
 * ends as `Added normalizer and updated golden`), with no ellipsis, for a job that did what its title
 * says, or whose own status says it did (`applied · tests failed`, after Applying fix); for one that
 * ran and came out badly, only where the past tense says no more than that it ran (`Ran tests`). A
 * title of several steps is judged by its last, the one its status is about, as a step runs only once
 * the one before it succeeded: `Packed and tested · 1 failed`, `Added normalizer and re-ran · 1
 * failed`. Otherwise it leads with what ran, the rest of the title as it was: `Tried importing
 * capture`, `Searched for breaking commit`. A title with no -ing word stays as it is, and one with a
 * colon is judged by its words before it: `Searched for cause: testing #4`, whatever the answer.
 */
export function doneWords(title: string, end: JobEnd, status = ''): string {
  // A title that says what it does after a colon (`Finding cause: testing #4`) is judged by its words before it, the rest kept.
  const colon = title.indexOf(': ');
  if (colon > 0) return `${doneWords(title.slice(0, colon), end, status)}${title.slice(colon)}`;
  const words = title.replace(/…$/, '').split(' ');
  const first = words[0] ?? '';
  const ing = (w: string): string => `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
  if (!PAST[first]) return words.join(' ');
  const last = ing(words.filter((w) => PAST[ing(w)]).at(-1)!);
  const did = end === 'ok' || (end === 'ran' && (RAN.has(last) || status.toLowerCase().startsWith(PAST[last]!.toLowerCase())));
  if (!did) return [TRIED[first] ?? `Tried ${first.toLowerCase()}`, ...words.slice(1)].join(' ');
  const past = (w: string, i: number): string => {
    const p = PAST[ing(w)];
    return !p ? w : i ? p.toLowerCase() : p;
  };
  return words.map(past).join(' ');
}

/**
 * An action's name as its dialog's title and confirm say it: its label without the ellipsis, and the
 * call it acts from by number (`Run live from #17`, never "from here").
 */
export function dialogName(label: string, callNo: number | null): string {
  const name = confirmWords(label);
  return callNo === null ? name : name.replace(/ from here$/, ` from #${callNo}`);
}

/**
 * The bulk bar's words over the runs picked. Delete counts every run picked, one still recording
 * among them, as its dialog says what it takes; Pack and Export dataset… wait while every run picked
 * is still recording, as a copy made now would be cut off.
 */
export const BULK = {
  label: 'Add label…',
  dataset: `${ACTIONS.exportDataset.confirm}…`,
  clear: 'Clear selection',
  delete: (runs: number): string => `Delete ${plural(runs, 'run')}`,
  waits: (runs: number): string => `Still recording: try when ${runs === 1 ? 'it ends' : 'they end'}`,
  waitsTip: (runs: number): string => `Waits until ${runs === 1 ? 'the recording ends' : 'the recordings end'}: a copy now would be cut off`,
} as const;

/** Push local runs' card, on Runs' header and Needs a look's row: what pushing does, and the command its job runs. */
export const PUSH_LOCAL = { label: 'Push local runs', sub: 'Copies them to the store with your credentials; nothing passes through Shadowlap', command: 'shadowlap push --all' } as const;
