import { storedModelResolver, summarizeRun, type SummaryOptions } from './report.js';
import type { Store } from './store.js';
import type { CallRecord, RunRecord, RunSummary } from './types.js';

/**
 * `shadowlap show <run> --json`: the run, its summary and every call as stored. Coding agents and
 * scripts read this shape, so it is built in one place: the CLI prints it, and the dashboard
 * serves it without starting the CLI.
 */
export interface ShowJson {
  run: RunRecord;
  summary: RunSummary;
  calls: CallRecord[];
}

export function showJson(store: Store, run: RunRecord, options: SummaryOptions & { calls?: CallRecord[] } = {}): ShowJson {
  const calls = options.calls ?? store.getCalls(run.runId);
  const summary = summarizeRun(run, calls, [], [], { ...(options.prices ? { prices: options.prices } : {}), modelOf: options.modelOf ?? storedModelResolver(store) });
  return { run, summary, calls };
}
