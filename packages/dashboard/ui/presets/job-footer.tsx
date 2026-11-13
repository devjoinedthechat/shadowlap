import { useEffect, useRef } from 'react';
import { isObject } from '../../../engine/src/is-object.js';
import { JOB_KINDS, type JobView } from '../api.js';
import { addJobFooter, type JobFooter } from '../job-actions.js';
import { currentRoute } from '../router.js';
import { openResults, panelOn } from '../run/panel-state.js';

/*
 * What Run error-path presets…' drawer does at its end, besides the CLI's links (Open proof, the
 * engine's presetProof, leads where a preset failed): it opens the presets' results on their run's
 * page, as the mock's drawer does behind its way on. Nothing to press: a footer holds only what
 * starts a job. Registered by the dialog that starts the job (PresetsDialog.tsx), a part a copy
 * never draws: a copy runs nothing.
 */

/** The recording whose presets' results the job's end opens: its one recording, where a preset made an attempt to show. */
export function presetsToOpen(result: unknown): string | null {
  const reports = isObject(result) && Array.isArray(result.results) ? result.results : [];
  const ran = reports.filter((r): r is Record<string, unknown> & { runId: string } => isObject(r) && typeof r.runId === 'string');
  const one = ran.length === 1 ? ran[0]! : null;
  const outcomes = one && Array.isArray(one.outcomes) ? one.outcomes : [];
  return outcomes.some((o) => isObject(o) && Number(o.attempts) > 0) ? one!.runId : null;
}

/**
 * Opens the presets' results as a job that ends while its drawer is open over their run's page: once,
 * as it ends, never for one that had ended before, nor over another finding's panel open there.
 */
function useResultsAtEnd(job: JobView): void {
  const running = useRef(!job.done);
  useEffect(() => {
    if (!job.done || !running.current) return;
    running.current = false;
    const runId = job.code === 0 || job.code === 1 || job.code === 3 ? presetsToOpen(job.result) : null;
    const r = currentRoute();
    if (runId && r.page === 'run' && r.id === runId && !panelOn(runId)) openResults(runId, 'presets');
  }, [job.done, job.code, job.result]);
}

const PresetsFooter: JobFooter = ({ job }) => {
  useResultsAtEnd(job);
  return null;
};

addJobFooter(JOB_KINDS.chaos, PresetsFooter);
