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

/** What Find breaking commit says where the days' only failures fail by their family's checks. */
export const FAMILY_ONLY_FAILURES = 'the runs that failed on the days picked failed only their family’s checks: Find breaking commit needs a run that failed on its own';

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
    const filter: RunFilter = { ...job.options, types, known: true, judge: judgeFor(store, job.outcome ?? null) };
    // A run's own failures: bisect can't yet tell where one that fails only its family's checks started.
    const failures = matchingRuns(store, { ...filter, ownFailures: true })
      .reverse()
      .slice(0, LATER_FAILURES)
      .map((r): DayFailure => ({ runId: r.runId, label: r.label, command: r.source ?? r.argv.join(' '), startedAt: r.startedAt }));
    // With none of its own, whether the days' failures are such runs, so the dialog says why it can't start.
    const familyOnly = !failures.length && matchingRuns(store, filter).length > 0;
    return answer({ failures, ...(familyOnly ? { familyOnly } : {}) });
  },
};
