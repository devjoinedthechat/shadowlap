import { classifyRun, type ClassifiableMeta } from './classify.js';
import type { RunStatus } from './types.js';
import type { Store } from './store.js';

/**
 * How a project's runs stand with its team store, counted by run, as the Runs page, the Overview and
 * the status bar count runs: attempts (`--repeat`, blame's probes, verify's and the error-path presets' attempts) are filed
 * under the run they came from and never counted on their own. A run is only on this machine when
 * it, or an attempt filed under it, isn't in the store's index yet: what the Runs page tags `local`,
 * and what a push of that run sends. Runs still recording (they go when they end) and runs pulled
 * from a pull request's folder (they never go) are left out; a run whose recorder is gone (killed,
 * out of memory) is counted, since a push ends it as interrupted and sends it. Settings → Store,
 * Needs a look, `shadowlap store show` and the summaries of push and pull all say these numbers.
 */
export interface TeamRunCounts {
  /** Runs the store's index lists, as far as this machine knows; attempts filed under their run. */
  inStore: number;
  /** Runs here with something only here: the run itself, or attempts filed under it. */
  onlyLocal: number;
  /** Those runs' ids, newest first, at most the limit asked for. */
  localRuns: string[];
  /** Attempts only here, filed under runs here (counted in `onlyLocal` through their run). */
  localAttempts: number;
  /** Runs queued while they recorded: they go to the store when they end. */
  queued: number;
  /** Runs here that this machine pushed (rather than pulled), in the store's index. */
  pushedHere: number;
  /**
   * Runs here the store's index lists too, pushed from here or pulled: deleting this machine's
   * recordings leaves them in the store.
   */
  listedHere: number;
}

/** The run columns and the few fields of `meta` that say whether a run is an attempt, for every run. */
const RUNS_SQL = `
SELECT r.run_id AS id, r.parent_run_id AS parent, r.status AS status,
       r.meta -> '$.repeat' AS rep, r.meta -> '$.probe' AS probe, r.meta -> '$.verify' AS verify, r.meta -> '$.test' AS test, r.meta -> '$.chaos' AS chaos,
       r.meta ->> '$.blame.rescuedRunId' AS rescued, r.meta ->> '$.imported.pr' AS pr
FROM runs r
ORDER BY r.started_at DESC, r.run_id DESC`;

/** The store's rows for one store: listed in its index (not queued, with an index hash), and what the index says a run was filed under. */
const TEAM_SQL = `
SELECT run_id AS id, state, remote_hash IS NOT NULL AND state != 'queued' AS listed, json_extract(entry, '$.attemptOf') AS attempt_of
FROM team_runs WHERE remote = ?`;

const json = (v: unknown): unknown => {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return undefined;
  }
};

interface Row {
  id: string;
  parent: string | null;
  status: RunStatus;
  pr: boolean;
  /** The run it is filed under, when it is an attempt of a run that is here. */
  under: string | null;
}

/** Every run here, with the run each attempt is filed under: the run it replayed, when that run is here too. */
function runRows(store: Store, ended: ReadonlySet<string>): Row[] {
  const raw = store.query(RUNS_SQL);
  // The fork blame rescued a run with is a probe, but it shows as a fork of its own.
  const rescued = new Set(raw.map((r) => r.rescued).filter((x): x is string => typeof x === 'string'));
  const here = new Set(raw.map((r) => String(r.id)));
  return raw.map((r) => {
    const id = String(r.id);
    const parent = typeof r.parent === 'string' ? r.parent : null;
    const meta: ClassifiableMeta = { repeat: json(r.rep), probe: json(r.probe) as ClassifiableMeta['probe'], verify: json(r.verify), test: json(r.test), chaos: json(r.chaos) };
    const { attemptOf } = classifyRun({ runId: id, parentRunId: parent, mode: 'replay', status: r.status as RunStatus, divergence: null, meta }, { rescued: rescued.has(id) });
    // A recording whose recorder is gone counts as ended: a push ends it, as interrupted, and sends it.
    const status = r.status === 'running' && ended.has(id) ? 'crashed' : (r.status as RunStatus);
    return { id, parent, status, pr: typeof r.pr === 'string' && r.pr !== '', under: attemptOf && here.has(attemptOf) ? attemptOf : null };
  });
}

/** Runs still marked recording whose recorder is gone: a push ends them and sends them. */
export function abandonedRuns(store: Store, now = Date.now()): Set<string> {
  return new Set(store.recordingRuns(now).abandoned.map((a) => a.run.runId));
}

/**
 * Counts a project's runs against one store (`remote`, the store's identity), by run. `limit` caps
 * the ids of runs only here that come back (newest first); the counts are always whole. `ended`:
 * the recordings whose recorder is gone (`abandonedRuns`), when the caller has them already.
 */
export function teamRunCounts(store: Store, remote: string, limit = 500, ended: ReadonlySet<string> = abandonedRuns(store)): TeamRunCounts {
  const runs = runRows(store, ended);
  const team = new Map(store.query(TEAM_SQL, remote).map((t) => [String(t.id), { state: String(t.state), queued: t.state === 'queued', listed: Number(t.listed) === 1, under: typeof t.attempt_of === 'string' ? t.attempt_of : null }]));
  const listed = (id: string) => team.get(id)?.listed === true;
  const byId = new Map(runs.map((r) => [r.id, r]));

  // Attempts only here, by the run they are filed under.
  const localUnder = new Map<string, number>();
  let localAttempts = 0;
  for (const r of runs) {
    if (!r.under || r.status === 'running' || r.pr || listed(r.id)) continue;
    localUnder.set(r.under, (localUnder.get(r.under) ?? 0) + 1);
    localAttempts++;
  }
  const localRuns: string[] = [];
  let onlyLocal = 0;
  for (const r of runs) {
    if (r.under || r.status === 'running' || r.pr) continue;
    if (listed(r.id) && !localUnder.has(r.id)) continue;
    onlyLocal++;
    if (localRuns.length < limit) localRuns.push(r.id);
  }

  // In the store: every run its index lists, but attempts, filed under a run here or in the store.
  // A run that isn't here is an attempt when the push that listed it said so.
  let inStore = 0;
  let queued = 0;
  let pushedHere = 0;
  let listedHere = 0;
  for (const [id, t] of team) {
    const run = byId.get(id);
    const under = run ? run.under : t.under !== null && (byId.has(t.under) || listed(t.under)) ? t.under : null;
    if (under) continue;
    if (t.listed) {
      inStore++;
      if (run) listedHere++;
      if (run && t.state === 'pushed') pushedHere++;
    } else if (t.queued && run?.status === 'running') queued++; // ended since, it goes with the next push; deleted, it goes nowhere
  }
  return { inStore, onlyLocal, localRuns, localAttempts, queued, pushedHere, listedHere };
}
