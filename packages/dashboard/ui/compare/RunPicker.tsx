import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Icon } from '../components/Icon.js';
import { shortId } from '../format.js';
import { placeList } from '../place.js';
import { useLayer } from '../state.js';
import type { RunListItem } from '../types.js';

/**
 * A run picker (Compare's A and B, Redaction's preview): a button with the run's id, then its about line fitted to the rest
 * of it (decision 10), opening a list of runs in the same form, the one picked marked, under the button
 * or over it where there is more room. ↑ ↓ move, Enter picks, Esc closes. A native select can't set
 * the about line apart from the id, so this is a listbox.
 */
/** What a picker lists of a run: its id and its about line. */
export type PickableRun = Pick<RunListItem, 'runId' | 'about'>;

export function RunPicker({ label, value, runs, onPick }: { label: string; value: string; runs: readonly PickableRun[]; onPick: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const shown = runs.find((r) => r.runId === value || r.runId.startsWith(value)) ?? null;
  const id = shown?.runId ?? value;
  const box = useRef<HTMLSpanElement>(null);
  useFitAbouts(box);
  return (
    <span className="pick" ref={box}>
      <button ref={button} className="rpick" type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${shortId(id)}${shown?.about ? `, ${shown.about.text}` : ''}`} onClick={() => setOpen(!open)}>
        <code className="pid">{shortId(id)}</code>
        <AboutLine about={shown?.about} className="pab" />
        <Icon name="caret" className="caret" />
      </button>
      {open && button.current ? (
        <PickList
          anchor={button.current}
          label={label}
          runs={runs}
          current={id}
          onPick={(runId) => {
            setOpen(false);
            button.current?.focus();
            if (runId !== id) onPick(runId);
          }}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}

function PickList({ anchor, label, runs, current, onPick, onClose }: { anchor: HTMLElement; label: string; runs: readonly PickableRun[]; current: string; onPick: (runId: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  useLayer('menu', true, onClose);
  useFitAbouts(ref);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const put = () => setPlace(placeList(anchor.getBoundingClientRect(), el.scrollHeight, { width: innerWidth, height: innerHeight }));
    put();
    addEventListener('resize', put);
    return () => removeEventListener('resize', put);
  }, [anchor]);
  // The run picked takes the focus, in view, once the list is placed.
  const placed = place !== null;
  useEffect(() => {
    if (!placed) return;
    const on = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? ref.current?.querySelector<HTMLElement>('button');
    on?.focus();
    on?.scrollIntoView?.({ block: 'nearest' });
  }, [placed]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [anchor, onClose]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
  };
  return (
    <div ref={ref} className="pop rpicks" role="listbox" aria-label={label} onKeyDown={keys} style={place ? { top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight } : { visibility: 'hidden', top: 0, left: 0 }}>
      {runs.map((r) => (
        <button key={r.runId} type="button" role="option" aria-selected={r.runId === current} onClick={() => onPick(r.runId)}>
          <code className="pid">{shortId(r.runId)}</code>
          <AboutLine about={r.about} className="pab" />
        </button>
      ))}
    </div>
  );
}
