import type { ReactNode } from 'react';
import { num } from '../format.js';

/**
 * Helpers for `table.t`, the design system's table: a header that sorts, a cell for numbers, and
 * "Show 50 more" under a long list.
 */

/**
 * A column the table sorts by, most first: only the column it is sorted by says so to a screen reader
 * (`aria-sort`), the arrow left to the eye, and its button a 24px target.
 */
export function SortTh<K extends string>({ by, sort, onSort, children, className = 'num' }: { by: K; sort: K; onSort: (k: K) => void; children: ReactNode; className?: string }) {
  const on = sort === by;
  return (
    <th className={className} aria-sort={on ? 'descending' : undefined}>
      <button type="button" data-sort={by} onClick={() => onSort(by)}>
        {children}
        {on ? <span aria-hidden="true"> ↓</span> : null}
      </button>
    </th>
  );
}

export function ShowMore({ shown, total, step = 50, onMore }: { shown: number; total: number; step?: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <button className="attn-more" type="button" onClick={onMore}>
      Showing {num(shown)} of {num(total)} · Show {num(Math.min(step, total - shown))} more
    </button>
  );
}

/**
 * What a table row spreads to open a page, unless the click was on a control inside it. `data-acts`
 * says so to the hover cards: a tap on a fact in the row opens it, and shows no card over the next page.
 */
export function rowOpen(go: () => void) {
  return {
    'data-acts': '',
    onClick: (e: React.MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('a, button, input, label, select')) return;
      if (e.metaKey || e.ctrlKey) return;
      go();
    },
  };
}
