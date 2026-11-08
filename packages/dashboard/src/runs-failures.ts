import { answer, type ReadTable } from './read-registry.js';
import { judgeFor, type OutcomeWork } from './run-outcome.js';
import { matchingRuns, type RunFilter } from './runs-list.js';

/**
 * The failures Find breaking commit looks through, for the days picked (routes/runs-list.ts
 * `/runs/bisect`): what the Runs filter matches with Failed, worked out beside the server, since
 * the filter's words read what runs recorded through the search index and `status:` judges runs,
 * neither of which the server's thread may wait on. Matched by what is known, as the table is.
 */

/** Failures on the days picked that Find breaking commit looks through for one that started after the first commit. */
export const LATER_FAILURES = 50;

/** A failure as the dialog offers it: the run it starts from. */
export interface DayFailure {
  runId: string;
  label: string;
  command: string;
  startedAt: number;
}

export type RunsFailuresJob = { kind: 'runs-failures'; options: Pick<RunFilter, 'from' | 'to' | 'types' | 'q'>; outcome?: OutcomeWork | null };

export const RUNS_FAILURES_READS: ReadTable<RunsFailuresJob> = {
  // Oldest first, the first failure on the days picked first, LATER_FAILURES at most.
  'runs-failures': (store, job) => {
    const types = [...new Set([...(job.options.types ?? []), 'failed' as const])];
    // A run's own failures: bisect can't yet tell where one that fails only its family's checks started.
    const failures = matchingRuns(store, { ...job.options, types, known: true, ownFailures: true, judge: judgeFor(store, job.outcome ?? null) })
      .reverse()
      .slice(0, LATER_FAILURES)
      .map((r): DayFailure => ({ runId: r.runId, label: r.label, command: r.source ?? r.argv.join(' '), startedAt: r.startedAt }));
    return answer({ failures });
  },
};
