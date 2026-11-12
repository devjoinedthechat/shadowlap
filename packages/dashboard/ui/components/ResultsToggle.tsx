import { closePanelOn, openResults, usePanel } from '../run/panel-state.js';

/**
 * A finding's Show results, Hide results once they are open: they take the inspector's place on the
 * run's page (`which` names them there: `injection:<result id>`, `presets`), and the focus stays on it.
 * `preload` loads what draws them as the pointer or the focus reaches it, so they show at once. The
 * page hands it in from the part that draws them (FindingPanel.tsx's matrix, an injection test's
 * results, served-parts.ts), so this module holds none of their code: a page that draws a finding
 * brings no matrix into its own script, nor into an exported copy's.
 */
export function ResultsToggle({ runId, which, preload }: { runId: string; which: string; preload?: (() => void) | undefined }) {
  const panel = usePanel(runId);
  const open = panel?.kind === 'results' && panel.key === which;
  return (
    <button className="linkbtn" type="button" data-act="results" data-which={which} aria-expanded={open} aria-controls="insp" onPointerEnter={preload} onFocus={preload} onClick={() => (open ? closePanelOn(runId) : openResults(runId, which))}>
      {open ? 'Hide results' : 'Show results'}
    </button>
  );
}
