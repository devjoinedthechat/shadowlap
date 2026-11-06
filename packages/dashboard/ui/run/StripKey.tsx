import { useLayoutEffect, useRef, type RefObject } from 'react';
import { SrSpace } from '../components/bits.js';
import { keyItems, type CallFilter, type KeyCounts, type KeyItem } from './call-filter.js';
import { balanceRow } from './fit-head.js';
import { RunStrip, type RunStripProps } from './RunStrip.js';

/**
 * The strip's key, which is the call filter: on a recording or a capture `every call live` first (its
 * two neutral tones are live's), then all and each kind or origin the run has, its swatch, its word and
 * its count. A pick shows only those calls in Calls and dims the rest of the strip. Where the key wraps
 * under the cells, its rows are balanced, so no chip is left alone on the last.
 */
export function StripKey({ items, byKind, filter, onFilter }: { items: readonly KeyItem[]; byKind: boolean; filter: CallFilter; onFilter: (f: CallFilter) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useBalanced(box, items.map((i) => `${i.key}${i.count}`).join(' '));
  return (
    <div className="legend lfilter" id="olegend" role="group" aria-label="Show calls" ref={box}>
      {byKind ? <span className="lk">every call live</span> : null}
      {items.map((it) => (
        <button key={it.key} type="button" data-of={it.key} aria-pressed={filter === it.key} onClick={() => onFilter(it.key)}>
          {it.swatch ? <i className={`lg ${it.key}`} /> : null}
          {it.word}
          <SrSpace />
          <b>{it.count.toLocaleString('en-US')}</b>
        </button>
      ))}
    </div>
  );
}

/**
 * Balances the key's rows when its chips or its room change, never on a render that changed neither,
 * and once the web fonts land, which can be wider than the fallback it was measured in. Its room is
 * the run page's width (`.rv`): up to 1000px the strip around the key draws no box of its own
 * (`display: contents`), so it has no width to read and never resizes.
 */
function useBalanced(box: RefObject<HTMLDivElement | null>, chips: string): void {
  const last = useRef({ chips: '', width: -1 });
  useLayoutEffect(() => {
    const el = box.current;
    const room = el?.closest<HTMLElement>('.rv') ?? el?.parentElement;
    if (!el || !room || typeof ResizeObserver !== 'function') return;
    let frame = 0;
    let gone = false;
    const fit = (fonts = false) => {
      const width = room.clientWidth;
      if (!fonts && last.current.chips === chips && last.current.width === width) return;
      last.current = { chips, width };
      balanceRow(el);
    };
    fit();
    const ro = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), fit()));
    });
    ro.observe(room);
    if (document.fonts?.status === 'loading') void document.fonts.ready.then(() => gone || fit(true), () => undefined);
    return () => {
      gone = true;
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [box, chips]);
}

/** Filter calls, at the strip's end: typing shows Calls; `/` comes here from any view. */
export function FilterField({ text, onText, inputRef }: { text: string; onText: (t: string) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  return (
    <label className="filter-in">
      <span className="sr">Filter calls</span>
      <input ref={inputRef} type="search" placeholder="Filter calls" value={text} onChange={(e) => onText(e.target.value)} />
      <span className="kbd">/</span>
    </label>
  );
}

/**
 * The strip's row: the cells, the key that filters the calls and Filter calls. A pick or a word typed
 * from another view shows Calls, where the calls it keeps are listed.
 */
export function StripBar({ strip, counts, filter, onFilter, text, onText, inputRef, toCalls }: { strip: Omit<RunStripProps, 'pick'>; counts: KeyCounts; filter: CallFilter; onFilter: (f: CallFilter) => void; text: string; onText: (t: string) => void; inputRef: RefObject<HTMLInputElement | null>; toCalls: () => void }) {
  const pick = (f: CallFilter) => {
    onFilter(f);
    if (f !== 'all') toCalls();
  };
  const type = (t: string) => {
    onText(t);
    toCalls();
  };
  return (
    <section className="strip" aria-label="The run’s calls">
      {strip.calls.length ? <RunStrip {...strip} pick={filter === 'all' ? null : filter} /> : <div className="cells empty-strip">{strip.live ? 'Waiting for the first call…' : 'No calls.'}</div>}
      {strip.calls.length ? <StripKey items={keyItems(counts, strip.byKind)} byKind={strip.byKind} filter={filter} onFilter={pick} /> : null}
      <FilterField text={text} onText={type} inputRef={inputRef} />
    </section>
  );
}
