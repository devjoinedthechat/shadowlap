import { useEffect } from 'react';
import { Spin } from '../components/bits.js';
import { useServerJobs } from '../fixes/tree.js';
import { chipJob } from '../job-store.js';
import { useApp } from '../state.js';
import { retoast } from '../toast-place.js';

/**
 * The status bar's chip, which leads its right-hand side: what a job off the screen is doing, or what
 * a hidden one did and how it ended, its dot in the verdict's colour. A click opens it. Below 1000px
 * it floats at the window's foot as a pill, and the bar keeps room for it (`body.jobmin`).
 */
export function JobChip() {
  const { conn, jobs, openJob } = useApp();
  const chip = chipJob(useServerJobs(), jobs);
  const shown = !!chip && conn !== 'expired';
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
      <span className="st-job">
        <button type="button" className={`jobchip${chip.tone ? ` ${chip.tone}` : ''}`} aria-label={chip.name} title={chip.title} onClick={() => openJob(chip.opens, true)}>
          {chip.running ? <Spin /> : <i />}
          {chip.label}
        </button>
      </span>
      <span className="sep" />
    </>
  );
}
