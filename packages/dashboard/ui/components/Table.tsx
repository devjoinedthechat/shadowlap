import type { ReactNode } from 'react';
import { num } from '../format.js';

/**
 * Helpers for `table.t`, the design system's table: a header that sorts, a cell for numbers, and
 * "Show 50 more" under a long list.
 */

export function SortTh<K extends string>({ by, sort, onSort, children, className = 'num' }: { by: K; sort: K; onSort: (k: K) => void; children: ReactNode; className?: string }) {
  return (
    <th className={className} aria-sort={sort === by ? 'descending' : 'none'}>
      <button type="button" onClick={() => onSort(by)}>
        {children}
        {sort === by ? ' ↓' : ''}
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
