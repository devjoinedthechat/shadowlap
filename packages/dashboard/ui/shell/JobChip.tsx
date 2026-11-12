import { useEffect, useReducer } from 'react';
import { Spin } from '../components/bits.js';
import { useServerJobs } from '../fixes/tree.js';
import { chipJob, endedBehind, type JobChipView } from '../job-store.js';
import { useServedParts, type JobWords } from '../served-parts.js';
import { useApp } from '../state.js';
import { retoast } from '../toast-place.js';

/**
 * How a hidden job that ended is said on its chip: the words of its kind, which come with its drawer,
 * drawn hidden by then, and are asked for as soon as a chip shows, from the served entry (a copy runs
 * no job). The chip stays the one button as its job ends, so the focus stays on it.
 */
let endedChip: JobWords['endChip'] | null = null;
const loadEnded = (words: () => Promise<JobWords>): Promise<void> =>
  words().then((m) => {
    endedChip = m.endChip;
  });

/** The chip itself. */
export function ChipButton({ view }: { view: JobChipView }) {
  const { openJob } = useApp();
  // A job only another tab follows needs the server to open: `openJob` says why while it waits.
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
  const words = useServedParts().jobs;
  const running = chipJob(useServerJobs(), jobs);
  const ended = running ? null : endedBehind(jobs);
  const shown = (!!running || !!ended) && conn !== 'expired';
  const [, loaded] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (shown && !endedChip && words) void loadEnded(words).then(loaded, () => undefined);
  }, [shown, words]);
  const view = running ?? (ended && endedChip ? endedChip(ended) : null);
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
      <span className="st-job">{view ? <ChipButton view={view} /> : null}</span>
      <span className="sep" />
    </>
  );
}
