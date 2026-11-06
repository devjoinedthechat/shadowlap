import { tipCard } from '../components/HoverCard.js';
import { num } from '../format.js';
import { filterTerms } from '../../src/links.js';

/** What Runs' filter takes, as its placeholder says it; an exported copy has no index of what runs recorded, nor their tool calls. */
export const FILTER_PLACEHOLDER = 'Filter: words, label:, status:, type: or tool:';
export const COPY_FILTER_PLACEHOLDER = 'Filter: words, label:, status: or type:';

/** The field's hover card: a term of each kind, and how they go together. */
const FILTER_TIP = tipCard('Filter runs', [], 'label:refund-bug · status:failed · type:fork · tool:issue_refund · words, which also search what runs recorded. Each narrows the others.');
const COPY_FILTER_TIP = tipCard('Filter runs', [], 'label:refund-bug · status:failed · type:fork · words. Each narrows the others.');

/** How many runs a filter matches, as the field says it beside its words: `207 runs match`, `1 run matches`. */
export function matchWords(n: number): string {
  return `${num(n)} ${n === 1 ? 'run matches' : 'runs match'}`;
}

/** Whether a filter holds a term of any kind: a word, a quoted phrase, `label:`, `status:`, `type:` or `tool:`. */
export function hasTerms(q: string): boolean {
  const t = filterTerms(q);
  return t.words.length + t.labels.length + t.statuses.length + t.types.length + t.tools.length > 0;
}

/**
 * Runs' filter field (`/` reaches it; Enter makes its words a step in the history, `onCommit`; Esc
 * leaves it with its words kept, for the row in focus) and, while the words it settled on hold a
 * term, how many runs match them. The count's live region stays while it is empty, so a screen
 * reader hears each change. `copy`: an exported copy's own words.
 */
export function RunsFilterField({ value, onChange, onCommit, settled, total, loaded, copy = false }: { value: string; onChange: (v: string) => void; onCommit: () => void; settled: string; total: number; loaded: boolean; copy?: boolean }) {
  const counted = loaded && hasTerms(settled);
  return (
    <div className="rqw">
      <label className="tin rq">
        <span className="sr">Filter runs</span>
        <input id="runsQuery" type="search" spellCheck={false} placeholder={copy ? COPY_FILTER_PLACEHOLDER : FILTER_PLACEHOLDER} data-tip={copy ? COPY_FILTER_TIP : FILTER_TIP} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && onCommit()} />
      </label>
      <span className="qn" role="status">
        {counted ? matchWords(total) : ''}
      </span>
    </div>
  );
}
