import { resolve, sep } from 'node:path';
import type { Store } from './store.js';
import type { RunRecord } from './types.js';

/**
 * Where a run's checks come from when it was not given them with `--expect`: the entry under
 * `tests` in shadowlap.config.json for the recording it replays. The CLI judges a replay by that
 * entry, and the dashboard's Run blame blames on it, so both find it here, the same way.
 */

/**
 * The recordings a run replays, nearest first: through the run and its ancestors, the golden
 * `shadowlap test` replayed (`meta.test.golden`, relative to the project) and the pack it was
 * unpacked from (`meta.imported.from`).
 */
export function recordingsOfRun(store: Store, run: RunRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let r: RunRecord | null = run; r && !seen.has(r.runId); r = r.parentRunId ? store.getRun(r.parentRunId) : null) {
    seen.add(r.runId);
    for (const dir of [r.meta?.test?.golden, r.meta?.imported?.from]) if (typeof dir === 'string' && dir) out.push(dir);
  }
  return out;
}

/**
 * The `tests` entry for a recording folder: an exact path wins over a pattern, whose `*` matches
 * within the last part only (`goldens/refund-*`). A relative folder, and every entry, resolve
 * against `configDir`, the folder shadowlap.config.json is in.
 */
export function testsEntryFor<T extends { recording: string }>(entries: readonly T[], recordingDir: string, configDir: string): T | null {
  const target = resolve(configDir, recordingDir).replace(/[\\/]+$/, '');
  let pattern: T | null = null;
  for (const e of entries) {
    const full = resolve(configDir, e.recording).replace(/[\\/]+$/, '');
    if (!full.includes('*')) {
      if (full === target) return e;
      continue;
    }
    const cut = full.lastIndexOf(sep);
    const [dir, last] = [full.slice(0, cut), full.slice(cut + 1)];
    const re = new RegExp(`^${last.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\\\/]*')}$`);
    if (!pattern && target.slice(0, target.lastIndexOf(sep)) === dir && re.test(target.slice(target.lastIndexOf(sep) + 1))) pattern = e;
  }
  return pattern;
}
