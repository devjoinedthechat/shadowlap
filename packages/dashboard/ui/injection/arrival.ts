import { useEffect, useRef, useState } from 'react';
import type { CallDetail, RunInjection } from '../types.js';
import { inspectorInView } from '../run/InspectorPanel.js';
import type { ProofTab } from './Proof.js';

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

interface Arrival {
  runId: string;
  attempt: RunInjection['attempt'];
  /** The call in the address. */
  call: number | null;
  /** The call details the inspector draws. */
  detail: CallDetail | null;
  select: (n: number) => void;
  setTab: (t: ProofTab) => void;
}

/**
 * An attempt's page opened on a call its proof names, by a link, a reload or a new tab, opens on the
 * tab that shows it, once the attempt's read has come and once a run; the proof's picks do the same.
 * Once that call has drawn, its first mark scrolls into view (injection/marks.tsx marks it). Returns
 * the proof's pick.
 */
export function useInjectionArrival({ runId, attempt, call, detail, select, setTab }: Arrival): (n: number, tab: ProofTab) => void {
  const at = useRef<{ run: string; done: boolean; jump: { n: number; tab: ProofTab } | null }>({ run: '', done: false, jump: null });
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const s = at.current;
    if (s.run !== runId) Object.assign(s, { run: runId, done: false, jump: null });
    if (s.done || !attempt) return;
    s.done = true;
    const tab = call === null ? null : proofTab(attempt, call);
    if (tab === null || call === null) return;
    s.jump = { n: call, tab };
    setTab(tab);
    setAsked((k) => k + 1);
  }, [runId, attempt, call, setTab]);
  const shown = detail?.call.callNo ?? null;
  useEffect(() => {
    const s = at.current;
    if (!s.jump || s.jump.n !== shown) return;
    const { tab } = s.jump;
    s.jump = null;
    toMark(tab);
  }, [shown, asked]);
  return (n, tab) => {
    at.current.jump = { n, tab };
    select(n);
    setTab(tab);
    setAsked((k) => k + 1);
  };
}
