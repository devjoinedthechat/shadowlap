import type { BlameView, CallRow, CheckView, RunDetail } from '../api.js';
import { callName, dur, ktok } from '../format.js';
import { displayOrigin, isFailure, type Origin7 } from '../origins.js';
import { recordedDuration, type CallIndex } from '../recorded.js';
import type { RunLike } from '../runs.js';
import { inScope } from '../scopes.js';

/**
 * The run page's reading of a run: what to call it, where it forked or was lost, and each call's
 * line in the views. No DOM here.
 */

/** A run's detail as the lists see a run, so the same words and icons apply. */
export function runLikeOf(d: RunDetail): RunLike {
  const meta = d.run.meta;
  const checks = meta?.checks?.length ? { passed: meta.checks.filter((c) => c.ok).length, total: meta.checks.length } : null;
  return {
    runId: d.run.runId,
    parentRunId: d.run.parentRunId,
    mode: d.run.mode,
    status: d.run.status,
    divergence: d.run.divergence ? { callNo: d.run.divergence.callNo, type: d.run.divergence.type } : null,
    command: d.run.command.argv.join(' '),
    codeVersion: d.run.codeVersion,
    startedAt: d.run.startedAt,
    calls: d.calls.length,
    spent: d.summary.cost.spent,
    saved: d.summary.cost.saved,
    captured: d.summary.cost.captured,
    imported: d.summary.imported,
    covers: meta?.covers?.length ? meta.covers : null,
    source: d.source,
    labels: meta?.labels ?? [],
    test: meta?.test ?? null,
    blame: blameOf(d),
    checks,
  };
}

export function forkAtOf(d: RunDetail): number | null {
  return d.forkAt ?? d.run.divergence?.callNo ?? null;
}

/** Model calls in a scope (every model call without one), in order. */
export function modelCalls(calls: readonly CallRow[], scope: string | null | undefined): CallRow[] {
  return calls.filter((c) => c.kind === 'api' && (!scope || inScope(c, scope)));
}

/** Where blame says the run was lost: the call, model call k of m in its scope, the confidence and the fork it rescued. */
export function blameOf(d: RunDetail): BlameView | null {
  const stored = d.run.meta?.blame;
  const b: BlameView | null = d.blame ?? (stored && stored.outcome === 'blamed' && stored.callNo ? { callNo: stored.callNo, confidence: stored.confidence, rescuedRunId: stored.rescuedRunId, scope: stored.scope ?? null } : null);
  if (!b || !b.callNo) return null;
  if (b.modelCall) return b;
  const ms = modelCalls(d.calls, b.scope);
  const k = ms.findIndex((c) => c.callNo === b.callNo) + 1;
  return k ? { ...b, modelCall: { k, m: ms.length } } : b;
}

/** The run's outcome checks, with how many attempts each held in when the server counts them. */
export function checksOf(d: RunDetail): CheckView[] {
  if (d.checks?.length) return d.checks;
  return (d.run.meta?.checks ?? []).map((c) => ({ label: c.label, ok: c.ok }));
}

export function originOf(c: CallRow): Origin7 {
  return displayOrigin(c);
}

/** Tokens in and out, as `3.0k → 80`. */
export function tokensText(c: CallRow): string {
  if (c.kind !== 'api' || !c.usage) return '';
  return `${ktok(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} → ${ktok(c.usage.output)}`;
}

/** The detail beside a call's name: a model call's stop reason or HTTP failure, a tool's arguments. */
export function callDetail(c: CallRow): { text: string; err: boolean } {
  if (c.kind === 'api') {
    if (c.outcome === 'error') return { text: c.status ? `HTTP ${c.status}${c.attempts ? ` · ${c.attempts + 1} attempts` : ''}` : (c.error ?? 'error'), err: true };
    if (c.resultShort) return { text: c.resultShort, err: false };
    return { text: [c.model, c.stopReason].filter(Boolean).join(' · '), err: false };
  }
  if (c.error && c.origin !== 'blocked' && c.origin !== 'stubbed') return { text: c.detail || c.error, err: false };
  return { text: c.detail, err: false };
}

/** What a tool returned, on the line under it: the server's short result, or what fenced it. */
export function resultLine(c: CallRow): { text: string; err: boolean } | null {
  if (c.kind === 'api') return null;
  if (c.origin === 'blocked') return { text: 'blocked', err: true };
  if (c.resultShort) return { text: `${c.origin === 'stubbed' ? 'stubbed ' : ''}${c.resultShort}`, err: false };
  if (c.origin === 'stubbed') return { text: 'stubbed', err: false };
  if (isFailure(c) && c.error) return { text: c.error, err: true };
  return null;
}

/** A call's time: its own, or for a replayed call its recorded duration, which the replay did not wait for. */
export function timeOf(c: CallRow, ancestors: readonly CallIndex[], live: boolean): { text: string; was: boolean } {
  if (c.origin === 'replayed') {
    const ms = recordedDuration(c, ancestors);
    return { text: ms === null ? '—' : dur(ms), was: true };
  }
  if (c.latencyMs !== null) return { text: dur(c.latencyMs), was: false };
  return { text: c.outcome === null && live ? '…' : '', was: false };
}

export interface Turn {
  model: CallRow;
  tools: CallRow[];
}

/**
 * Calls grouped the way an agent loop makes them: a model call, then the tool calls it led to. With
 * scopes, a tool call belongs to the last model call made in its own scope.
 */
export function turnsOf(calls: readonly CallRow[], scoped: boolean): Turn[] {
  const turns: Turn[] = [];
  const last = new Map<string, Turn>();
  let cur: Turn | null = null;
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

export interface TimelineRow {
  call: CallRow;
  start: number;
  end: number;
  /** First token, from the start of the call, for a streamed model call that ran live. */
  firstToken: number | null;
}

/** Every call on one clock, from the first call's start. */
export function timelineOf(calls: readonly CallRow[], now = Date.now()): { rows: TimelineRow[]; end: number; parallel: Array<[number, number]> } {
  const timed = calls.filter((c) => c.startedAt > 0);
  if (!timed.length) return { rows: [], end: 1, parallel: [] };
  const t0 = Math.min(...timed.map((c) => c.startedAt));
  const rows = timed.map((c) => {
    const endAt = c.endedAt ?? (c.outcome === null ? now : c.startedAt + (c.latencyMs ?? 0));
    return { call: c, start: c.startedAt - t0, end: Math.max(c.startedAt, endAt) - t0, firstToken: c.ttftMs !== null && c.origin === 'live' ? c.ttftMs : null };
  });
  const end = Math.max(1, ...rows.map((r) => r.end));
  // Calls that ran at once: one starting before the previous one ended.
  const parallel: Array<[number, number]> = [];
  const byStart = [...rows].sort((a, b) => a.start - b.start || a.call.callNo - b.call.callNo);
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1]!;
    const r = byStart[i]!;
    if (r.start < prev.end - 1 && r.call.kind !== 'clock' && r.call.kind !== 'random') parallel.push([prev.call.callNo, r.call.callNo]);
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

/** A model call's short name and its tokens, for a hover card. */
export function callTitle(c: CallRow): string {
  return `#${c.callNo} ${callName(c.kind, c.name)}`;
}
