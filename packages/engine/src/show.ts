import { untrustedReads, type ToolTrust, type TrustSource } from './injection.js';
import { storedModelResolver, summarizeRun, type SummaryOptions } from './report.js';
import type { StoreOf } from './store.js';
import type { CallRecord, RunRecord, RunSummary } from './types.js';
import { unrecordedTools, type UnrecordedTool } from './unrecorded-tools.js';

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
  /**
   * The tools the model called that the run recorded no call of (unrecordedTools): they ran in the
   * agent unseen, and a replay runs them again for real. Each with how often and from which model
   * call the model asked for it, and its effect as far as known.
   */
  unrecordedTools: UnrecordedTool[];
}

/**
 * `tools`: the project's `tools` from its config, which mark a tool the other way over what its
 * calls were recorded with; `unrecorded`: its `tools.unrecorded`, the effects it declares for tools
 * Shadowlap doesn't record.
 */
export function showJson(store: StoreOf<'recording'>, run: RunRecord, options: SummaryOptions & { calls?: CallRecord[]; tools?: ToolTrust; unrecorded?: Readonly<Record<string, 'read' | 'write'>> } = {}): ShowJson {
  const calls = options.calls ?? store.getCalls(run.runId);
  const summary = summarizeRun(run, calls, [], [], { ...(options.prices ? { prices: options.prices } : {}), modelOf: options.modelOf ?? storedModelResolver(store) });
  const untrusted = untrustedReads(calls, options.tools).reads.map((r) => ({ callNo: r.callNo, name: r.name, from: r.from }));
  return { run, summary, calls, untrusted, unrecordedTools: unrecordedTools(store, run.runId, options.unrecorded ? { declared: options.unrecorded } : {}) };
}
