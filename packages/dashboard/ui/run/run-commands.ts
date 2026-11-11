import { useEffect } from 'react';
import { JOB_KINDS, type RunDetail, type RunOffers } from '../api.js';
import { useJobWait } from '../fixes/tree.js';
import { shortId } from '../format.js';
import { useLatest } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { href, type View } from '../route.js';
import { navigate } from '../router.js';
import { MARKS, type RunMark } from '../runkey.js';
import { keyColumn } from '../shortcuts.js';
import { useApp, type PaletteCommand } from '../state.js';
import { nextStepOf, replayAction, stepEntry } from './next-step.js';
import { plainPackFolder, useStepWait } from './NextStepButton.js';
import { PACK_VERB, packRunCommand } from './share-steps.js';
import { bisectLabel } from './offers.js';

/** Presses the header's lime button, or another by its selector, or says why not, where a job started since the palette opened. */
function pressStep(toast: (text: string) => void, selector = '.rhead [data-next]'): void {
  setTimeout(() => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (button?.disabled) toast(button.title);
    else button?.click();
  });
}

/** The next step, and Replay where it isn't that: a link goes where it goes, and any other step presses the header's lime button, or waits as it does (`wait`). */
function leadCommands(run: RunDetail, o: { exported: boolean; actionsOff: string | null; wait: string | null; toast: (text: string) => void; run: (p: { action: RunDetail['actions'][number]; callNo: null; runId?: string }) => void }): PaletteCommand[] {
  const items: PaletteCommand[] = [];
  const next = nextStepOf(run);
  const runId = run.run.runId;
  if (next && !next.off && (next.href || !o.actionsOff)) items.push({ ...stepEntry(next, o.wait), run: () => (next.href ? navigate(next.href) : pressStep(o.toast)) });
  const replay = run.actions.find((a) => a.key === 'r');
  const again = run.replay?.key === 'replay' ? run.replay : null;
  if (!o.exported && !o.actionsOff && replay && run.run.status !== 'running' && next?.key !== 'replay') items.push({ group: 'This run', label: ACTIONS.replay.label, hint: again?.command ?? `shadowlap replay ${shortId(runId)}`, key: keyColumn('replay'), job: true, run: () => o.run({ action: replayAction(again) ?? replay, callNo: null, ...(again && again.runId !== runId ? { runId: again.runId } : {}) }) });
  return items;
}

/**
 * This run, in the palette, while its page is open: its next step first, as the header's lime button
 * has it, then what else the page offers, none of them said twice.
 */
export function useRunCommands(o: {
  run: RunDetail;
  selected: number | null;
  canFork: boolean;
  canMark: boolean;
  labels: readonly string[];
  mark: (m: RunMark) => void;
  offers: RunOffers | null;
  /** Its verdict by today's checks, the first fact's (useJudgedAt): undefined while they judge it. */
  judged: RunDetail['judged'];
  actions: { run: (p: { action: RunDetail['actions'][number]; callNo: number | null; runId?: string }) => void; findCommit: () => void };
  forkMenu: { openAt: (el: HTMLElement) => void };
  setView: (v: View) => void;
  /** Add check at #n…, where the selected call takes it: the check menu at its row's button, else at the inspector's link. */
  addCheck?: (() => void) | undefined;
}): void {
  const app = useApp();
  const { exported, actionsOff, setRunCommands, hasKind, toast } = app;
  const { run, selected, canFork, canMark, labels, offers, judged } = o;
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  const next = nextStepOf(run);
  const wait = useStepWait(run, next);
  const packFolder = exported || actionsOff ? null : plainPackFolder(run, offers, next, judged);
  // Read only where the row shows: the jobs' feed is a read of its own.
  const packWait = useJobWait(packFolder ? { verb: PACK_VERB, tests: true } : null);
  const now = useLatest(o);
  useEffect(() => {
    const items = leadCommands(run, { exported, actionsOff, wait, toast, run: (p) => now.current.actions.run(p) });
    if (o.addCheck && selected !== null) items.push({ group: 'This run', label: `Add check at #${selected}…`, hint: 'never, must, only after, at most, when, a judge', job: true, run: () => now.current.addCheck?.() });
    if (canFork && selected !== null)
      items.push({
        group: 'This run',
        label: `Fork at #${selected}…`,
        hint: 'inject, override, fail, switch model',
        key: keyColumn('fork'),
        job: true,
        run: () => {
          const btn = document.getElementById('forkBtn');
          if (btn) setTimeout(() => now.current.forkMenu.openAt(btn));
        },
      });
    // Pack as golden… where another step leads: the header's plain button, pressed as the lead is.
    if (packFolder) items.push({ group: 'This run', label: ACTIONS.packAsGolden.label, hint: packRunCommand(runId, packFolder), match: 'golden keep test', job: true, ...(packWait ? { wait: packWait } : {}), run: () => pressStep(toast, '.rhead [data-fold="pack"]') });
    if (!exported)
      items.push({
        group: 'This run',
        label: 'Share…',
        hint: 'HTML, pack, dataset, OpenTelemetry, HAR',
        job: true,
        run: () => {
          const btn = document.querySelector<HTMLElement>('.rhead .actions [aria-haspopup="menu"]');
          if (btn) setTimeout(() => btn.click());
        },
      });
    if (!exported && !actionsOff && !live && !run.source && hasKind(JOB_KINDS.bisect) && next?.key !== 'bisect') items.push({ group: 'This run', label: bisectLabel(offers?.bisect).label, hint: 'shadowlap bisect', match: 'bisect', job: true, run: () => now.current.actions.findCommit() });
    // The good/bad key: what repair keeps working, and what it fixes.
    if (canMark)
      for (const m of MARKS) {
        const on = labels.includes(m);
        items.push({ group: 'This run', label: on ? `Take off ${m}` : `Label it ${m}`, hint: m === 'good' ? 'repair --keeps label:good' : 'repair --fixes label:bad', key: keyColumn(m === 'good' ? 'markGood' : 'markBad'), run: () => now.current.mark(m) });
      }
    items.push({ group: 'This run', label: 'Provenance', hint: 'the run’s record, call by call', run: () => now.current.setView('provenance') });
    if (run.parent && next?.key !== 'compare') items.push({ group: 'This run', label: ACTIONS.compareWithParent.label, hint: `shadowlap diff ${shortId(run.parent.runId)} ${shortId(runId)}`, short: `against ${shortId(run.parent.runId)}`, key: keyColumn('compare'), run: () => navigate(href.compare(run.parent!.runId, runId)) });
    setRunCommands(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the commands change with what they show; the functions they call are read when they run, and taking them in would register the commands again on every render
  }, [runId, selected, live, exported, actionsOff, canFork, !!o.addCheck, run.parent?.runId, offers?.bisect?.failed, canMark, labels.join('\n'), next?.key, next?.label, next?.href, next?.command, run.replay?.label, wait, packFolder, packWait]);
  useEffect(() => () => setRunCommands([]), [setRunCommands]);
}
