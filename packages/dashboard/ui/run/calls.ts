import { callName, dur, ktok } from '../format.js';
import { displayOrigin, isFailure, type Origin7 } from '../origins.js';
import { recordedDuration, type CallIndex } from '../recorded.js';
import { inScope } from '../scopes.js';

/**
 * Each call's line in the run page's views: its detail, its result, its time, the turn it belongs
 * to and its place on the clock. Typed by shape, with no DOM and no API module, so the tests import it.
 */

export interface CallLike {
  callNo: number;
  kind: string;
  name: string;
  origin: string;
  effect: string | null;
  outcome: 'ok' | 'error' | null;
  status: number | null;
  latencyMs: number | null;
  model: string | null;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  detail: string;
  attempts: number;
  replayedFrom: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  ttftMs: number | null;
  scope: string | null;
  recordedMs?: number | null;
  resultShort?: string | null;
}

export function originOf(c: Pick<CallLike, 'origin' | 'outcome'>): Origin7 {
  return displayOrigin(c);
}

/** Model calls in a scope (every model call without one), in order. */
export function modelCalls<C extends Pick<CallLike, 'kind' | 'scope' | 'callNo'>>(calls: readonly C[], scope: string | null | undefined): C[] {
  return calls.filter((c) => c.kind === 'api' && (!scope || inScope(c, scope)));
}

/** Which model call a call is among the model calls of its scope: k of m, or null when it is not one. */
export function modelCallOf(calls: ReadonlyArray<Pick<CallLike, 'kind' | 'scope' | 'callNo'>>, callNo: number, scope: string | null | undefined): { k: number; m: number } | null {
  const ms = modelCalls(calls, scope);
  const k = ms.findIndex((c) => c.callNo === callNo) + 1;
  return k ? { k, m: ms.length } : null;
}

/** Tokens in and out, as `3.0k → 80`. */
export function tokensText(c: CallLike): string {
  if (c.kind !== 'api' || !c.usage) return '';
  return `${ktok(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} → ${ktok(c.usage.output)}`;
}

/** The detail beside a call's name: a model call's stop reason or HTTP failure, a tool's arguments. */
export function callDetail(c: CallLike): { text: string; err: boolean } {
  if (c.kind === 'api') {
    if (c.outcome === 'error') return { text: c.status ? `HTTP ${c.status}${c.attempts ? ` · ${c.attempts + 1} attempts` : ''}` : (c.error ?? 'error'), err: true };
    if (c.resultShort) return { text: c.resultShort, err: false };
    return { text: [c.model, c.stopReason].filter(Boolean).join(' · '), err: false };
  }
  if (c.error && c.origin !== 'blocked' && c.origin !== 'stubbed') return { text: c.detail || c.error, err: false };
  return { text: c.detail, err: false };
}

/** What a tool returned, on the line under it: the server's short result, or what fenced it. */
export function resultLine(c: CallLike): { text: string; err: boolean } | null {
  if (c.kind === 'api') return null;
  if (c.origin === 'blocked') return { text: 'blocked', err: true };
  if (c.resultShort) return { text: `${c.origin === 'stubbed' ? 'stubbed ' : ''}${c.resultShort}`, err: false };
  if (c.origin === 'stubbed') return { text: 'stubbed', err: false };
  if (isFailure(c) && c.error) return { text: c.error, err: true };
  return null;
}

/** A call's time: its own, or for a replayed call its recorded duration, which the replay did not wait for. */
export function timeOf(c: CallLike, ancestors: readonly CallIndex[], live: boolean): { text: string; was: boolean } {
  if (c.origin === 'replayed') {
    const ms = recordedDuration(c, ancestors);
    return { text: ms === null ? '—' : dur(ms), was: true };
  }
  if (c.latencyMs !== null) return { text: dur(c.latencyMs), was: false };
  return { text: c.outcome === null && live ? '…' : '', was: false };
}

export interface Turn<C extends CallLike = CallLike> {
  model: C;
  tools: C[];
}

/**
 * Calls grouped the way an agent loop makes them: a model call, then the tool calls it led to. With
 * scopes, a tool call belongs to the last model call made in its own scope.
 */
export function turnsOf<C extends CallLike>(calls: readonly C[], scoped: boolean): Array<Turn<C>> {
  const turns: Array<Turn<C>> = [];
  const last = new Map<string, Turn<C>>();
  let cur: Turn<C> | null = null;
  for (const c of calls) {
    if (c.kind === 'api') {
      cur = { model: c, tools: [] };
      turns.push(cur);
      last.set(c.scope ?? '', cur);
    } else if (c.kind === 'tool') {
      const t = scoped ? last.get(c.scope ?? '') : cur;
      t?.tools.push(c);
    }
  }
  return turns;
}

export interface TimelineRow<C extends CallLike = CallLike> {
  call: C;
  start: number;
  end: number;
  /** First token, from the start of the call, for a streamed model call that ran live. */
  firstToken: number | null;
}

/** Every call on one clock, from the first call's start, and the pairs of calls that ran at once. */
export function timelineOf<C extends CallLike>(calls: readonly C[], now = Date.now()): { rows: Array<TimelineRow<C>>; end: number; parallel: Array<[number, number]> } {
  const timed = calls.filter((c) => c.startedAt > 0);
  if (!timed.length) return { rows: [], end: 1, parallel: [] };
  const t0 = Math.min(...timed.map((c) => c.startedAt));
  const rows = timed.map((c) => {
    const endAt = c.endedAt ?? (c.outcome === null ? now : c.startedAt + (c.latencyMs ?? 0));
    return { call: c, start: c.startedAt - t0, end: Math.max(c.startedAt, endAt) - t0, firstToken: c.ttftMs !== null && c.origin === 'live' ? c.ttftMs : null };
  });
  const end = Math.max(1, ...rows.map((r) => r.end));
  // A call ran at once with another when it started before the one still running ended.
  const parallel: Array<[number, number]> = [];
  const byStart = [...rows].filter((r) => r.call.kind !== 'clock' && r.call.kind !== 'random').sort((a, b) => a.start - b.start || a.call.callNo - b.call.callNo);
  let running: TimelineRow<C> | null = null;
  for (const r of byStart) {
    if (running && r.start < running.end - 1) parallel.push([running.call.callNo, r.call.callNo]);
    if (!running || r.end > running.end) running = r;
  }
  return { rows, end, parallel };
}

/** Axis ticks for a span: a round step, at most about nine ticks. */
export function ticksFor(end: number): Array<{ at: number; label: string }> {
  const steps = [10, 50, 100, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
  const step = steps.find((s) => end / s <= 9) ?? 3_600_000;
  const out: Array<{ at: number; label: string }> = [];
  for (let x = 0; x <= end; x += step) out.push({ at: x, label: step >= 60_000 ? `${x / 60_000}m` : end > 1000 ? `${x / 1000}s` : `${x}ms` });
  return out;
}

export function callTitle(c: Pick<CallLike, 'callNo' | 'kind' | 'name'>): string {
  return `#${c.callNo} ${callName(c.kind, c.name)}`;
}
