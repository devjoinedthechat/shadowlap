import { importedRecording, pulledRun } from '../../../engine/src/classify.js';
import { canonicalModel, shortModel } from '../../../engine/src/prices.js';
import { personName } from '../overview/model.js';
import type { BlameView, CallRow, CheckView, LineageNode, RunDetail, RunListItem } from '../types.js';
import type { RunLike } from '../runs.js';
import { modelCallOf, originOf } from './calls.js';

/**
 * The run page's reading of a run: what to call it, where it forked or was lost, and each call's
 * line in the views. No DOM here.
 */

/**
 * A run's detail as the lists see a run, so the same words and icons apply: with the server's state
 * (its kind, outcome and whether it failed, worked out as the run list works it out), the page reads
 * an interrupted run, a test that forked and passed, or a fix's failing run as Runs does.
 */
export function runLikeOf(d: RunDetail): RunLike {
  const meta = d.run.meta;
  const state = d.state ?? null;
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
    ...(state ? { kind: state.kind, outcome: state.outcome, failed: state.failed } : {}),
  };
}

/**
 * What the eyebrow calls a recording that neither failed nor stopped: one unpacked from a pack
 * someone sent says so; a teammate's pulled from the team store is a recording like any other.
 */
export function recordingWords(r: Pick<RunDetail['run'], 'meta'>): string {
  return r.meta?.imported && !pulledRun(r) ? 'recording · from a pack' : 'recording';
}

/**
 * Who spent what a run pulled from the team store spent, where it was recorded: its author by name
 * ("maya", as Runs' By column names them). Undefined for a run made here, for a capture (whose calls
 * were paid for where that traffic ran), and for a run that names no one, such as one in an HTML
 * copy, which leaves authors out.
 */
export function pulledSpender(r: Pick<RunDetail['run'], 'mode' | 'meta'>): string | undefined {
  if (!pulledRun(r) || importedRecording(r)) return undefined;
  const author = r.meta?.author;
  return typeof author === 'string' && author ? personName(author) : undefined;
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
    test: listed?.test ?? null,
    checks: n.checks,
    ...(s ? { kind: s.kind, outcome: s.outcome, ...(typeof s.failed === 'boolean' ? { failed: s.failed } : {}) } : {}),
  };
}

/**
 * A model as the run page names it in every view: the id without its date stamp (`claude-opus-5`).
 * A call row carries the short name (`opus-5`), which the run's `models` maps; a full id (what a
 * conversation's request named, Provenance's record) is named the same way. Without the map (an older
 * server), a row keeps its short name.
 */
export function modelLabel(models: Readonly<Record<string, string>> | null | undefined, model: string | null | undefined): string | null {
  if (!model) return null;
  return models?.[model] ?? models?.[shortModel(model)] ?? canonicalModel(model).replace(/-\d{8}$/, '');
}

/** The run's call rows with each model call's model named as the page names it (`modelLabel`). */
export function withModelNames(calls: CallRow[], models: Readonly<Record<string, string>> | null | undefined): CallRow[] {
  if (!models || !Object.keys(models).length) return calls;
  return calls.map((c) => {
    const named = c.model ? models[c.model] : undefined;
    return named && named !== c.model ? { ...c, model: named } : c;
  });
}

export function forkAtOf(d: RunDetail): number | null {
  return d.forkAt ?? d.run.divergence?.callNo ?? null;
}

/**
 * The call the strip and Calls flag FORK: where a replay forked. A replay `shadowlap test` made that
 * diverged offline did not fork there, it failed (its banner says where, and the page opens on it):
 * every call from there was refused, so nothing is flagged. One of a golden that may fork went on
 * live from there, and is flagged.
 */
export function forkMarkOf(d: Pick<RunDetail, 'forkAt' | 'calls'> & { run: Pick<RunDetail['run'], 'divergence' | 'meta'> }): number | null {
  const at = d.forkAt ?? d.run.divergence?.callNo ?? null;
  if (at === null || !d.run.meta?.test) return at;
  return d.calls.some((c) => c.callNo >= at && originOf(c) === 'live') ? at : null;
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

export { callDetail, callTitle, conversationLink, modelCalls, originOf, resultLine, ticksFor, timelineOf, timeOf, tokensText, turnCalls, turnsOf, type CallLike, type TimelineRow, type Turn } from './calls.js';
