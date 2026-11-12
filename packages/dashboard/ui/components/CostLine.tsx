import { useEffect, type ReactNode, type RefObject } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { FORK_LIVE } from '../../../engine/src/cost-words.js';
import { costLine } from '../../../engine/src/estimates/spending.js';
import { Words } from './Copy.js';
import { codeWords } from './DialogFacts.js';
import { DotBlocks } from './DotParts.js';
import { tipCard } from './HoverCard.js';

export interface CostLineProps {
  /** What it bills, first and in ink. */
  price: ReactNode;
  /** After a dot each: how many attempts, and where it runs live. */
  parts?: readonly ReactNode[];
  /** It bills one way on of two and keeps its place under that one's command. */
  flow?: boolean;
  /**
   * The job's estimate, which the line says in place of `price` and `parts` once it has come: the
   * price first, with what one attempt, candidate or commit costs on its card where it has one.
   * Undefined while it is worked out, when `price` and `parts` say it; null for none.
   */
  estimate?: CostEstimate | null | undefined;
}

/** What a cost line says of an estimate. */
export type CostEstimate = Pick<Estimate, 'usd' | 'ceiling' | 'note' | 'parts' | 'per' | 'recurs' | 'stops' | 'card'>;

/** An estimate's line: its price in ink, then its parts. */
function estimateParts(e: CostEstimate): ReactNode[] {
  const [price = '', ...parts] = costLine(e);
  return [<b key="price">{priceOf(e, price)}</b>, ...parts.map(partOf)];
}

/** A part as the line says it: `live where a replay forks` on a card of its own, saying what a run whose replay doesn't fork costs. */
function partOf(part: ReactNode): ReactNode {
  if (typeof part !== 'string' || !part.startsWith(FORK_LIVE.part)) return codeWords(part);
  return (
    <>
      <span className="dtip" tabIndex={0} data-tip={tipCard(FORK_LIVE.card.title, [], FORK_LIVE.card.line)}>
        <Words>{FORK_LIVE.part}</Words>
      </span>
      {codeWords(part.slice(FORK_LIVE.part.length))}
    </>
  );
}

/** The price as the line says it: on a card of its own, a Tab stop, where the estimate has one. */
function priceOf(e: CostEstimate, price: string): ReactNode {
  if (!e.card || e.usd === null) return <Words>{price}</Words>;
  return (
    <span className="dtip" tabIndex={0} data-tip={tipCard(e.card.title, [], e.card.lines.join('\n'))}>
      <Words>{price}</Words>
    </span>
  );
}

/**
 * What a dialog bills, in one quiet line: the price, then each part kept whole, so a line too narrow
 * for all of it breaks after a dot, each part's words glued. It holds the foot of the body while the
 * body scrolls.
 */
export function CostLine({ price, parts = [], flow = false, estimate }: CostLineProps) {
  const all = estimate ? estimateParts(estimate) : [<b key="price">{codeWords(price)}</b>, ...parts.map(partOf)];
  return (
    <p className={`dlgnote dcost${flow ? ' flow' : ''}`}>
      <DotBlocks parts={all} className="dcp" />
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
