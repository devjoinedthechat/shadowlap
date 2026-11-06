import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { RunDetail } from '../api.js';
import { focusQuiet } from '../focus-manager.js';
import { useLatest } from '../hooks.js';
import type { TestBannerOffer } from '../types.js';
import { LoadFailed } from '../components/bits.js';
import { onShow } from '../components/OnShow.js';
import { closePanelOn, openDiff, usePanel, type Panel } from './panel-state.js';

/**
 * What a finding opens takes the inspector's place beside the calls, so the list keeps its place and
 * its first row doesn't move: a fork's or a diverged test's diff, an injection test's or the error-path
 * presets' results (the page's body for them, components/FindingPanel.tsx), and a bisect's change later
 * in the same place. One at a time, until it is hidden or a call is picked, which gives the inspector
 * back; so do the inspector's keys, 1 to 4. Which is open is kept in panel-state.ts.
 */

/** The diff a finding shows here, a part of its own: it loads the first time it shows (OnShow.tsx). */
const DiffPanel = onShow(() => import('./DiffPanel.js').then((m) => m.DiffPanel), { failed: <LoadFailed what="diff" /> });

/**
 * Where the focus goes as a panel closes from inside it: the finding's toggle that opened it, or,
 * where that finding is folded away, the findings' button that opens them.
 */
export function panelToggle(panel: Panel | null): HTMLElement | null {
  const toggle =
    panel?.kind === 'results'
      ? ([...document.querySelectorAll<HTMLElement>('#view [data-act="results"]')].find((b) => b.getAttribute('data-which') === panel.key) ?? null)
      : document.querySelector<HTMLElement>('#view [data-act="diff"]');
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
 * The panel open on a run's page, for that run alone: `showDiff` and `onToggleDiff` for the diff's
 * toggle, `close` for every pick of a call. Opening one below 1160px brings it into view.
 */
export function useFindingPanel(runId: string) {
  const panel = usePanel(runId);
  const showDiff = panel?.kind === 'diff';
  const close = useCallback(() => closePanelOn(runId), [runId]);
  const shown = panel ? (panel.kind === 'results' ? `results:${panel.key}` : 'diff') : null;
  useEffect(() => {
    if (shown) inspectorInView();
  }, [shown]);
  return { panel, showDiff, onToggleDiff: () => (showDiff ? closePanelOn(runId) : openDiff(runId)), close };
}

/**
 * The inspector (`children`), or in its place the panel a finding opened: its title and Hide over the
 * diff or the results, one column at the inspector's width. The page gives the results' body by their
 * key (`results`); results it has no body for leave the inspector as it is, as a run with no diff does.
 */
export function InspectorPlace({ panel, run, test, onClose, results, children }: { panel: Panel | null; run: RunDetail; test: TestBannerOffer | null; onClose: () => void; results?: ((key: string) => ReactNode) | undefined; children: ReactNode }) {
  const body = panel?.kind === 'results' ? (results?.(panel.key) ?? null) : null;
  if (body)
    return (
      <PanelFrame title="Results" hide="Hide results" panel={panel} onClose={onClose}>
        {body}
      </PanelFrame>
    );
  const d = run.run.divergence;
  if (panel?.kind !== 'diff' || !d) return <>{children}</>;
  return (
    <PanelFrame title={`Diff at #${d.callNo}`} hide="Hide diff" panel={panel} onClose={onClose}>
      <DiffPanel run={run} test={test} />
    </PanelFrame>
  );
}

/** A panel's frame: its title and Hide over its body. Hide hands the focus to the toggle, as Esc does. */
function PanelFrame({ title, hide, panel, onClose, children }: { title: string; hide: string; panel: Panel | null; onClose: () => void; children: ReactNode }) {
  const onHide = () => {
    const toggle = panelToggle(panel);
    onClose();
    if (toggle) focusQuiet(toggle);
  };
  return (
    <section className="insp fpanel" id="insp" aria-label={title}>
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
