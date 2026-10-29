import { recordNotRecorded, unrecordedProjectTools, type StoreOf } from '@shadowlap/engine';
import { inspectProject } from './init.js';

/**
 * After a recording: the tools `shadowlap init` finds in the project with no declared effect, and
 * that the run never recorded, are kept on the run. Their calls ran in the agent unseen and run
 * again on every replay, which the run's page says. It never fails the run.
 */
export function noteUnrecordedTools(store: StoreOf<'recording'>, runId: string, cwd: string): void {
  try {
    const calls = store.getCalls(runId);
    // A run that reached no model is no agent run to speak of.
    if (!calls.some((c) => c.kind === 'api')) return;
    const tools = unrecordedProjectTools(inspectProject(cwd).tools, calls);
    if (tools.length) recordNotRecorded(store, runId, { tools });
  } catch {
    // an unreadable project leaves the run as it was
  }
}
