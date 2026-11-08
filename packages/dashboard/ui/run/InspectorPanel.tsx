import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { RunDetail } from '../api.js';
import { focusQuiet } from '../focus-manager.js';
import { useLatest } from '../hooks.js';
import type { RunOffers, TestBannerOffer } from '../types.js';
import { LoadFailed } from '../components/bits.js';
import { onShow } from '../components/OnShow.js';
import { useServedParts } from '../served-parts.js';

/**
 * What a finding opens takes the inspector's place beside the calls, so the list keeps its place and
 * its first row doesn't move: a fork's or a diverged test's diff, the change at the first bad commit
 * Find breaking commit named for a crash, and an injection test's results later in the same place.
 * One at a time, until it is hidden or a call is picked,
 * which gives the inspector back; so do the inspector's keys, 1 to 4.
 */

export type PanelKind = 'diff' | 'change';

/** The diff a finding shows here, a part of its own: it loads the first time it shows (OnShow.tsx). */
const DiffPanel = onShow(() => import('./DiffPanel.js').then((m) => m.DiffPanel), { failed: <LoadFailed what="diff" /> });

/**
 * Where the focus goes as a panel closes from inside it: the finding's toggle that opened it (Show
 * diff or Show change, by the panel's kind), or, where that finding is folded away, the findings'
 * button that opens them.
 */
export function panelToggle(): HTMLElement | null {
  const kind = document.querySelector('#insp.fpanel')?.getAttribute('data-kind') === 'change' ? 'change' : 'diff';
  const toggle = document.querySelector<HTMLElement>(`#view [data-act="${kind}"]`);
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
 * The function keeps one identity whatever is selected, reading the selection as a row is clicked, so
 * a row draws again only when its own selection changes (CallsView.tsx's rows are memo'd).
 */
export function usePickInView(select: (n: number) => void, selected: number | null, detail: { data: { call: { callNo: number } } | null; error: Error | null }): (n: number) => void {
  const want = useRef<{ n: number; seen: boolean } | null>(null);
  const settled = detail.data?.call.callNo === selected || !!detail.error;
  const now = useLatest({ selected, settled });
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
      const was = now.current;
      select(n);
      inspectorInView();
      want.current = n === was.selected && was.settled ? null : { n, seen: false };
    },
    [select, now],
  );
}

/**
 * The panel open on a run's page, for that run alone: `showDiff` and `onToggleDiff` for the finding's
 * toggle and the keys, `showChange` and `onToggleChange` for the first bad commit's, `close` for every
 * pick of a call.
 */
export function useFindingPanel(runId: string) {
  const [open, setOpen] = useState<{ runId: string; kind: PanelKind } | null>(null);
  const kind = open?.runId === runId ? open.kind : null;
  const setShowDiff = useCallback((on: boolean) => setOpen(on ? { runId, kind: 'diff' } : null), [runId]);
  const close = useCallback(() => setOpen(null), []);
  useEffect(() => {
    if (kind) inspectorInView();
  }, [kind]);
  return { kind, showDiff: kind === 'diff', setShowDiff, onToggleDiff: () => setShowDiff(kind !== 'diff'), showChange: kind === 'change', onToggleChange: () => setOpen(kind === 'change' ? null : { runId, kind: 'change' }), close };
}

/**
 * The inspector (`children`), or in its place the panel a finding opened: its title and Hide over the
 * diff, or over the change at the first bad commit (the page's `offers`), one column at the
 * inspector's width. A panel with nothing to show leaves the inspector as it is.
 */
export function InspectorPlace({ kind, run, test, offers = null, onClose, children }: { kind: PanelKind | null; run: RunDetail; test: TestBannerOffer | null; offers?: RunOffers | null; onClose: () => void; children: ReactNode }) {
  const d = run.run.divergence;
  const commit = offers?.commit;
  // A part the served dashboard hands in, as a copy never shows a change (served-parts.ts).
  const { ChangeBox } = useServedParts();
  if (kind === 'change' && commit?.change?.hunk && ChangeBox)
    return (
      <PanelFrame title="The change at the first bad commit" hide="Hide change" kind={kind} onClose={onClose}>
        <ChangeBox rev={commit.rev} change={commit.change} />
      </PanelFrame>
    );
  if (kind !== 'diff' || !d) return <>{children}</>;
  return (
    <PanelFrame title={`Diff at #${d.callNo}`} hide="Hide diff" kind={kind} onClose={onClose}>
      <DiffPanel run={run} test={test} />
    </PanelFrame>
  );
}

/** A panel's frame: its title and Hide over its body. Hide hands the focus to the toggle, as Esc does. */
function PanelFrame({ title, hide, kind, onClose, children }: { title: string; hide: string; kind: PanelKind; onClose: () => void; children: ReactNode }) {
  const onHide = () => {
    const toggle = panelToggle();
    onClose();
    if (toggle) focusQuiet(toggle);
  };
  return (
    <section className="insp fpanel" id="insp" aria-label={title} data-kind={kind}>
      <div className="ihead fhead">
        <span className="ct">{title}</span>
        <span className="nav">
          <button className="linkbtn" type="button" onClick={onHide}>
            {hide}
          </button>
        </span>
      </div>
      {/* No tab shows here to label it: the body is the panel's alone. */}
      <div className="ibody fbody" id="ibody" tabIndex={-1}>
        {children}
      </div>
    </section>
  );
}
