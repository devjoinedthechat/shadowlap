import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { RunDetail } from '../api.js';
import { focusQuiet } from '../focus-manager.js';
import type { TestBannerOffer } from '../types.js';
import { DiffPanel } from './parts.js';

/**
 * What a finding opens takes the inspector's place beside the calls, so the list keeps its place and
 * its first row doesn't move: a fork's or a diverged test's diff, an injection test's results and a
 * bisect's change later in the same place. One at a time, until it is hidden or a call is picked,
 * which gives the inspector back; so do the inspector's keys, 1 to 4.
 */

export type PanelKind = 'diff';

/**
 * Where the focus goes as a panel closes from inside it: the finding's toggle that opened it, or,
 * where that finding is folded away, the findings' button that opens them.
 */
export function panelToggle(): HTMLElement | null {
  const toggle = document.querySelector<HTMLElement>('#view [data-act="diff"]');
  if (toggle?.getClientRects().length) return toggle;
  return document.querySelector<HTMLElement>('#view .findings .fmore') ?? toggle;
}

/**
 * Below 1160px the inspector sits under the calls: a row picked, or a panel opened, brings its place
 * into view under the strip, unless its top shows already. Not on j and k, which keep the list's scroll.
 */
export function inspectorInView(): void {
  if (typeof innerWidth !== 'number' || innerWidth > 1159) return;
  const box = document.querySelector<HTMLElement>('#insp');
  if (box && box.getBoundingClientRect().top > innerHeight * 0.6) box.scrollIntoView({ block: 'start' });
}

/**
 * A row's click: picks its call and brings the inspector into view, then again once the call has drawn
 * there and once its details have come. They change the inspector's height, and with it how far the
 * page scrolls: brought into view before them, a short call's inspector stopped short of where it goes.
 * Only for the call clicked, until its details come or another call is picked once it has drawn.
 */
export function usePickInView(select: (n: number) => void, selected: number | null, detail: { data: { call: { callNo: number } } | null; error: Error | null }): (n: number) => void {
  const want = useRef<{ n: number; seen: boolean } | null>(null);
  const settled = detail.data?.call.callNo === selected || !!detail.error;
  useLayoutEffect(() => {
    const w = want.current;
    if (!w) return;
    if (w.n !== selected) {
      if (w.seen) want.current = null;
      return;
    }
    w.seen = true;
    inspectorInView();
    if (settled) want.current = null;
  }, [selected, settled]);
  return useCallback(
    (n: number) => {
      select(n);
      inspectorInView();
      want.current = n === selected && settled ? null : { n, seen: false };
    },
    [select, selected, settled],
  );
}

/**
 * The panel open on a run's page, for that run alone: `showDiff` and `onToggleDiff` for the finding's
 * toggle and the keys, `close` for every pick of a call.
 */
export function useFindingPanel(runId: string) {
  const [open, setOpen] = useState<{ runId: string; kind: PanelKind } | null>(null);
  const kind = open?.runId === runId ? open.kind : null;
  const setShowDiff = useCallback((on: boolean) => setOpen(on ? { runId, kind: 'diff' } : null), [runId]);
  const close = useCallback(() => setOpen(null), []);
  useEffect(() => {
    if (kind) inspectorInView();
  }, [kind]);
  return { kind, showDiff: kind === 'diff', setShowDiff, onToggleDiff: () => setShowDiff(kind !== 'diff'), close };
}

/**
 * The inspector (`children`), or in its place the panel a finding opened: its title and Hide over the
 * diff, one column at the inspector's width. Hide hands the focus to the toggle, as Esc does.
 */
export function InspectorPlace({ kind, run, test, onClose, children }: { kind: PanelKind | null; run: RunDetail; test: TestBannerOffer | null; onClose: () => void; children: ReactNode }) {
  const d = run.run.divergence;
  if (kind !== 'diff' || !d) return <>{children}</>;
  const title = `Diff at #${d.callNo}`;
  const hide = () => {
    const toggle = panelToggle();
    onClose();
    if (toggle) focusQuiet(toggle);
  };
  return (
    <section className="insp fpanel" id="insp" aria-label={title}>
      <div className="ihead fhead">
        <span className="ct">{title}</span>
        <span className="nav">
          <button className="linkbtn" type="button" onClick={hide}>
            Hide diff
          </button>
        </span>
      </div>
      {/* No tab shows here to label it: the body is the panel's alone. */}
      <div className="ibody fbody" id="ibody" tabIndex={-1}>
        <DiffPanel run={run} test={test} />
      </div>
    </section>
  );
}
