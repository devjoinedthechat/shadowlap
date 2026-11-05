import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import type { ShortcutMark } from '../shortcuts.js';

/**
 * Underlined tabs with optional counts, as the pattern has them: the one shown is the one Tab stops
 * on, ← and → move along them round the ends, Home and End go to the first and last, and a count is
 * read apart from its name ("Calls 30"). The tab reached shows its panel as a click would and keeps
 * the focus, once it has drawn, so the card it shows for the focus says its keys as they are now.
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  panelId,
  listRef,
  onPointerEnter,
  onFocus,
}: {
  items: ReadonlyArray<{ key: K; label: string; count?: number | undefined; tip?: string | undefined; mark?: ShortcutMark | undefined }>;
  value: K;
  onChange: (k: K) => void;
  label?: string;
  /** Each tab's id is `<idPrefix>-<key>`, which the panel names as its label. */
  idPrefix?: string;
  panelId?: string;
  listRef?: RefObject<HTMLDivElement | null>;
  onPointerEnter?: () => void;
  onFocus?: () => void;
}) {
  const own = useRef<HTMLDivElement>(null);
  const strip = listRef ?? own;
  const reached = useRef<K | null>(null);
  useLayoutEffect(() => {
    if (reached.current !== value) return;
    reached.current = null;
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [value, strip]);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const at = items.findIndex((t) => t.key === value);
    const n = items.length;
    const to = items[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (at + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
    e.preventDefault();
    e.stopPropagation();
    if (!to) return;
    reached.current = to.key;
    onChange(to.key);
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={strip} onKeyDown={keys} onPointerEnter={onPointerEnter} onFocus={onFocus}>
      {items.map((t) => (
        <button
          key={t.key}
          id={idPrefix ? `${idPrefix}-${t.key}` : undefined}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          aria-controls={panelId}
          aria-label={t.count !== undefined ? `${t.label} ${t.count.toLocaleString('en-US')}` : undefined}
          tabIndex={value === t.key ? 0 : -1}
          data-tip={t.tip}
          onClick={() => onChange(t.key)}
          {...t.mark}
        >
          {t.label}
          {t.count !== undefined ? <span className="count">{t.count.toLocaleString('en-US')}</span> : null}
        </button>
      ))}
    </div>
  );
}
