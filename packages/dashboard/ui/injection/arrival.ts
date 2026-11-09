import { useEffect, useRef, useState } from 'react';
import type { CallDetail, RunInjection } from '../types.js';
import { useAttemptPage } from './attempt-load.js';
import type { ProofTab } from './Proof.js';

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
 * Once that call has drawn, its first mark scrolls into view (AttemptPage.tsx marks it, and says
 * which tab shows a call and where its mark is, once its script is in). Returns the proof's pick.
 */
export function useInjectionArrival({ runId, attempt, call, detail, select, setTab }: Arrival): (n: number, tab: ProofTab) => void {
  const at = useRef<{ run: string; done: boolean; jump: { n: number; tab: ProofTab } | null }>({ run: '', done: false, jump: null });
  const [asked, setAsked] = useState(0);
  const page = useAttemptPage(attempt);
  useEffect(() => {
    const s = at.current;
    if (s.run !== runId) Object.assign(s, { run: runId, done: false, jump: null });
    if (s.done || !attempt || !page) return;
    s.done = true;
    const tab = call === null ? null : page.proofTab(attempt, call);
    if (tab === null || call === null) return;
    s.jump = { n: call, tab };
    setTab(tab);
    setAsked((k) => k + 1);
  }, [runId, attempt, call, setTab, page]);
  const shown = detail?.call.callNo ?? null;
  useEffect(() => {
    const s = at.current;
    if (!s.jump || s.jump.n !== shown || !page) return;
    const { tab } = s.jump;
    s.jump = null;
    page.toMark(tab);
  }, [shown, asked, page]);
  return (n, tab) => {
    at.current.jump = { n, tab };
    select(n);
    setTab(tab);
    setAsked((k) => k + 1);
  };
}
