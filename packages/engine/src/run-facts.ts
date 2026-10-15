import { rewriteText } from './normalize.js';
import type { ReplayOptions } from './session.js';
import type { Store } from './store.js';
import type { CallRecord, Normalizer, NotRecorded, RunIntervention, RunMeta, RunRecord } from './types.js';

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

/** Where each `--override` result was read from, by call, as it was typed: `{ 16: '@policy.json' }`. */
export type OverrideSources = Readonly<Record<number, string>>;

/** The files `--override <call>=@<file>` specs read their results from; a result given inline has none. */
export function overrideSources(specs: readonly string[]): Record<number, string> {
  const out: Record<number, string> = {};
  // As `shadowlap replay` reads them: `<call>=@<file>`, the rest of the spec after the `@` naming the file.
  for (const spec of specs) {
    const m = /^(\d+)=(@[\s\S]+)$/.exec(spec);
    if (m) out[Number(m[1])] = m[2]!;
  }
  return out;
}

/** A short word a flag takes (a status such as `529` or `timeout`, a tool name): never a payload. */
const WORD = /^[A-Za-z0-9][\w.:/-]{0,79}$/;
/** A model id, which may name its version after an `@` (Vertex: `claude-opus-5@20260101`). */
const MODEL = /^[A-Za-z0-9][\w.:/-]{0,79}(?:@[\w.-]{1,40})?$/;
const word = (v: unknown, shape = WORD): string | null => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : null;
  return s !== null && shape.test(s) ? s : null;
};

/**
 * A replay's options as the flags that set them, for `RunMeta.interventions`: what the run page's
 * banner names. Defaults (`--writes block`, `--reads live`) are left out.
 *
 * What a flag carried in is not kept: an overridden result, an injected instruction and a request
 * value can hold anything, and the run's metadata is copied as it is wherever the run goes. The
 * replay's own calls hold them, and a redacted copy masks them there. So an override is kept as its
 * call and the file it was read from (`16=@policy.json`, given as `sources`), or its call alone;
 * `--inject` as its call, `--set` as its call and key. A status, a model or a tool name is kept.
 */
export function describeInterventions(replay: Partial<ReplayOptions> | undefined, request?: RequestInterventions, sources?: OverrideSources): RunIntervention[] {
  const out: RunIntervention[] = [];
  const add = (flag: string, value: string | null, callNo: number | null) => out.push({ flag, value: value === null ? null : oneLine(value, VALUE_MAX), callNo });
  for (const [callNo, status] of replay?.failAt ?? []) {
    const w = word(status);
    add('--fail-at', w === null ? String(callNo) : `${callNo}=${w}`, callNo);
  }
  for (const [callNo] of replay?.overrides ?? []) {
    const file = sources?.[callNo];
    add('--override', typeof file === 'string' && file.startsWith('@') ? `${callNo}=${file}` : String(callNo), callNo);
  }
  if (request?.inject) {
    add('--inject', String(request.inject.atCall), request.inject.atCall);
    add('--inject-as', request.inject.as, null);
  }
  for (const [key, value] of Object.entries(request?.set?.fields ?? {})) {
    const at = request!.set!.fromCall;
    const model = key === 'model' ? word(value, MODEL) : null;
    if (model !== null) add('--model', `${at}:${model}`, at);
    else add('--set', `${at}:${key}`, at);
  }
  if (replay?.promptFrom !== undefined) add('--prompt-from', String(replay.promptFrom), replay.promptFrom);
  if (replay?.divergeAt !== undefined) add('--diverge-at', String(replay.divergeAt), replay.divergeAt);
  for (const name of replay?.liveTools ?? []) add('--live-tool', word(name), null);
  if (replay?.writes && replay.writes !== 'block') add('--writes', replay.writes, null);
  if (replay?.reads && replay.reads !== 'live') add('--reads', replay.reads, null);
  // An option added since this list was written is named after its key, so the page still says
  // it; only its calls and short words are kept, since it may carry a payload as well.
  for (const [key, value] of Object.entries(replay ?? {}) as Array<[string, unknown]>) {
    if (KNOWN_OPTIONS.has(key) || value === undefined || value === null || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (value instanceof Map) for (const [k] of value) add(flag, word(k), Number.isInteger(k) ? (k as number) : null);
    else if (value instanceof Set) for (const v of value) add(flag, word(v), Number.isInteger(v) ? (v as number) : null);
    else add(flag, word(value), Number.isInteger(value) ? (value as number) : null);
  }
  return out;
}

/** The replay options described above, and `kinds`, which a partial recording sets, not a flag. */
const KNOWN_OPTIONS = new Set(['failAt', 'overrides', 'promptFrom', 'divergeAt', 'liveTools', 'writes', 'reads', 'kinds']);

const FORCED = /^forced live by (--fail-at|--diverge-at|--prompt-from|--live-tool) (\S+)/;

/** The result an overridden call of the replay recorded, in one line: the override as the run kept it. */
function overriddenResult(store: Store, c: CallRecord): string {
  let result: unknown = null;
  try {
    result = c.end?.responseRef ? store.getJson<{ result?: unknown }>(c.end.responseRef)?.result : null;
  } catch {
    result = null;
  }
  return oneLine(result, VALUE_MAX);
}

const overriddenFrom = (c: CallRecord): number => (typeof c.end?.meta.overriddenFrom === 'number' ? c.end.meta.overriddenFrom : c.callNo);

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
    if (c.origin === 'overridden') out.push({ flag: '--override', value: `${overriddenFrom(c)}=${overriddenResult(store, c)}`, callNo: c.callNo });
  }
  const d = run.divergence;
  const m = d?.type === 'forced' && d.reason ? FORCED.exec(d.reason) : null;
  if (m && !(m[1] === '--fail-at' && has('--fail-at', d!.callNo))) out.push({ flag: m[1]!, value: m[2]!.replace(/:$/, ''), callNo: m[1] === '--live-tool' ? null : d!.callNo });
  if (calls.some((c) => c.origin === 'stubbed')) out.push({ flag: '--writes', value: 'stub', callNo: null });
  return out;
}

/**
 * A replay's interventions: as stored when it ran, else as its calls show them. A run can come
 * from someone else's pack, so only well-formed entries are kept. An override kept as its call
 * alone shows the result the overridden call recorded, which a redacted copy has masked.
 */
export function runInterventions(store: Store, run: RunRecord, calls: readonly CallRecord[]): RunIntervention[] {
  const stored: unknown = run.meta?.interventions;
  if (stored === undefined) return inferInterventions(store, run, calls);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && typeof (x as { flag?: unknown }).flag === 'string')
    .map((x) => {
      const callNo = Number.isInteger(x.callNo) ? (x.callNo as number) : null;
      let value = typeof x.value === 'string' ? x.value : null;
      if (x.flag === '--override' && callNo !== null && value === String(callNo)) {
        const c = calls.find((y) => y.origin === 'overridden' && overriddenFrom(y) === callNo);
        if (c) value = `${callNo}=${overriddenResult(store, c)}`;
      }
      return { flag: x.flag as string, value, callNo };
    });
}

/**
 * Run metadata with redaction rules applied to what this module keeps on a run: the flags' values
 * and the hosts the guard named. A second layer for a copy (pack, export html): flags are stored
 * without their payloads, and hosts can name internal systems.
 */
export function redactRunFacts(meta: RunMeta, rules: readonly Normalizer[]): RunMeta {
  if (!rules.length) return meta;
  const text = (s: string) => rewriteText(s, rules as Normalizer[]);
  const out: RunMeta = { ...meta };
  if (Array.isArray(meta.interventions)) out.interventions = meta.interventions.map((x) => (typeof x === 'object' && x !== null && typeof x.value === 'string' ? { ...x, value: text(x.value) } : x));
  const nr: unknown = meta.notRecorded;
  if (typeof nr === 'object' && nr !== null && Array.isArray((nr as NotRecorded).hosts)) {
    out.notRecorded = { ...(nr as NotRecorded), hosts: (nr as NotRecorded).hosts.map((h) => (typeof h === 'object' && h !== null && typeof h.target === 'string' ? { ...h, target: text(h.target) } : h)) };
  }
  return out;
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
