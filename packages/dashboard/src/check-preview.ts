import {
  agentOfRun,
  asNumber,
  checkRecording,
  checkRecordings,
  intoText,
  isJudgeCall,
  isObject,
  isUserInput,
  labelNoteWords,
  labelNotes,
  messageOf,
  notApplicable,
  packRecording,
  parseExpect,
  storedCalls,
  type CallRecord,
  type CheckedRecording,
  type CheckReport,
  type Price,
  type RecordingToCheck,
  type Store,
  type TestSpec,
} from '@shadowlap/engine';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';

/**
 * The check builder's pooled reads (routes/checks.ts asks them): what a run's calls offer a check
 * made from one of them, and a draft check judged on the agent's recordings as it is written, by
 * the engine's evaluator, as `shadowlap check --expect` judges them: nothing replayed, nothing sent.
 *
 * - `check-context`: the tools the run calls, each with its first call's arguments; the call the
 *   check is made from; the tools called before it; and the number fields the results before it
 *   recorded, latest per tool and field, with those of the whole run for a condition.
 * - `check-preview`: the agent's newest finished recordings judged by the draft (at most `limit`),
 *   with the counts and notes `shadowlap check` gives (its label notes naming three recordings
 *   each, without the run the check is made from), the tools the agent's recordings call, each of
 *   its goldens' recordings judged by it, and the run it is made from. A golden whose recording is
 *   only in its pack is read from the pack here, in a store in memory, never on the server's thread.
 */

/** A number a result recorded under a field: what a reference to it reads, `@lookup_order.result.total`. */
export interface ResultField {
  tool: string;
  field: string;
  value: number | string;
  callNo: number;
}

/** A tool call as the editor offers it: its arguments as recorded, and what it does to the world. */
export interface ContextCall {
  callNo: number;
  tool: string;
  args: unknown;
  effect: string | null;
}

export interface CheckContext {
  runId: string;
  /** The call the check is made from, when it is the agent's tool call. */
  at: ContextCall | null;
  /** Each tool the run calls, by its first call, in the order first called. */
  tools: ContextCall[];
  /** The tools called before the call, in the order first called. */
  before: string[];
  /** Number fields of the results recorded before the call, the latest per tool and field. */
  fields: ResultField[];
  /** Number fields of every result the run recorded, the latest per tool and field: what a condition reads. */
  conds: ResultField[];
}

/** A recording judged by the draft, as a row of the builder's preview. */
export interface PreviewRow {
  runId: string;
  labels: string[];
  outcome: CheckedRecording['outcome'];
  /** Every check came out not applicable: counted apart, never as passed. */
  na: boolean;
  why: string[];
  checks: CheckedRecording['checks'];
}

export interface PreviewGolden {
  path: string;
  runId: string | null;
  /** Its recording judged by the draft; null when it couldn't be read. */
  row: PreviewRow | null;
  /** The tools its recording calls. */
  tools: string[];
  error: string | null;
}

export interface CheckPreview {
  /** The agent's finished recordings, judged or not. */
  total: number;
  /** The newest of them judged, newest first. */
  judged: PreviewRow[];
  /** As `shadowlap check` counts them: `notApplicable` apart from `passed`. */
  counts: CheckReport['counts'];
  /** What the outcomes say against the labels, and the values a check reads that no call judged has. */
  notes: string[];
  /** The tools the agent's recordings call, first seen first. */
  tools: string[];
  goldens: PreviewGolden[];
  madeFrom: PreviewRow | null;
}

export type CheckContextJob = { kind: 'check-context'; runId: string; at: number };

export type CheckPreviewJob = {
  kind: 'check-preview';
  /** The draft, an expect object. */
  expect: Record<string, unknown>;
  /** The agent whose recordings it is judged on, by the words of its command. */
  agent: string;
  /** The run the check is made from, judged too. */
  madeFrom: string | null;
  /** The agent's goldens: each recording in the store, else the folder of its pack. */
  goldens: Array<{ path: string; runId: string | null; pack: string | null }>;
  prices?: Record<string, Price>;
  limit: number;
};

export type CheckJob = CheckContextJob | CheckPreviewJob;

/** The agent's tool calls: a person's answer the agent read and a judge's call are no tool of its own. */
const agentTools = (calls: readonly CallRecord[]): CallRecord[] => calls.filter((c) => c.kind === 'tool' && !isUserInput(c) && !isJudgeCall(c));

const toolsOf = (calls: readonly CallRecord[]): string[] => [...new Set(agentTools(calls).map((c) => c.name))];

/** A result as an object its fields are read from: as recorded, or JSON held in a string, as a reference reads it (the engine's rule). */
function resultObject(value: unknown): Record<string, unknown> | null {
  const v = intoText(value);
  return isObject(v) ? v : null;
}

/** The number fields the calls' results recorded, the latest per tool and field, in the order first seen. Results that failed, were blocked or hold an error are left out. */
function numberFields(calls: readonly CallRecord[], resultOf: (c: CallRecord) => unknown): ResultField[] {
  const at = new Map<string, number>();
  const out: ResultField[] = [];
  for (const c of calls) {
    if (c.origin === 'blocked') continue;
    const result = resultObject(resultOf(c));
    if (!result || 'error' in result) continue;
    for (const [field, value] of Object.entries(result)) {
      if (asNumber(value) === null) continue;
      const key = `${c.name}\n${field}`;
      const f = { tool: c.name, field, value: value as number | string, callNo: c.callNo };
      const i = at.get(key);
      if (i === undefined) at.set(key, out.push(f) - 1);
      else out[i] = f;
    }
  }
  return out;
}

function checkContext(store: Store, job: CheckContextJob): ReadAnswer {
  const run = store.getRun(job.runId);
  if (!run) return failed(404, `no run ${job.runId}`);
  const calls = agentTools(store.getCalls(run.runId));
  const { argsOf, resultOf } = storedCalls(store);
  const read = (v: ((c: CallRecord) => unknown) | undefined) => (c: CallRecord) => v?.(c);
  const callOf = (c: CallRecord): ContextCall => ({ callNo: c.callNo, tool: c.name, args: read(argsOf)(c) ?? null, effect: c.effect });
  const firsts = new Map<string, CallRecord>();
  for (const c of calls) if (!firsts.has(c.name)) firsts.set(c.name, c);
  const at = calls.find((c) => c.callNo === job.at);
  const earlier = calls.filter((c) => c.callNo < job.at);
  const body: CheckContext = {
    runId: run.runId,
    at: at ? callOf(at) : null,
    tools: [...firsts.values()].map(callOf),
    before: toolsOf(earlier),
    fields: numberFields(earlier, read(resultOf)),
    conds: numberFields(calls, read(resultOf)),
  };
  return answer(body);
}

const rowOf = (r: CheckedRecording): PreviewRow => ({ runId: r.runId, labels: r.labels, outcome: r.outcome, na: notApplicable(r), why: r.why, checks: r.checks });

const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One recording judged by `spec` alone, with the tools it calls. */
function judgeOne(r: Pick<RecordingToCheck, 'run' | 'store'>, spec: TestSpec, prices: Record<string, Price> | undefined): { row: PreviewRow; tools: string[] } {
  const calls = r.store.getCalls(r.run.runId);
  const checked = checkRecording({ ...r, pack: null, spec, source: '--expect' }, prices ? { prices } : {}, calls);
  return { row: rowOf(checked), tools: toolsOf(calls) };
}

/** A golden's recording judged by the draft: from the store, else from its pack, read into a store in memory that is closed after. */
function judgeGolden(store: Store, g: CheckPreviewJob['goldens'][number], spec: TestSpec, prices: Record<string, Price> | undefined): PreviewGolden {
  const none = { path: g.path, runId: g.runId, row: null, tools: [] };
  const run = g.runId ? store.getRun(g.runId) : null;
  if (run) return { ...none, ...judgeOne({ run, store }, spec, prices), error: null };
  if (!g.pack) return { ...none, error: 'its recording is in neither the store nor a pack' };
  let pack: ReturnType<typeof packRecording>;
  try {
    pack = packRecording(g.pack);
  } catch (err) {
    return { ...none, error: messageOf(err) };
  }
  try {
    return { ...none, runId: pack.run.runId, ...judgeOne(pack, spec, prices), error: null };
  } finally {
    pack.store.close();
  }
}

function checkPreview(store: Store, job: CheckPreviewJob): ReadAnswer {
  let spec: TestSpec;
  try {
    spec = parseExpect(job.expect, 'expect');
  } catch (err) {
    return failed(400, messageOf(err));
  }
  const prices = job.prices;
  const mine = store
    .allRuns()
    .filter((r) => r.mode === 'record' && r.status !== 'running' && agentOfRun(store, r) === job.agent)
    .sort((a, b) => b.startedAt - a.startedAt);
  const tools = new Set<string>();
  const report = checkRecordings(
    mine.slice(0, job.limit).map((run) => ({ run, store, pack: null, spec, source: '--expect' })),
    { expect: job.expect, ...(prices ? { prices } : {}), read: (_r, calls) => toolsOf(calls).forEach((t) => tools.add(t)) },
  );
  // The report's notes are its label notes, naming every recording, then those on values no call has.
  const labelled = new Set(labelNotes(report.recordings).map((n) => labelNoteWords(n)));
  const others = labelNotes(report.recordings.filter((r) => r.runId !== job.madeFrom)).map((n) => capitalised(labelNoteWords(n, { first: 3 })));
  const made = job.madeFrom ? report.recordings.find((r) => r.runId === job.madeFrom) : undefined;
  const madeRun = !made && job.madeFrom ? store.getRun(job.madeFrom) : null;
  const body: CheckPreview = {
    total: mine.length,
    judged: report.recordings.map(rowOf),
    counts: report.counts,
    notes: [...others, ...report.notes.filter((n) => !labelled.has(n))],
    tools: [...tools],
    goldens: job.goldens.map((g) => judgeGolden(store, g, spec, prices)),
    madeFrom: made ? rowOf(made) : madeRun ? judgeOne({ run: madeRun, store }, spec, prices).row : null,
  };
  return answer(body);
}

export const CHECK_READS: ReadTable<CheckJob> = {
  'check-context': (store, job) => checkContext(store, job),
  'check-preview': (store, job) => checkPreview(store, job),
};
