import { aboutOf, runAsk, type CallRecord, type RunAbout, type RunAsk, type Store } from '@shadowlap/engine';
import type { IndexedRun, RunIndex } from './run-index.js';
import { asksFor, asksOf } from './run-stats.js';

/**
 * Each run's about line as every page shows it (decision 10: a run is named by its id, with one
 * quiet line that says what it was): the engine's `aboutOf`, from what the run index holds, its
 * parent's revision, where an attempt sits among its run's attempts, and for a recording the first
 * thing its user asked, kept with its totals (`asksOf`). Worked out from the store the page reads, so
 * an exported copy, made from a redacted copy of its runs, quotes only what that copy holds.
 */

export type { RunAbout } from '@shadowlap/engine';

/** Whether a call of a run was a person's answer (a recorded user input): an override of it changed the user's answer. */
const ANSWERED_SQL = `SELECT 1 AS yes FROM call_events WHERE run_id = ? AND call_no = ? AND phase = 'start' AND json_extract(meta, '$.input') = 1 LIMIT 1`;

/** Answers to ANSWERED_SQL, per store: a recorded call never changes. */
const answeredKept = new WeakMap<Store, Map<string, boolean>>();

function answered(store: Store, parentRunId: string | null, callNo: number | null): boolean {
  if (!parentRunId || callNo === null) return false;
  let kept = answeredKept.get(store);
  if (!kept) answeredKept.set(store, (kept = new Map()));
  const key = `${parentRunId}#${callNo}`;
  const hit = kept.get(key);
  if (hit !== undefined) return hit;
  let yes: boolean;
  try {
    yes = store.query(ANSWERED_SQL, parentRunId, callNo).length > 0;
  } catch {
    yes = false;
  }
  if (kept.size > 20_000) kept.clear();
  kept.set(key, yes);
  return yes;
}

/** The call an `--override` changed, when the run's first change is one. */
function overriddenCall(r: IndexedRun): number | null {
  for (const iv of r.meta.interventions ?? []) {
    const x = iv as { kind?: unknown; at?: unknown };
    if (x.kind === 'writes' || x.kind === 'reads') continue;
    return x.kind === 'override' && typeof x.at === 'number' ? x.at : null;
  }
  return null;
}

/**
 * An attempt's place among the attempts made with it (from 1), as its banner (`attemptPlace`) and the
 * Forks view's bundle number them: those of its kind bundled under the same run (a probe's at the
 * same model call, a verify's of the same role) and, for a probe, the fork blame rescued that run
 * with, one of the probe's attempts though it shows as a fork of its own. An attempt that names the
 * group it was made in (`meta.repeat`: one blame's probe of a call, one verify of a run) is counted
 * in that group alone, in the order its attempts were started; one that names none, oldest first.
 */
function attemptIndex(index: RunIndex, r: IndexedRun): number | null {
  const of = r.attemptOf;
  if (!of || !r.attemptKind) return null;
  const bundled = index.attempts.get(of) ?? [];
  const rescuedId = r.attemptKind === 'probe' ? index.byId.get(of)?.meta.blame?.rescuedRunId : null;
  const rescued = rescuedId ? index.byId.get(rescuedId) : undefined;
  const runs = rescued && rescued.rescues === of && rescued.parentRunId === of ? [...bundled, rescued] : bundled;
  const group = r.meta.repeat?.group || null;
  const same = runs.filter((a) => {
    if (group !== null && a.meta.repeat?.group !== group) return false;
    if (a !== rescued && a.attemptKind !== r.attemptKind) return false;
    if (r.attemptKind === 'probe') return a.meta.probe?.callNo === r.meta.probe?.callNo;
    if (r.attemptKind === 'verify') return a.meta.verify?.role === r.meta.verify?.role;
    return true;
  });
  const started = (a: IndexedRun) => (group !== null ? (a.meta.repeat?.attempt ?? 0) : 0);
  same.sort((a, b) => started(a) - started(b) || a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const i = same.findIndex((a) => a.runId === r.runId);
  return i < 0 ? null : i + 1;
}

/** A run's about line, given what its user asked when it is a recording. */
function about(store: Store, index: RunIndex, r: IndexedRun, ask: RunAsk | null): RunAbout {
  const parent = r.parentRunId ? (index.byId.get(r.parentRunId) ?? null) : null;
  // An attempt whose place can't be told (0) says what it asked again without a number.
  const attempt = r.attemptKind && r.attemptOf ? { kind: r.attemptKind, index: attemptIndex(index, r) ?? 0 } : null;
  return aboutOf({
    kind: r.kind,
    argv: r.argv,
    codeVersion: r.codeVersion,
    parent: parent ? { codeVersion: parent.codeVersion } : null,
    divergence: r.divergence,
    meta: { test: r.meta.test, imported: r.meta.imported, interventions: r.meta.interventions, probe: r.meta.probe, verify: r.meta.verify, repeat: r.meta.repeat, chaos: r.meta.chaos, injection: r.meta.injection, task: r.meta.task },
    attempt,
    rescued: r.rescues !== null,
    answered: r.mode === 'replay' && answered(store, r.parentRunId, overriddenCall(r)),
    ask,
  });
}

/** The about line of each of these runs, by id. */
export function aboutsOf(store: Store, index: RunIndex, runs: readonly IndexedRun[]): Map<string, RunAbout> {
  const asks = asksOf(store, index, runs.filter(asksFor));
  const out = new Map<string, RunAbout>();
  for (const r of runs) if (!out.has(r.runId)) out.set(r.runId, about(store, index, r, asks.get(r.runId) ?? null));
  return out;
}

/**
 * The about lines of these runs as far as they are known, reading no request: what a recording's
 * user asked comes with the run index (`run_asks`) or from memory. The run list's filter matches
 * them on every request, so it never works out what thousands of recordings' users asked while a
 * browser waits; `pending` names the recordings whose ask the warm-up has yet to work out (their
 * about lines are left out, and the filter says matches among them may be missing).
 */
export function knownAbouts(store: Store, index: RunIndex, runs: readonly IndexedRun[]): { abouts: Map<string, RunAbout>; pending: Set<string> } {
  const wanted = runs.filter(asksFor);
  const asks = asksOf(store, index, wanted, { known: true });
  const pending = new Set(wanted.filter((r) => !asks.has(r.runId)).map((r) => r.runId));
  const abouts = new Map<string, RunAbout>();
  for (const r of runs) if (!abouts.has(r.runId) && !pending.has(r.runId)) abouts.set(r.runId, about(store, index, r, asks.get(r.runId) ?? null));
  return { abouts, pending };
}

/** A recording this long or longer is quoted from its first words alone on its page's first answer (`aboutOfRun`). */
const LONG = 1000;

/**
 * One run's about line, by id, or null for a run the index doesn't have. Given the run's calls, a
 * long recording whose user's first words aren't worked out yet is quoted from them alone, as a
 * recording in progress is (its first request), rather than read every request it sent to tell a
 * batch while its page waits: the whole of it is worked out beside the server (read-jobs.ts).
 */
export function aboutOfRun(store: Store, index: RunIndex, runId: string, o: { calls?: readonly CallRecord[] } = {}): RunAbout | null {
  const r = index.byId.get(runId);
  if (!r) return null;
  if (o.calls && asksFor(r) && r.status !== 'running' && r.calls >= LONG && !asksOf(store, index, [r], { known: true }).has(r.runId)) return about(store, index, r, runAsk(store, o.calls));
  return aboutsOf(store, index, [r]).get(r.runId) ?? null;
}
