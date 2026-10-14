import type { ReplayOptions } from './session.js';
import type { Store } from './store.js';
import type { CallRecord, NotRecorded, RunIntervention, RunRecord } from './types.js';

/**
 * Facts a run page states about a run that its calls don't show by themselves: what a replay was
 * told to do differently, what the run did that was never recorded, and a tool's result in a line.
 */

const VALUE_MAX = 200;

/** A value in one line, at most `max` characters, the last of them "…" when cut. */
export function oneLine(v: unknown, max: number): string {
  const s = (typeof v === 'string' ? v : (JSON.stringify(v) ?? '')).replace(/\s*\n\s*/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The request-level interventions `shadowlap replay` passes the sidecar (`--inject`, `--set`, `--model`). */
export interface RequestInterventions {
  inject?: { atCall: number; text: string; as: 'system' | 'user' };
  set?: { fromCall: number; fields: Record<string, unknown> };
}

/**
 * A replay's options as the flags that set them, for `RunMeta.interventions`: what the run page's
 * banner names. Defaults (`--writes block`, `--reads live`) are left out.
 */
export function describeInterventions(replay: Partial<ReplayOptions> | undefined, request?: RequestInterventions): RunIntervention[] {
  const out: RunIntervention[] = [];
  const add = (flag: string, value: string | null, callNo: number | null) => out.push({ flag, value: value === null ? null : oneLine(value, VALUE_MAX), callNo });
  for (const [callNo, status] of replay?.failAt ?? []) add('--fail-at', `${callNo}=${status}`, callNo);
  for (const [callNo, result] of replay?.overrides ?? []) add('--override', `${callNo}=${oneLine(result, VALUE_MAX)}`, callNo);
  if (request?.inject) {
    add('--inject', `${request.inject.atCall}=${request.inject.text}`, request.inject.atCall);
    add('--inject-as', request.inject.as, null);
  }
  for (const [key, value] of Object.entries(request?.set?.fields ?? {})) {
    const at = request!.set!.fromCall;
    if (key === 'model' && typeof value === 'string') add('--model', `${at}:${value}`, at);
    else add('--set', `${at}:${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`, at);
  }
  if (replay?.promptFrom !== undefined) add('--prompt-from', String(replay.promptFrom), replay.promptFrom);
  if (replay?.divergeAt !== undefined) add('--diverge-at', String(replay.divergeAt), replay.divergeAt);
  for (const name of replay?.liveTools ?? []) add('--live-tool', name, null);
  if (replay?.writes && replay.writes !== 'block') add('--writes', replay.writes, null);
  if (replay?.reads && replay.reads !== 'live') add('--reads', replay.reads, null);
  return out;
}

const FORCED = /^forced live by (--fail-at|--diverge-at|--prompt-from|--live-tool) (\S+)/;

/**
 * The interventions of a replay made before they were stored on the run, read back from what the
 * replay left: the divergence a forcing flag names, overridden and injected calls, stubbed writes.
 * Changes to requests (`--inject`, `--model`, `--set`) look like any edit to the agent and are
 * not guessed.
 */
export function inferInterventions(store: Store, run: RunRecord, calls: readonly CallRecord[]): RunIntervention[] {
  if (run.mode !== 'replay') return [];
  const out: RunIntervention[] = [];
  const has = (flag: string, callNo: number | null) => out.some((x) => x.flag === flag && x.callNo === callNo);
  for (const c of calls) {
    if (c.kind === 'api' && c.end?.meta.injected && typeof c.end.meta.status === 'number' && !has('--fail-at', c.callNo)) out.push({ flag: '--fail-at', value: `${c.callNo}=${c.end.meta.status}`, callNo: c.callNo });
    if (c.origin === 'overridden') {
      let result: unknown = null;
      try {
        result = c.end?.responseRef ? store.getJson<{ result?: unknown }>(c.end.responseRef)?.result : null;
      } catch {
        result = null;
      }
      const from = typeof c.end?.meta.overriddenFrom === 'number' ? c.end.meta.overriddenFrom : c.callNo;
      out.push({ flag: '--override', value: `${from}=${oneLine(result, VALUE_MAX)}`, callNo: c.callNo });
    }
  }
  const d = run.divergence;
  const m = d?.type === 'forced' && d.reason ? FORCED.exec(d.reason) : null;
  if (m && !(m[1] === '--fail-at' && has('--fail-at', d!.callNo))) out.push({ flag: m[1]!, value: m[2]!.replace(/:$/, ''), callNo: m[1] === '--live-tool' ? null : d!.callNo });
  if (calls.some((c) => c.origin === 'stubbed')) out.push({ flag: '--writes', value: 'stub', callNo: null });
  return out;
}

/** A replay's interventions: as stored when it ran, else as its calls show them. */
export function runInterventions(store: Store, run: RunRecord, calls: readonly CallRecord[]): RunIntervention[] {
  return run.meta?.interventions ?? inferInterventions(store, run, calls);
}

const RESULT_MAX = 72;

/**
 * A tool's result in one line of about 72 characters, for a table cell under the call: `blocked`
 * for a write fenced after a fork, `stubbed …` for one answered by its stand-in, the error for one
 * that failed, `HTTP 200 …` for a declared HTTP host. Null for other kinds of call, and for a tool
 * still running.
 */
export function toolResultLine(call: CallRecord, payload: unknown): string | null {
  if (call.kind !== 'tool') return null;
  if (call.origin === 'blocked') return 'blocked';
  if (!call.end) return null;
  const p = typeof payload === 'object' && payload !== null ? (payload as { result?: unknown; error?: { message?: unknown } }) : {};
  if (call.end.outcome === 'error') {
    const message = p.error && typeof p.error.message === 'string' ? p.error.message : (call.end.meta.error?.message ?? 'error');
    return oneLine(`error: ${message}`, RESULT_MAX);
  }
  let result = p.result;
  let prefix = call.origin === 'stubbed' ? 'stubbed ' : '';
  // A declared HTTP host's call is recorded as the response: its status, then its body.
  const http = typeof call.meta.http === 'string' && typeof result === 'object' && result !== null && typeof (result as { status?: unknown }).status === 'number';
  if (http) {
    const r = result as { status: number; body?: unknown };
    prefix += `HTTP ${r.status}${r.body === undefined ? '' : ' '}`;
    result = r.body === undefined ? '' : r.body;
  }
  const s = result === undefined ? '' : typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
  return oneLine(prefix + s, RESULT_MAX);
}

/**
 * Merges what a run did unrecorded into its metadata: the guard's hosts at the end of any run,
 * the project's tools without an effect after a recording.
 */
export function recordNotRecorded(store: Store, runId: string, found: Partial<NotRecorded>): void {
  const run = store.getRun(runId);
  if (!run) return;
  const was = run.meta?.notRecorded;
  const next: NotRecorded = { hosts: found.hosts ?? was?.hosts ?? [], tools: found.tools ?? was?.tools ?? [] };
  if (!next.hosts.length && !next.tools.length && !was) return;
  store.updateRunMeta(runId, { notRecorded: next });
}

/**
 * Tools found in the project with no declared effect that a run did not record: a call of one of
 * them ran in the agent unseen, and runs again on every replay.
 */
export function unrecordedTools(found: ReadonlyArray<{ name: string; effect: string | null }>, calls: readonly Pick<CallRecord, 'kind' | 'name'>[]): string[] {
  const recorded = new Set(calls.filter((c) => c.kind === 'tool').map((c) => c.name));
  return [...new Set(found.filter((t) => !t.effect && !recorded.has(t.name)).map((t) => t.name))].sort();
}
