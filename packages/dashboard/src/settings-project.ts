import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { calibrationTarget, commandIsImported, hasRecordedCommand, tildePath, type RunRecord, type StoreOf } from '@shadowlap/engine';
import { countRuns } from './runs-list.js';
import { findRun, type SettingsContext, SettingsRefusal, shortRun } from './settings-shared.js';

/** Settings' Project tab: where the project and its store are, cleaning up old runs, and calibrating a recording. */

export interface ProjectSettings {
  name: string;
  folder: string;
  /** The folder and the store's file as people read them: `~/support-agent/.shadowlap/shadowlap.db` inside the home folder. */
  shown: { folder: string; store: string | null };
  /**
   * The store's file, and its size as the database counts it (its pages, whatever the write-ahead
   * log holds), so it doesn't jump while the log waits for a checkpoint. `free` is what a vacuum
   * gives back.
   */
  store: { path: string | null; bytes: number; free: number };
  /** Runs, not counting the attempts blame, verify and `replay --repeat` make. */
  runs: number;
  attempts: number;
  /** Runs a process is recording now (a recording, or a replay in progress). While one is, a clean-up deletes runs but leaves their blobs for a later one. */
  running: number;
  /** Runs left `running` by a process that stopped without ending them: a clean-up marks them interrupted. */
  abandoned: number;
  address: string | null;
  /**
   * Clean up old runs: the dry run first, whose result event (the GcReport `gc --json` prints)
   * counts the runs (`count`), lists the first 100 and what they free, while the drawer shows what gc
   * prints; then "Delete N runs" (N is `count`) runs cleanupArgv(result), which deletes exactly those
   * runs or, if others match by then, nothing.
   */
  cleanup: { olderThanDays: number; dryRun: string[] };
}

/** Clean up old runs looks this far back unless the page says otherwise. */
export const CLEANUP_DAYS = 30;

export function projectSettings(ctx: SettingsContext): ProjectSettings {
  // Counted as the Runs page and the status bar count them.
  const counts = countRuns(ctx.store);
  const recording = ctx.store.recordingRuns();
  const dbPath = ctx.dbPath && ctx.dbPath !== ':memory:' ? ctx.dbPath : null;
  const size = ctx.store.size();
  return {
    name: ctx.name ?? basename(ctx.cwd),
    folder: ctx.cwd,
    shown: { folder: shownPath(ctx.cwd), store: dbPath ? shownPath(dbPath) : null },
    store: { path: dbPath, bytes: size.bytes, free: size.free },
    runs: counts.runs,
    attempts: counts.attempts,
    running: recording.live.length,
    abandoned: recording.abandoned.length,
    address: ctx.address ?? null,
    cleanup: { olderThanDays: CLEANUP_DAYS, dryRun: ['gc', '--older-than', String(CLEANUP_DAYS), '--dry-run'] },
  };
}

/**
 * The job behind "Delete N runs", from the dry run's result: the same cutoff (and --keep), and its
 * `expect`, which names the runs the dialog promised, so gc deletes exactly those or refuses and
 * deletes nothing when they changed (a run crossed the line meanwhile, or another was deleted).
 */
export function cleanupArgv(dryRun: { cutoff: number | null; keep: number | null; expect: string }): string[] {
  if (dryRun.cutoff === null && dryRun.keep === null) throw new Error('the dry run picked no runs: give it --older-than or --keep');
  if (!/^\d+-[0-9a-f]{16}$/.test(dryRun.expect)) throw new Error('the dry run says no "expect": run it again with this version of shadowlap');
  return ['gc', ...(dryRun.cutoff !== null ? ['--before', String(dryRun.cutoff)] : []), ...(dryRun.keep !== null ? ['--keep', String(dryRun.keep)] : []), '--expect', dryRun.expect];
}

/** A path inside the home folder as `~/…` (reached by its own path or its real one); any other as it is. */
export function shownPath(path: string, home: string = homedir()): string {
  let real: string | null = null;
  try {
    real = realpathSync(home);
  } catch {
    // a home folder that can't be resolved: compare as given
  }
  for (const base of new Set([home, ...(real ? [real] : [])])) {
    const shown = tildePath(path, base);
    if (shown !== path) return shown;
  }
  return path;
}

/**
 * Why `calibrate` can't take this run, in the words the dashboard shows; null when it can. It takes
 * what the Calibrate button offers: a finished recording made here, whose command it runs again
 * offline. A replay or a fork is calibrated through the recording it came from; an import runs
 * someone else's command, or none.
 */
export function notCalibratable(store: StoreOf<'recording'>, run: RunRecord): string | null {
  const id = shortRun(run.runId);
  if (run.mode !== 'record') return `${id} is a replay; calibrate the recording it came from${run.parentRunId ? ` (${shortRun(run.parentRunId)})` : ''}`;
  if (store.recordingRuns().live.some((r) => r.run.runId === run.runId)) return `${id} is still recording; calibrate it once it has ended`;
  if (run.status !== 'completed' && run.status !== 'failed') return `${id} did not finish (${run.status}); calibrate a recording that ran to its end`;
  if (!hasRecordedCommand(run) || commandIsImported(run)) return `${id} was imported, so there is no command recorded here to run again`;
  return null;
}

/** The run a calibrate job takes: the one named, checked, or the one the button offers. */
export function calibrateRun(ctx: Pick<SettingsContext, 'store' | 'setupRunId'>, runRef: string | null | undefined): RunRecord {
  if (runRef) {
    const run = findRun(ctx.store, runRef);
    const why = notCalibratable(ctx.store, run);
    if (why) throw new SettingsRefusal(409, why);
    return run;
  }
  const target = calibrationTarget(ctx.store, { setupRunId: ctx.setupRunId ?? null });
  if (!target) throw new SettingsRefusal(409, 'Record a run first: calibrate replays a finished recording made here');
  return target.run;
}
