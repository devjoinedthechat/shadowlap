import { copyText } from './dom.js';
import { shortId } from './format.js';
import type { RowScope } from './list-keys.js';
import { href } from './route.js';
import { navigate } from './router.js';
import { compareTarget, isAttempt, type RunLike } from './runs.js';
import type { NextStepRow } from './types.js';

type ListedRun = RunLike & { about?: { text: string } | null; next?: NextStepRow | null; replay?: NextStepRow | null };

/**
 * A run's row, for ⌘K on it in a list: open it, its next step, replay it, compare it, copy its id,
 * select it. `runs` is the run list, whose children tell Compare which run it pairs with, as the
 * run's own header does. The next step and Replay are the palette's to build (`step`,
 * run/row-step.ts): Replay is the step where it leads, none while the run records, and a step that
 * compares takes Compare's place. `pick`: where rows have a checkbox, with its key from the table of
 * keys, which that page has loaded: the sidebar draws this too, and the first look doesn't hold the
 * table.
 */
export function runRowScope(r: ListedRun, o: { runs: readonly (RunLike & { startedAt: number })[]; toast: (text: string) => void; pick?: (() => void) | null; picked?: boolean; pickKey?: string }): RowScope {
  const pair = compareTarget(r, o.runs.filter((x) => x.parentRunId === r.runId && !isAttempt(x)));
  const replays = r.next?.key === 'replay';
  const compares = r.next?.key === 'compare';
  return {
    name: shortId(r.runId),
    items: (step) => {
      const next = r.next && !replays && step ? step(r.runId, r.next) : null;
      const replayRow = r.status === 'running' ? null : replays ? r.next : r.replay;
      const replay = replayRow && step ? step(r.runId, replayRow) : null;
      const compare = compares && next ? next : pair ? { label: r.parentRunId ? 'Compare with parent' : 'Compare', hint: `shadowlap diff ${shortId(pair[0])} ${shortId(pair[1])}`, run: () => navigate(href.compare(pair[0], pair[1])) } : null;
      return [
        { label: 'Open run', hint: r.about?.text ?? '', run: () => navigate(href.run(r.runId)) },
        ...(next && !compares ? [next] : []),
        ...(replay ? [replay] : []),
        ...(compare ? [compare] : []),
        { label: 'Copy ID', hint: r.runId, run: () => void copyText(r.runId).then((ok) => o.toast(ok ? 'Copied the run id' : 'Copying was refused by the browser')) },
        ...(o.pick ? [{ label: o.picked ? 'Deselect run' : 'Select run', hint: 'to label, pack, export or compare it with others', ...(o.pickKey ? { key: o.pickKey } : {}), run: o.pick }] : []),
      ];
    },
  };
}
