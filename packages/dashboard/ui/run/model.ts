import type { BlameView, CheckView, RunDetail } from '../api.js';
import type { RunLike } from '../runs.js';
import { modelCallOf } from './calls.js';

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

/** Where blame says the run was lost: the call, model call k of m in its scope, the confidence and the fork it rescued. */
export function blameOf(d: RunDetail): BlameView | null {
  const stored = d.run.meta?.blame;
  const b: BlameView | null = d.blame ?? (stored && stored.outcome === 'blamed' && stored.callNo ? { callNo: stored.callNo, confidence: stored.confidence, rescuedRunId: stored.rescuedRunId, scope: stored.scope ?? null } : null);
  if (!b || !b.callNo) return null;
  if (b.modelCall) return b;
  const modelCall = modelCallOf(d.calls, b.callNo, b.scope);
  return modelCall ? { ...b, modelCall } : b;
}

/** The run's outcome checks, with how many attempts each held in when the server counts them. */
export function checksOf(d: RunDetail): CheckView[] {
  if (d.checks?.length) return d.checks;
  return (d.run.meta?.checks ?? []).map((c) => ({ label: c.label, ok: c.ok }));
}

export { callDetail, callTitle, modelCalls, originOf, resultLine, ticksFor, timelineOf, timeOf, tokensText, turnsOf, type CallLike, type TimelineRow, type Turn } from './calls.js';
