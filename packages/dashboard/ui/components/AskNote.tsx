import { useLayoutEffect, useRef } from 'react';
import { askedOverThreshold, askWords } from '../../../engine/src/estimates/spending.js';
import { href } from '../route.js';
import { askSpendingFocus, useSpending, type Priced } from '../spending.js';

/**
 * At the left of an ask's footer, where the threshold is why it asks: `Asks above $0.50 · Change`,
 * `Always asks · Change`. Not for an ask that asks on every setting (no estimate, a form, a job that
 * asks for what it does, one priced by the unit), nor before the threshold is known. Change, named
 * "Change Spending", starts nothing: it goes to Settings → Project, its Spending row taking the focus,
 * and the ask goes with the page it was over.
 */
export function AskNote({ estimate, form = false }: { estimate: Priced; form?: boolean }) {
  const threshold = useSpending();
  const shown = threshold !== undefined && askedOverThreshold(estimate ?? null, threshold, { form });
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const note = ref.current;
    if (!note) return;
    footFit(note);
    let wait: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      clearTimeout(wait);
      wait = setTimeout(() => footFit(note), 200);
    };
    window.addEventListener('resize', again);
    return () => {
      clearTimeout(wait);
      window.removeEventListener('resize', again);
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <span ref={ref} className="dlgcost">
      {askWords(threshold)} ·{' '}
      <a className="more" href={href.settings('project')} aria-label="Change Spending" onClick={askSpendingFocus}>
        Change
      </a>
    </span>
  );
}

/**
 * Cancel and the way on stay together on one row: where they don't fit beside the note, it takes a row
 * of its own above them, as it does on a phone, never the way on alone under Cancel.
 */
function footFit(note: HTMLElement): void {
  note.classList.remove('own');
  const bottom = note.getBoundingClientRect().bottom;
  const buttons = [...(note.parentElement?.children ?? [])].filter((b) => b.classList.contains('btn'));
  note.classList.toggle(
    'own',
    buttons.some((b) => {
      const r = b.getBoundingClientRect();
      return r.height > 0 && r.top >= bottom - 1;
    }),
  );
}
