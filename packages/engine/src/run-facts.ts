import { maskedCaptureVerdict } from './family-checks.js';
import { isObject } from './is-object.js';
import { rewriteText, type RewriteObserver } from './normalize.js';
import type { StoreOf } from './store.js';
import type { CallRecord, Normalizer, NotRecorded, RunMeta, RunRecord } from './types.js';

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

/**
 * One flag a replay ran with, as a run's page names it: the flag, what follows it in its short form,
 * and the call it applies to. Read from the run's record (`RunMeta.interventions`, which the sidecar
 * writes when the replay starts), or for a replay made before replays kept their flags, from what its
 * calls show.
 */
export interface InterventionFlag {
  flag: string;
  /** What follows the flag: `19=529`, `16=@policy.json`, `15:claude-opus-5`; null for a flag alone. */
  value: string | null;
  /** The call it applies to, when it names one. */
  callNo: number | null;
}

const FORCED = /^forced live by (--fail-at|--diverge-at|--prompt-from|--live-tool) (\S+)/;

/** The result an overridden call of the replay recorded, in one line: the override as the run kept it. */
function overriddenResult(store: StoreOf<'recording'>, c: CallRecord): string {
  let result: unknown;
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
export function inferInterventions(store: StoreOf<'recording'>, run: RunRecord, calls: readonly CallRecord[]): InterventionFlag[] {
  if (run.mode !== 'replay') return [];
  const out: InterventionFlag[] = [];
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
 * A replay's interventions: as the run's record keeps them, else as its calls show them. A run can
 * come from someone else's pack, so only well-formed entries are read. The record's short form names
 * a flag with what follows it; the command a replay ran instead of its parent's is no flag (the run's
 * own command names it). An override given inline is shown as the result its call recorded, which a
 * redacted copy has masked.
 */
export function runInterventions(store: StoreOf<'recording'>, run: RunRecord, calls: readonly CallRecord[]): InterventionFlag[] {
  const stored: unknown = run.meta?.interventions;
  if (stored === undefined) return inferInterventions(store, run, calls);
  if (!Array.isArray(stored)) return [];
  const out: InterventionFlag[] = [];
  for (const x of stored as unknown[]) {
    if (typeof x !== 'object' || x === null) continue;
    const { kind, at, flag } = x as { kind?: unknown; at?: unknown; flag?: unknown };
    if (kind === 'command' || typeof flag !== 'string' || !flag.startsWith('--')) continue;
    const callNo = Number.isInteger(at) ? (at as number) : null;
    const space = flag.indexOf(' ');
    const name = space < 0 ? flag : flag.slice(0, space);
    let value = space < 0 ? null : oneLine(flag.slice(space + 1), VALUE_MAX);
    if (kind === 'override' && callNo !== null && (value === `${callNo}=…` || value === String(callNo))) {
      const c = calls.find((y) => y.origin === 'overridden' && overriddenFrom(y) === callNo);
      if (c) value = `${callNo}=${overriddenResult(store, c)}`;
    }
    out.push({ flag: name, value, callNo });
  }
  return out;
}

/**
 * Run metadata with redaction rules applied to what this module keeps on a run: the hosts the guard
 * named, which can name internal systems, and a capture's verdict by the rules on calls, whose rules'
 * details name the values its calls had (family-checks.ts), for a copy (pack, export html). A
 * replay's flags are masked with the rest of the run's record (redact.ts). `observer` hears each
 * change, for the preview.
 */
export function redactRunFacts(meta: RunMeta, rules: readonly Normalizer[], observer?: RewriteObserver): RunMeta {
  if (!rules.length) return meta;
  const text = (s: string) => rewriteText(s, rules as Normalizer[], observer);
  const out: RunMeta = { ...meta };
  const nr: unknown = meta.notRecorded;
  if (typeof nr === 'object' && nr !== null && Array.isArray((nr as NotRecorded).hosts)) {
    out.notRecorded = { ...(nr as NotRecorded), hosts: (nr as NotRecorded).hosts.map((h) => (typeof h === 'object' && h !== null && typeof h.target === 'string' ? { ...h, target: text(h.target) } : h)) };
  }
  if (isObject(meta.judged)) out.judged = maskedCaptureVerdict(meta.judged, text);
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
export function recordNotRecorded(store: StoreOf<'recording'>, runId: string, found: Partial<NotRecorded>): void {
  const run = store.getRun(runId);
  if (!run) return;
  const was = run.meta?.notRecorded;
  const next: NotRecorded = { hosts: found.hosts ?? was?.hosts ?? [], tools: found.tools ?? was?.tools ?? [] };
  if (!next.hosts.length && !next.tools.length && !was) return;
  store.updateRunMeta(runId, { notRecorded: next });
}

/**
 * Tools found in the project with no declared effect that a run did not record: a call of one of
 * them ran in the agent unseen, and runs again on every replay. The tools the model called that the
 * run did not record, read from the run itself, are unrecordedTools (unrecorded-tools.ts).
 */
export function unrecordedProjectTools(found: ReadonlyArray<{ name: string; effect: string | null }>, calls: readonly Pick<CallRecord, 'kind' | 'name'>[]): string[] {
  const recorded = new Set(calls.filter((c) => c.kind === 'tool').map((c) => c.name));
  return [...new Set(found.filter((t) => !t.effect && !recorded.has(t.name)).map((t) => t.name))].sort();
}
