import type { BlameView, CheckView, RunDetail } from '../types.js';
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

/**
 * What blame found: the call the run was lost at, model call k of m in its scope, the confidence and
 * the fork it rescued; or, when it placed the failure on no call (`unrescuable`, `stopped`), that it
 * ran. Null when the run was never blamed.
 */
export function blameOf(d: Pick<RunDetail, 'blame' | 'calls'> & { run: { meta?: RunDetail['run']['meta'] } }): BlameView | null {
  const stored = d.run.meta?.blame;
  const b: BlameView | null =
    d.blame ??
    (stored && typeof stored === 'object'
      ? {
          callNo: stored.outcome === 'blamed' && typeof stored.callNo === 'number' ? stored.callNo : null,
          confidence: stored.confidence ?? null,
          rescuedRunId: stored.rescuedRunId ?? null,
          scope: stored.scope ?? null,
          outcome: stored.outcome === 'blamed' || stored.outcome === 'unrescuable' || stored.outcome === 'stopped' ? stored.outcome : null,
        }
      : null);
  if (!b) return null;
  if (b.callNo === null || b.modelCall) return b;
  const modelCall = modelCallOf(d.calls, b.callNo, b.scope);
  return modelCall ? { ...b, modelCall } : b;
}

/** The run's outcome checks, with how many attempts each held in when the server counts them. */
export function checksOf(d: Pick<RunDetail, 'checks'> & { run: { meta?: RunDetail['run']['meta'] } }): CheckView[] {
  if (d.checks?.length) return d.checks;
  return (d.run.meta?.checks ?? []).map((c) => ({ label: c.label, ok: c.ok }));
}

export { callDetail, callTitle, modelCalls, originOf, resultLine, ticksFor, timelineOf, timeOf, tokensText, turnCalls, turnsOf, type CallLike, type TimelineRow, type Turn } from './calls.js';
