import { untrustedReads, type ToolTrust, type TrustSource } from './injection.js';
import { storedModelResolver, summarizeRun, type SummaryOptions } from './report.js';
import type { Store } from './store.js';
import type { CallRecord, RunRecord, RunSummary } from './types.js';

/**
 * `shadowlap show <run> --json`: the run, its summary and every call as stored, and its untrusted
 * reads (callNo, name, from). Coding agents and scripts read this shape, so it is built in one
 * place: the CLI prints it, and the dashboard serves it without starting the CLI.
 */
export interface ShowJson {
  run: RunRecord;
  summary: RunSummary;
  calls: CallRecord[];
  /**
   * The run's untrusted reads, in call order, as the dashboard's injection read model lists them:
   * the reads of tools marked untrusted (the config's `tools`, an SDK's `trust`, an MCP server's
   * `openWorldHint`), where `shadowlap injection` plants. Each names where its mark came from.
   */
  untrusted: Array<{ callNo: number; name: string; from: TrustSource }>;
}

/** `tools`: the project's `tools` from its config, which mark a tool the other way over what its calls were recorded with. */
export function showJson(store: Store, run: RunRecord, options: SummaryOptions & { calls?: CallRecord[]; tools?: ToolTrust } = {}): ShowJson {
  const calls = options.calls ?? store.getCalls(run.runId);
  const summary = summarizeRun(run, calls, [], [], { ...(options.prices ? { prices: options.prices } : {}), modelOf: options.modelOf ?? storedModelResolver(store) });
  const untrusted = untrustedReads(calls, options.tools).reads.map((r) => ({ callNo: r.callNo, name: r.name, from: r.from }));
  return { run, summary, calls, untrusted };
}
