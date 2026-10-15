import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Hover cards: one style everywhere, a title and coloured rows. An element opts in with a `data-tip`
 * attribute (`tipText` or `tipCard`), and one layer follows the pointer, so a strip of 360 cells
 * costs one listener, not 360.
 */

export interface TipRow {
  label: string;
  value: string;
  /** A colour token such as `var(--o-rep)`. */
  color?: string;
}

interface Tip {
  t: string;
  rows?: Array<[string, string, string?]>;
}

/** A card with a title only, such as an icon's words. */
export function tipText(t: string): string {
  return JSON.stringify({ t } satisfies Tip);
}

/** A card with a title and rows: what a strip cell, a bar or a chart group holds. */
export function tipCard(t: string, rows: TipRow[]): string {
  return JSON.stringify({ t, rows: rows.map((r) => [r.label, r.value, r.color ?? '']) } satisfies Tip);
}

function read(el: Element): Tip | null {
  const raw = (el as HTMLElement).dataset.tip;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Tip;
    return typeof v.t === 'string' ? v : null;
  } catch {
    return { t: raw };
  }
}

export function HoverCardLayer() {
  const [tip, setTip] = useState<{ d: Tip; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      const d = el ? read(el) : null;
      setTip(d ? { d, x: e.clientX, y: e.clientY } : null);
    };
    const hide = () => setTip(null);
    document.addEventListener('mousemove', move);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
  // Placed after it is drawn, so it can flip to stay on screen.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null);
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let x = tip.x + 14;
    let y = tip.y + 14;
    if (x + w > innerWidth - 8) x = tip.x - w - 14;
    if (y + h > innerHeight - 8) y = tip.y - h - 14;
    setPos({ left: Math.max(8, x), top: Math.max(8, y) });
  }, [tip]);
  if (!tip) return null;
  return (
    <div className="tip" ref={ref} role="tooltip" style={pos ?? { left: tip.x + 14, top: tip.y + 14, visibility: 'hidden' }}>
      <b>{tip.d.t}</b>
      {(tip.d.rows ?? []).map(([label, value, color], i) => (
        <div key={i}>
          <i style={color ? { background: color } : undefined} />
          {label}
          <em>{value}</em>
        </div>
      ))}
    </div>
  );
}
