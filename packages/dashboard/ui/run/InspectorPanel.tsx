import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Client, RunDetail } from '../api.js';
import { focusQuiet, wantCallFocus } from '../focus-manager.js';
import { sameRun } from '../format.js';
import { useLatest } from '../hooks.js';
import { parseRoute } from '../route.js';
import type { RunOffers } from '../types.js';
import { LoadFailed } from '../components/bits.js';
import { onShow } from '../components/OnShow.js';
import { Skeleton } from '../components/States.js';
import { useServedParts } from '../served-parts.js';
import { closePanelOn, openDiff, usePanel, type Panel } from './panel-state.js';

/**
 * What a finding opens takes the inspector's place beside the calls, so the list keeps its place and
 * its first row doesn't move: a fork's or a diverged test's diff, the change at the first bad commit
 * Find breaking commit named for a crash, and an injection test's or the error-path presets' results
 * (the page's body for them, components/FindingPanel.tsx). One at a time, until it is hidden or a call
 * is picked, a link in it to one of the run's calls too, which gives the inspector back; so do the
 * inspector's keys, 1 to 4. Which is open is kept in panel-state.ts.
 */

/**
 * The diff a finding shows here, a part of its own: it loads the first time it shows (OnShow.tsx), and
 * asks for the diff's drawing, a part of its own too, as its script comes.
 */
const RequestDiff = onShow(
  () =>
    import('./RequestDiff.js').then((m) => {
      m.JsonDiffPart.preload();
      return m.RequestDiff;
    }),
  { waiting: <Skeleton what="diff" lines={6} />, failed: <LoadFailed what="diff" /> },
);

/**
 * Show diff about to be pressed (the pointer or the focus on it): its scripts and, for a run that
 * ended, its answer are asked for now, so the panel draws at once.
 */
export function warmDiff(client: Pick<Client, 'requestDiff'>, runId: string, live: boolean): void {
  RequestDiff.preload();
  if (!live) import('./RequestDiff.js').then((m) => m.askDiff(client, runId, false)).catch(() => undefined);
}

/**
 * Where the focus goes as a panel closes from inside it: the finding's toggle that opened it (Show
 * diff, Show change, or the Show results naming its key, by the panel's kind), or, where that finding
 * is folded away, the findings' button that opens them.
 */
export function panelToggle(panel: Panel | null): HTMLElement | null {
  const toggle =
    panel?.kind === 'results'
      ? ([...document.querySelectorAll<HTMLElement>('#view [data-act="results"]')].find((b) => b.getAttribute('data-which') === panel.key) ?? null)
      : document.querySelector<HTMLElement>(`#view [data-act="${panel?.kind === 'change' ? 'change' : 'diff'}"]`);
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
 * toggle, `showChange` and `onToggleChange` for the first bad commit's, `close` for every pick of a
 * call. One opened on the page below 1160px is brought into view; one the page comes back to, kept
 * open from a visit before, leaves the page where it starts.
 */
export function useFindingPanel(runId: string) {
  const panel = usePanel(runId);
  const showDiff = panel?.kind === 'diff';
  const showChange = panel?.kind === 'change';
  const close = useCallback(() => closePanelOn(runId), [runId]);
  const shown = panel ? (panel.kind === 'results' ? `results:${panel.key}` : panel.kind) : null;
  const was = useRef({ runId, shown });
  useEffect(() => {
    const before = was.current;
    was.current = { runId, shown };
    if (shown && before.runId === runId && before.shown !== shown) inspectorInView();
  }, [runId, shown]);
  return { panel, showDiff, onToggleDiff: () => (showDiff ? closePanelOn(runId) : openDiff(runId)), showChange, onToggleChange: () => (showChange ? closePanelOn(runId) : openDiff(runId, 'change')), close };
}

/** The prefix of an injection test's results' key: `injection:<result id>`, its finding's `which`. */
const INJECTION = 'injection:';

/**
 * The bodies of the results a run's findings open, by their key, for InspectorPlace's `results`: an
 * injection test's (`injection:<result id>`), where the served dashboard handed its part in
 * (served-parts.ts). None in an exported copy, which keeps no results.
 */
export function useResultsBodies(runId: string): (key: string) => ReactNode {
  const { InjectionResults } = useServedParts();
  return useCallback((key: string) => (InjectionResults && key.startsWith(INJECTION) ? <InjectionResults runId={runId} resultId={key.slice(INJECTION.length)} /> : null), [InjectionResults, runId]);
}

/**
 * The inspector (`children`), or in its place the panel a finding opened: its title and Hide over the
 * diff, the change at the first bad commit (the page's `offers`) or the results, one column at the
 * inspector's width. The page gives the results' body by their key (`results`); a panel with nothing
 * to show leaves the inspector as it is, as a run with no diff does. `onPick` is the page's pick of a
 * call, which a link in the panel to one of the run's calls makes. The diff's title names the call it
 * shows: the divergence's, or once the answer came the one it shows (after a tool a fork changed, the
 * next model call).
 */
export function InspectorPlace({ panel, run, offers = null, onClose, onPick, results, children }: { panel: Panel | null; run: RunDetail; offers?: RunOffers | null; onClose: () => void; onPick: (n: number) => void; results?: ((key: string) => ReactNode) | undefined; children: ReactNode }) {
  const runId = run.run.runId;
  const [shown, setShown] = useState<{ runId: string; at: number } | null>(null);
  const onAt = useCallback((at: number) => setShown({ runId, at }), [runId]);
  // A part the served dashboard hands in, as a copy never shows a change (served-parts.ts).
  const { ChangeBox } = useServedParts();
  const body = panel?.kind === 'results' ? (results?.(panel.key) ?? null) : null;
  if (panel && body)
    return (
      <PanelFrame title="Results" hide="Hide results" panel={panel} onClose={onClose} onPick={onPick}>
        {body}
      </PanelFrame>
    );
  const commit = offers?.commit;
  if (panel?.kind === 'change' && commit?.change?.hunk && ChangeBox)
    return (
      <PanelFrame title="The change at the first bad commit" hide="Hide change" panel={panel} onClose={onClose} onPick={onPick}>
        <ChangeBox rev={commit.rev} change={commit.change} />
      </PanelFrame>
    );
  const d = run.run.divergence;
  if (panel?.kind !== 'diff' || !d) return <>{children}</>;
  return (
    <PanelFrame title={`Diff at #${shown?.runId === runId ? shown.at : d.callNo}`} hide="Hide diff" panel={panel} onClose={onClose} onPick={onPick}>
      <RequestDiff run={run} onAt={onAt} />
    </PanelFrame>
  );
}

/**
 * The call a click in a panel picks: a plain click on a link to one of the panel's own run's calls,
 * such as a read's head in the results. Null for a link anywhere else (an attempt's run, another
 * page), which goes where it leads, and for a click that opens a link in another tab or window.
 */
function pickedCall(e: MouseEvent, runId: string): number | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const to = (e.target as Partial<Element> | null)?.closest?.('a[href]')?.getAttribute('href');
  const r = to?.startsWith('#/') ? parseRoute(to) : null;
  return r?.page === 'run' && r.call !== null && sameRun(r.id, runId) ? r.call : null;
}

/**
 * A panel's frame: its title and Hide over its body. Hide hands the focus to the toggle, as Esc does;
 * the results' Hide says it is expanded, as their toggle does. A link in the body to one of the run's
 * calls picks it as a row does: the inspector comes back on it, in the view that shows, and the call
 * takes the focus if the panel had it (`wantCallFocus`, as j and k give it).
 */
function PanelFrame({ title, hide, panel, onClose, onPick, children }: { title: string; hide: string; panel: Panel; onClose: () => void; onPick: (n: number) => void; children: ReactNode }) {
  const onHide = () => {
    const toggle = panelToggle(panel);
    onClose();
    if (toggle) focusQuiet(toggle);
  };
  const onClick = (e: MouseEvent<HTMLElement>) => {
    const n = pickedCall(e, panel.runId);
    if (n === null) return;
    e.preventDefault();
    const a = document.activeElement;
    const held = !a || a === document.body || e.currentTarget.contains(a);
    onPick(n);
    if (held) wantCallFocus(n);
  };
  return (
    <section className="insp fpanel" id="insp" aria-label={title} data-kind={panel.kind}>
      <div className="ihead fhead">
        <span className="ct">{title}</span>
        <span className="nav">
          <button className="linkbtn" type="button" aria-expanded={panel.kind === 'results' ? true : undefined} onClick={onHide}>
            {hide}
          </button>
        </span>
      </div>
      {/* No tab shows here to label it: the body is the panel's alone. */}
      <div className="ibody fbody" id="ibody" tabIndex={-1} onClick={onClick}>
        {children}
      </div>
    </section>
  );
}
