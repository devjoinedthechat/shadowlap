import { copyText } from './dom.js';
import { shortId } from './format.js';
import type { RowScope } from './list-keys.js';
import { href } from './route.js';
import { navigate } from './router.js';
import { compareTarget, type RunLike } from './runs.js';

type ListedRun = RunLike & { about?: { text: string } | null };

/**
 * A run's row, for ⌘K on it in a list: open it, compare it, copy its id, select it. `runs` is the
 * run list, whose children tell Compare which run it pairs with, as the run's own header does.
 * `pick`: where rows have a checkbox.
 */
export function runRowScope(r: ListedRun, o: { runs: readonly (RunLike & { startedAt: number })[]; toast: (text: string) => void; pick?: (() => void) | null; picked?: boolean }): RowScope {
  const pair = compareTarget(r, o.runs.filter((x) => x.parentRunId === r.runId));
  return {
    name: shortId(r.runId),
    items: () => [
      { label: 'Open run', hint: r.about?.text ?? '', run: () => navigate(href.run(r.runId)) },
      ...(pair ? [{ label: r.parentRunId ? 'Compare with parent' : 'Compare', hint: `shadowlap diff ${shortId(pair[0])} ${shortId(pair[1])}`, run: () => navigate(href.compare(pair[0], pair[1])) }] : []),
      { label: 'Copy ID', hint: r.runId, run: () => void copyText(r.runId).then((ok) => o.toast(ok ? 'Copied the run id' : 'Copying was refused by the browser')) },
      ...(o.pick ? [{ label: o.picked ? 'Deselect run' : 'Select run', hint: 'to label, pack, export or compare it with others', key: 'x', run: o.pick }] : []),
    ],
  };
}
