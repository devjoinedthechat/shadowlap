import { importedRecording, pulledRun } from '../../../engine/src/classify.js';
import { canonicalModel, shortModel } from '../../../engine/src/prices.js';
import { lostRange } from '../../../engine/src/run-verdicts.js';
import { num } from '../format.js';
import { personName } from '../overview/model.js';
import type { BlameView, CallRow, CheckView, LineageNode, RunDetail, RunListItem } from '../types.js';
import { href } from '../route.js';
import { countChecks, type RunLike, type RunType } from '../runs.js';
import type { AttemptInput } from './banner.js';
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
  const checks = meta?.checks?.length ? countChecks(meta.checks) : null;
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

const whole = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);

/** How blame or verify judged an attempt, as its record keeps it: its verdict, or for one kept before attempts had one, whether it passed. */
function keptVerdict(v: { passed?: unknown; verdict?: unknown }): NonNullable<AttemptInput['verdict']> | null {
  if (v.verdict === 'passed' || v.verdict === 'failed' || v.verdict === 'inconclusive') return v.verdict;
  return typeof v.passed === 'boolean' ? (v.passed ? 'passed' : 'failed') : null;
}

/**
 * What made a run an attempt, from its record: one of a blame probe's attempts (`meta.probe`), a
 * verify's (`meta.verify`), or `replay --repeat`'s (`meta.repeat` alone), with the verdict blame or
 * verify kept on it, and which attempt it is of how many were made, as the server counts them
 * (`attemptPlace`); without that count (an older server) it is attempt k, of an unknown number, never
 * of the most that could have been made (`repeat.of`, a gate's limit). Null for any other run, and for
 * a replay an injection test, a model's scoring or an error-path preset made (`meta.injection`,
 * `meta.task`, `meta.chaos`), which carry `meta.repeat` too but are judged by what made them: they keep
 * the fork banner. A run can come from someone else's pack: only well-formed fields count.
 */
export function attemptOf(d: { run: Pick<RunDetail['run'], 'meta'>; attemptPlace?: RunDetail['attemptPlace'] }): AttemptInput | null {
  const m = d.run.meta;
  if (!m || m.injection || m.task || m.chaos) return null;
  const rep = m.repeat && typeof m.repeat === 'object' ? m.repeat : null;
  const place = d.attemptPlace ?? null;
  const k = place ? place.k : whole(rep?.attempt);
  const n = place ? place.n : null;
  if (m.probe && typeof m.probe === 'object') return { kind: 'probe', k, n, callNo: whole(m.probe.callNo), verdict: keptVerdict(m.probe) };
  if (m.verify && typeof m.verify === 'object') return { kind: 'verify', k, n, role: typeof m.verify.role === 'string' ? m.verify.role : null, verdict: keptVerdict(m.verify) };
  if (rep) return { kind: 'repeat', k, n, count: whole(rep.of) };
  return null;
}

/** What the eyebrow calls an attempt, by what made it, as the design's kind words do. */
const ATTEMPT_WORDS: Readonly<Record<AttemptInput['kind'], string>> = { probe: 'blame attempt', verify: 'verify attempt', repeat: 'repeat attempt' };

/**
 * What the eyebrow calls a fork, or an attempt of any kind, as the design's kind words do: the fork
 * blame rescued a run with is its `rescued fork`; an attempt is a `blame attempt`, a `verify
 * attempt` or a `repeat attempt` (one that forked nowhere too); any other fork is `fork @n`, where
 * it forked. Null for any other run, which the eyebrow names by its kind.
 */
export function forkKindWords(d: { run: Pick<RunDetail['run'], 'meta' | 'divergence'>; attemptPlace?: RunDetail['attemptPlace'] }, type: RunType, rescued: boolean): string | null {
  if (type === 'fork' && rescued) return 'rescued fork';
  const a = attemptOf(d);
  if (a) return ATTEMPT_WORDS[a.kind];
  return type === 'fork' && d.run.divergence ? `fork @${d.run.divergence.callNo}` : null;
}

/**
 * Where an attempt's banner leads: back to where it counted, as the design's links do (a probe's to
 * its fix's Blame step, or to the run it probed when no fix keeps it; a verify attempt's to the
 * verdict it counted towards, or the repair whose candidate it tried), and to its bundle, among its
 * family's in the Forks view: all its attempts, when they are several and counted.
 */
export function attemptLinks(d: Pick<RunDetail, 'fix' | 'probeOf' | 'verifyOf'> & { run: Pick<RunDetail['run'], 'runId'> }, a: AttemptInput): Array<{ href: string; label: string }> {
  const out: Array<{ href: string; label: string }> = [];
  if (a.kind === 'probe') {
    const at = a.callNo ?? d.probeOf?.callNo ?? null;
    const to = d.fix ? href.fixes(d.fix.id, 'blame') : d.probeOf ? href.run(d.probeOf.of) : null;
    if (to) out.push({ href: to, label: at !== null ? `Probe #${at} →` : 'Probe →' });
  } else if (a.kind === 'verify') {
    // The server leads to the fix's verdict, or to the repair that tried a candidate it dropped; with no fix, only to the run it replayed.
    const to = d.verifyOf?.href ?? (d.fix ? href.fixes(d.fix.id, 'verify') : null);
    if (to?.startsWith('#/fixes/')) out.push({ href: to, label: /^#\/fixes\/[^/]+\/repair(?:\/|$)/.test(to) ? 'Repair →' : 'Verdict →' });
  }
  out.push({ href: href.run(d.run.runId, null, 'forks'), label: a.n !== null && a.n > 1 ? `All ${num(a.n)} attempts →` : 'Forks →' });
  return out;
}

/**
 * How long the run took, as the header says it; null when nothing timed it. A capture made from
 * files that keep no times (nock and VCR fixtures) imported every call at the same instant: its
 * start and end are when it was imported, so it has no duration to show, rather than "0 ms".
 */
export function runDuration(d: Pick<RunDetail, 'summary' | 'calls'> & { run: Pick<RunDetail['run'], 'meta'> }): number | null {
  const ms = d.summary.durationMs;
  if (ms === null) return null;
  const timed = d.calls.some((c) => c.latencyMs !== null);
  return d.run.meta?.covers?.length && !timed ? null : ms;
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
    test: n.test ?? listed?.test ?? null,
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
 * What blame found: the call the run was lost at (and the two it was lost around or between, when no
 * one call lost it), model call k of m in its scope, the confidence and the fork it rescued; or, when
 * it placed the failure on no call (`unrescuable`, `stopped`), that it ran. Null when the run was never blamed.
 */
export function blameOf(d: Pick<RunDetail, 'blame' | 'calls'> & { run: { meta?: RunDetail['run']['meta'] } }): BlameView | null {
  const stored = d.run.meta?.blame;
  const b: BlameView | null =
    d.blame ??
    (stored && typeof stored === 'object'
      ? {
          callNo: stored.outcome === 'blamed' && typeof stored.callNo === 'number' ? stored.callNo : null,
          range: lostRange(stored.range),
          confidence: stored.confidence ?? null,
          rescuedRunId: stored.rescuedRunId ?? null,
          scope: stored.scope ?? null,
          outcome: stored.outcome === 'blamed' || stored.outcome === 'unrescuable' || stored.outcome === 'stopped' ? stored.outcome : null,
          ...(stored.unsettled === true ? { unsettled: true } : {}),
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
  return (d.run.meta?.checks ?? []).map((c) => ({ label: c.label, ok: c.ok, ...(typeof c.status === 'string' && ['passed', 'failed', 'inconclusive', 'not-applicable'].includes(c.status) ? { status: c.status } : {}) }));
}

export { callDetail, callTitle, conversationLink, modelCalls, originOf, resultLine, ticksFor, timelineOf, timeOf, tokensText, turnCalls, turnsOf, type CallLike, type TimelineRow, type Turn } from './calls.js';
