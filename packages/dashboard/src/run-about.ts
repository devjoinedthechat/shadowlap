import { aboutOf, type RunAbout, type RunAsk, type Store } from '@shadowlap/engine';
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
  let yes = false;
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

/** An attempt's place among the attempts of its kind bundled under the same run (from 1), as the bundle lists them: oldest first. */
function attemptIndex(index: RunIndex, r: IndexedRun): number | null {
  if (!r.attemptOf || !r.attemptKind) return null;
  const same = (index.attempts.get(r.attemptOf) ?? []).filter((a) => {
    if (a.attemptKind !== r.attemptKind) return false;
    if (r.attemptKind === 'probe') return a.meta.probe?.callNo === r.meta.probe?.callNo;
    if (r.attemptKind === 'verify') return a.meta.verify?.role === r.meta.verify?.role;
    return true;
  });
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

/** One run's about line, by id, or null for a run the index doesn't have. */
export function aboutOfRun(store: Store, index: RunIndex, runId: string): RunAbout | null {
  const r = index.byId.get(runId);
  return r ? (aboutsOf(store, index, [r]).get(r.runId) ?? null) : null;
}
