import { useEffect } from 'react';
import { Spin } from '../components/bits.js';
import { onShow } from '../components/OnShow.js';
import { useServerJobs } from '../fixes/tree.js';
import { chipJob, endedBehind, type JobChipView } from '../job-store.js';
import { useApp } from '../state.js';
import { retoast } from '../toast-place.js';

/** The chip of a hidden job that ended: its words load with its drawer, which is drawn, hidden, by then. */
const EndedChip = onShow(() => import('../components/Drawer.js').then((m) => m.EndedChip));

/** The chip itself. */
export function ChipButton({ view }: { view: JobChipView }) {
  const { openJob } = useApp();
  return (
    <button type="button" className={`jobchip${view.tone ? ` ${view.tone}` : ''}`} aria-label={view.name} title={view.title} onClick={() => openJob(view.opens, true)}>
      {view.running ? <Spin /> : <i />}
      <span>{view.label}</span>
    </button>
  );
}

/**
 * The status bar's chip, which leads its right-hand side: what a job off the screen is doing, or what
 * a hidden one did and how it ended, its dot in the verdict's colour. A click opens it. Below 1000px
 * it floats at the window's foot as a pill, and the bar keeps room for it (`body.jobmin`).
 */
export function JobChip() {
  const { conn, jobs } = useApp();
  const running = chipJob(useServerJobs(), jobs);
  const ended = running ? null : endedBehind(jobs);
  const shown = (!!running || !!ended) && conn !== 'expired';
  useEffect(() => {
    document.body.classList.toggle('jobmin', shown);
    retoast();
    return () => {
      document.body.classList.remove('jobmin');
      retoast();
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <>
      <span className="st-job">{running ? <ChipButton view={running} /> : <EndedChip watched={ended!} />}</span>
      <span className="sep" />
    </>
  );
}
