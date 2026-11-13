import type { LineageNode, RunListItem } from '../types.js';
import type { RunLike } from '../runs.js';
import { agentOf } from '../scopes.js';
import type { CallLike } from './calls.js';

/**
 * What only the run's other views read, kept off the page: Turns' tool calls under the model call
 * that asked for them (TurnsView.tsx), Timeline's calls on one clock with its ticks
 * (TimelineView.tsx), and a family's runs as the lists see them (ForksView.tsx, ProvenanceView.tsx).
 * Those views load on a press of the view switch, and only they import it.
 */

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
      last.set(agentOf(c) ?? '', cur);
    } else if (c.kind === 'tool') {
      const t = scoped ? last.get(agentOf(c) ?? '') : cur;
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
  // A loop, not Math.min(...): a run of 100,000 calls is more arguments than a call can take.
  let t0 = Infinity;
  for (const c of timed) t0 = Math.min(t0, c.startedAt);
  const rows = timed.map((c) => {
    const endAt = c.endedAt ?? (c.outcome === null ? now : c.startedAt + (c.latencyMs ?? 0));
    return { call: c, start: c.startedAt - t0, end: Math.max(c.startedAt, endAt) - t0, firstToken: c.ttftMs !== null && c.origin === 'live' ? c.ttftMs : null };
  });
  let end = 1;
  for (const r of rows) end = Math.max(end, r.end);
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


/**
 * A run of a family (the Forks view, Provenance's lineage) as the lists see it: with its state as the
 * server's lineage gives it, the run list's own (its kind, outcome and whether it failed, an
 * interrupted run's status), for an attempt the lists leave out too; from an older server that sends
 * none, the run list's when the run is listed. So its icon and line say what Runs and the sidebar
 * say; never another run's.
 */
export function lineageRunLike(n: LineageNode, listed: RunListItem | undefined): RunLike {
  // The lineage's own state when it has one; else the list's.
  const s = n.outcome !== undefined ? { status: n.status, kind: n.kind ?? null, outcome: n.outcome, failed: n.failed } : listed ? { status: listed.status, kind: listed.kind ?? null, outcome: listed.outcome ?? null, failed: listed.failed } : null;
  return {
    runId: n.runId,
    parentRunId: n.parentRunId,
    mode: n.mode,
    status: s?.status ?? n.status,
    divergence: n.divergence,
    command: listed?.command ?? '',
    codeVersion: listed?.codeVersion ?? null,
    startedAt: n.startedAt,
    calls: n.calls,
    spent: n.spent,
    saved: n.saved,
    captured: listed?.captured ?? 0,
    imported: listed?.imported ?? false,
    covers: listed?.covers ?? null,
    source: listed?.source ?? null,
    labels: listed?.labels ?? [],
    origins: n.origins ?? listed?.origins ?? null,
    test: n.test ?? listed?.test ?? null,
    checks: n.checks,
    ...(s ? { kind: s.kind, outcome: s.outcome, ...(typeof s.failed === 'boolean' ? { failed: s.failed } : {}) } : {}),
  };
}

