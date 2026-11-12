import { Fragment, type ReactNode } from 'react';
import { NO_MARKS, type Marks } from '../components/marks.js';
import { inspectorInView } from '../run/InspectorPanel.js';
import type { RunInjection } from '../types.js';
import type { ProofTab } from './Proof.js';

/*
 * What only an injection attempt's page does, in a script of its own that loads once a page reads an
 * attempt (attempt-load.ts): its inspector's marks, the tab a call its proof names opens on, and the
 * scroll to the call's first mark. The served dashboard hands it in (pages/served.tsx): a copy, which
 * keeps no attempt's read, holds none of it, and a run's page loads none of it until it is one.
 */

type Needle = readonly [text: string, cls: 'ins-plant' | 'cnry'];

/** The text with each needle cut out into a mark of its class, the later needles marked inside it too: the canary in the planted text. */
function marked(text: string, needles: readonly Needle[]): ReactNode {
  const i = needles.findIndex(([n]) => text.includes(n));
  if (i < 0) return text;
  const [needle, cls] = needles[i]!;
  const rest = needles.slice(i + 1);
  const parts = text.split(needle);
  return parts.map((part, k) => (
    <Fragment key={k}>
      {part ? marked(part, rest) : null}
      {k < parts.length - 1 ? <mark className={cls}>{marked(needle, rest)}</mark> : null}
    </Fragment>
  ));
}

/**
 * What an injection attempt's inspector marks, from the attempt's read (`/api/injection/runs/:id`):
 * the planted text violet, as JSON writes it and as plain text, for a result the model reads either
 * way; each form of the canary red (its address, id and amount); the planted turn's label; and the
 * planted read's Response head. A baseline planted nothing, and a copy has no read: nothing is marked.
 */
export function attemptMarks(a: RunInjection['attempt'] | undefined): Marks {
  if (!a || a.role === 'baseline') return NO_MARKS;
  const planted = a.role === 'attempt' && a.planted ? [JSON.stringify(a.planted).slice(1, -1), a.planted] : [];
  const canary = a.canary ? [a.canary.address, a.canary.id, a.canary.amount] : [];
  const needles: Needle[] = [...new Set(planted)].map((t) => [t, 'ins-plant'] as const);
  for (const t of canary) if (t) needles.push([t, 'cnry']);
  const holds = (v: unknown) => {
    const text = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
    return needles.some(([n]) => text.includes(n));
  };
  const clean = a.role === 'clean';
  return {
    mark: (text) => marked(text, needles),
    holds,
    changed: `${clean ? 'made neutral for this attempt' : 'planted in this attempt'}${a.readAt ? ` · read at #${a.readAt}` : ''}`,
    head: (n) =>
      n !== a.plantedAt ? null : clean ? (
        'Overridden: the recorded result made neutral, every string with a space in it emptied:'
      ) : (
        <>
          Overridden: the recorded result with the payload planted after <code>{a.path ?? '$'}</code>:
        </>
      ),
  };
}

/** The tab that shows what an attempt's proof names at call `n`: the canary's write on Request, the read of the planted text on Conversation, the planted read on Response (a baseline planted nothing). */
export function proofTab(a: NonNullable<RunInjection['attempt']>, n: number): ProofTab | null {
  return a.evidence?.some((e) => e.callNo === n) ? 'request' : n === a.readAt ? 'conversation' : n === a.plantedAt && a.role !== 'baseline' ? 'response' : null;
}

/** The inspector's box scrolled to the first mark its tab draws, a third of the way down, then below 1160px the box brought into view. */
function toMark(tab: ProofTab): void {
  const box = document.querySelector<HTMLElement>('#ibody');
  if (!box) return;
  const at = tab === 'conversation' ? (box.querySelector('mark.ins-plant') ?? box.querySelector('.msg.changed')) : tab === 'request' ? box.querySelector('mark.cnry') : null;
  if (at && box.scrollHeight > box.clientHeight + 2) box.scrollTop += at.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
  inspectorInView();
}

/** What the page takes from this script once it is in. */
export const ATTEMPT_PAGE = { attemptMarks, proofTab, toMark };
export type AttemptPage = typeof ATTEMPT_PAGE;
