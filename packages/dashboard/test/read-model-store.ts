import { NO_COMMAND, type CallKind, type Effect, type Origin, type Outcome, type RunMeta, type RunStatus, type Store, type Usage } from '@shadowlap/engine';

/**
 * Builds runs for the read-model tests from compact call strings: one character per call, as the
 * origin strip writes it (r replayed, l live, o overridden, i injected, f failed, b blocked, s
 * stubbed). Model calls carry usage and a latency; replayed calls point at the parent's call of the
 * same number unless told otherwise.
 */

export const MODEL = 'claude-sonnet-4-5';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface CallSpec {
  code: string;
  kind?: CallKind;
  latencyMs?: number;
  replayedFrom?: number;
  usage?: Usage | null;
  model?: string | null;
  scope?: string;
}

export interface RunSpec {
  mode?: 'record' | 'replay';
  parent?: string;
  startedAt: number;
  status?: RunStatus;
  divergence?: number;
  meta?: RunMeta;
  argv?: string[];
  calls?: string | CallSpec[];
  /** Per-call overrides by call number. */
  at?: Record<number, Partial<CallSpec>>;
}

const ORIGIN: Record<string, Origin> = { r: 'replayed', l: 'live', o: 'overridden', i: 'live', f: 'live', b: 'blocked', s: 'stubbed' };

/** The usage a model call records: its input grows with the conversation, half of it read from the cache. */
export function usageAt(callNo: number): Usage {
  return { inputTokens: 40, outputTokens: 60, cacheReadInputTokens: 1000 + callNo * 100, cacheCreationInputTokens: 100 };
}

export function addRun(store: Store, spec: RunSpec): string {
  const run = store.createRun({
    mode: spec.mode ?? (spec.parent ? 'replay' : 'record'),
    ...(spec.parent ? { parentRunId: spec.parent } : {}),
    command: { argv: spec.argv ?? ['python', 'refund_agent.py'], cwd: '/work' },
    codeVersion: 'a7b3c2e',
    startedAt: spec.startedAt,
    ...(spec.meta ? { meta: spec.meta } : {}),
  });
  const calls: CallSpec[] = typeof spec.calls === 'string' ? [...spec.calls].map((code) => ({ code })) : (spec.calls ?? []);
  let at = spec.startedAt;
  calls.forEach((c0, i) => {
    const callNo = i + 1;
    const c = { ...c0, ...(spec.at?.[callNo] ?? {}) };
    const kind: CallKind = c.kind ?? (['o', 'b', 's'].includes(c.code) ? 'tool' : 'api');
    const origin = ORIGIN[c.code];
    if (!origin) throw new Error(`unknown call code ${c.code}`);
    const identity = { kind, name: kind === 'api' ? 'POST /v1/messages' : 'issue_refund', fingerprint: `fp${callNo}`, occurrence: 1 };
    const effect: Effect | null = kind === 'tool' ? 'write' : null;
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect, requestRef: null, meta: c.scope ? { scope: c.scope } : {}, at: (at += 10) });
    const replayed = c.code === 'r';
    const outcome: Outcome = c.code === 'i' || c.code === 'f' || c.code === 'b' ? 'error' : 'ok';
    const meta: Record<string, unknown> = { latencyMs: replayed || c.code === 'i' ? 0 : (c.latencyMs ?? (kind === 'api' ? 2000 : 100)) };
    if (kind === 'api' && c.code !== 'i' && c.code !== 'f') {
      const usage = c.usage === undefined ? usageAt(callNo) : c.usage;
      if (usage) meta.usage = usage;
      const model = c.model === undefined ? MODEL : c.model;
      if (model) meta.model = model;
    }
    if (c.code === 'i') Object.assign(meta, { injected: true, status: 529 });
    if (replayed) meta.replayedFrom = c.replayedFrom ?? callNo;
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: null, outcome, meta, at: (at += 10) });
  });
  if (spec.divergence) {
    store.setDivergence(run.runId, { type: 'request_changed', callNo: spec.divergence, kind: 'api', name: 'POST /v1/messages', replayedBefore: spec.divergence - 1 });
  }
  if (spec.status !== 'running') store.endRun(run.runId, spec.status ?? 'completed', at + 10);
  return run.runId;
}

export const capture = (store: Store, startedAt: number, file = 'cap/2026-09-30.jsonl') =>
  addRun(store, { startedAt, argv: [NO_COMMAND], meta: { imported: { at: startedAt, from: `/work/${file}` }, covers: ['api'] }, calls: 'llll' });

export const blameOf = (callNo: number | null, rescuedRunId: string | null, at: number): NonNullable<RunMeta['blame']> => ({
  at,
  outcome: callNo === null ? 'unrescuable' : 'blamed',
  callNo,
  confidence: 'high',
  rescuedRunId,
  fields: {},
  oracle: ['the agent exits 0'],
  probes: [],
  spent: 0.1,
});
