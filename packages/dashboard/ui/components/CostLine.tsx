import { useEffect, type ReactNode, type RefObject } from 'react';

export interface CostLineProps {
  /** What it bills, first and in ink. */
  price: ReactNode;
  /** After a dot each: how many attempts, and where it runs live. */
  parts?: readonly ReactNode[];
  /** It bills one way on of two and keeps its place under that one's command. */
  flow?: boolean;
}

/**
 * What a dialog bills, in one quiet line: the price, then each part kept whole, so a line too narrow
 * for all of it breaks after a dot. It holds the foot of the body while the body scrolls.
 */
export function CostLine({ price, parts = [], flow = false }: CostLineProps) {
  const all = [<b key="price">{price}</b>, ...parts];
  return (
    <p className={`dlgnote dcost${flow ? ' flow' : ''}`}>
      {all.map((part, i) => (
        <span key={i}>
          <span className="dcp">
            {part}
            {i < all.length - 1 ? '\u00a0·' : null}
          </span>
          {i < all.length - 1 ? ' ' : null}
        </span>
      ))}
    </p>
  );
}

/** Draws the cost line's hairline only while the body runs on under it: on a scroll, a resize and whenever the body changes. */
export function useCostStick(body: RefObject<HTMLElement | null>, drawn: boolean) {
  useEffect(() => {
    const db = body.current;
    if (!db || !drawn) return;
    const mark = () => {
      const line = [...db.querySelectorAll('.dcost:not(.flow)')].at(-1);
      if (!line?.classList) return;
      const under = db.scrollHeight - db.clientHeight - db.scrollTop > 1;
      line.classList.toggle('stuck', under && line.getBoundingClientRect().bottom >= db.getBoundingClientRect().bottom - 1);
    };
    db.addEventListener('scroll', mark, { passive: true });
    window.addEventListener('resize', mark);
    const seen = typeof MutationObserver === 'function' ? new MutationObserver(mark) : null;
    seen?.observe(db, { childList: true, subtree: true, characterData: true });
    const first = setTimeout(mark, 0);
    return () => {
      clearTimeout(first);
      seen?.disconnect();
      db.removeEventListener('scroll', mark);
      window.removeEventListener('resize', mark);
    };
  }, [body, drawn]);
}
