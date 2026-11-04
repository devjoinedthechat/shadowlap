import { ACTIONS, confirmWords, forceLiveLabel } from '../../engine/src/action-words.js';

/**
 * The dashboard's words for its actions, read by every place that offers one: its buttons, menu
 * items and ⌘K entries, its dialogs' titles and confirms, its drawers and its toasts. Each action has
 * one name (the engine's `ACTIONS`, which the terminal UI and the server's job titles read too): its
 * dialog is titled and confirmed with it, without the ellipsis; its drawer says it in the -ing form,
 * and its toast in the past tense. No DOM here: the tests import it.
 */

export { ACTIONS, confirmWords, forceLiveLabel };

/** Each -ing word a job's title starts with, and its past tense: `Running tests` ends as `Ran tests`. */
const PAST: Readonly<Record<string, string>> = {
  Adding: 'Added',
  Applying: 'Applied',
  Blaming: 'Blamed',
  Calibrating: 'Calibrated',
  Checking: 'Checked',
  Cleaning: 'Cleaned',
  Connecting: 'Connected',
  Deleting: 'Deleted',
  Exporting: 'Exported',
  Finding: 'Found',
  Forking: 'Forked',
  Importing: 'Imported',
  Inspecting: 'Inspected',
  Migrating: 'Migrated',
  Packing: 'Packed',
  Planting: 'Planted',
  Previewing: 'Previewed',
  Pulling: 'Pulled',
  Pushing: 'Pushed',
  Reading: 'Read',
  Recording: 'Recorded',
  Repairing: 'Repaired',
  Repeating: 'Repeated',
  Replaying: 'Replayed',
  Running: 'Ran',
  Scoring: 'Scored',
  Sending: 'Sent',
  Sharing: 'Shared',
  Testing: 'Tested',
  Updating: 'Updated',
  Verifying: 'Verified',
};

/**
 * A verb whose past tense would claim more than happened (verified, repaired, found) when the job
 * didn't end well: what ran instead, the rest of the title as it was (`Tried repairing`).
 */
const TRIED: Readonly<Record<string, string>> = {
  Finding: 'Searched for',
  Migrating: 'Tried migrating',
  Packing: 'Tried packing',
  Repairing: 'Tried repairing',
  Verifying: 'Checked',
  Applying: 'Tried applying',
  Connecting: 'Tried connecting',
};

/**
 * A job's title in the past tense, for the toast that says it ended: word by word, each -ing word in
 * its past tense (`Adding normalizer and updating golden` ends as `Added normalizer and updated
 * golden`), with no ellipsis. One that didn't end well (`ok` false) leads with what ran where the past
 * tense would claim more (`Tried repairing`). A title with no -ing word stays as it is.
 */
export function doneWords(title: string, ok: boolean): string {
  const words = title.replace(/…$/, '').split(' ');
  const tried = ok ? undefined : TRIED[words[0] ?? ''];
  if (tried) return [tried, ...words.slice(1)].join(' ');
  const past = (w: string, i: number): string => {
    const p = PAST[`${w.charAt(0).toUpperCase()}${w.slice(1)}`];
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
