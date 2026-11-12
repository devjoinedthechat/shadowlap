import { CONFIG_FILE, calibratable, calibrationTarget, configClock, isObject, type ClockMode } from '@shadowlap/engine';
import { type ConfigInfo, form, loadConfigFile, type RuleForm, type RuleRow, ruleRows, type SettingsContext, shortRun } from './settings-shared.js';

/** Settings' Matching tab: the normalizers, as rows a form edits, and the rules a calibration proposed. */

export interface MatchingSettings {
  config: ConfigInfo;
  rules: RuleRow[];
  form: RuleForm;
  /** `explicit`: the file says auto or exact; `error`: it says something else, which loading the config refuses. */
  clock: { mode: ClockMode; explicit: boolean; error: string | null };
  /**
   * The run Calibrate offers first (`calibrationTarget`: the setup's, else the newest it can take)
   * with the job's argv, or none. `recordings`: what its picker lists, the newest it can take, the
   * target among them. The job streams each round and ends with a result event (the object
   * `calibrate --json` prints). When it proposed normalizers, "Add normalizer" adds exactly those,
   * the ones the person just read, without replaying again: addRules(cwd, 'normalize',
   * proposedRules(result), { expect: config.version }), which checks each as `normalize add` does;
   * record each returned event with the run id and `via: 'calibrate'`.
   */
  calibrate: { runId: string | null; source: 'setup' | 'newest' | null; command: string | null; argv: string[] | null; recordings: Array<{ runId: string }> };
}

/** How many recordings Calibrate's picker lists. */
const PICKER_RUNS = 100;

export function matchingSettings(ctx: SettingsContext): MatchingSettings {
  const { info, file } = loadConfigFile(ctx.cwd, 'normalize');
  const written = file?.data.clock;
  const clock = file ? configClock(file) : { mode: 'auto' as const, explicit: false };
  const target = calibrationTarget(ctx.store, { setupRunId: ctx.setupRunId ?? null });
  // An index read of the newest, bounded: no run's calls. The setup's run first where it is older.
  const listed = ctx.store.finishedRecordings(PICKER_RUNS).filter(calibratable);
  const recordings = target && !listed.some((r) => r.runId === target.run.runId) ? [target.run, ...listed] : listed;
  return {
    config: info,
    rules: ruleRows(file, 'normalize'),
    form: form('normalize'),
    clock: { ...clock, error: written === undefined || clock.explicit ? null : `${CONFIG_FILE}: clock must be "auto" or "exact"` },
    calibrate: target
      ? { runId: target.run.runId, source: target.source, command: `shadowlap calibrate ${shortRun(target.run.runId)}`, argv: ['calibrate', target.run.runId], recordings: recordings.map((r) => ({ runId: r.runId })) }
      : { runId: null, source: null, command: null, argv: null, recordings: [] },
  };
}

/**
 * The rules a calibrate result proposed (its `normalizers`), as `addRules` takes them: each one's
 * kind, name, path, pattern and replace, without what else the result says about it (why it was
 * proposed). Anything that is not a rule is left out; addRules checks the rest.
 */
export function proposedRules(result: unknown): Array<Partial<Record<'kind' | 'name' | 'path' | 'pattern' | 'replace', unknown>>> {
  const list = isObject(result) && Array.isArray(result.normalizers) ? result.normalizers : [];
  return list.filter(isObject).map((n) => Object.fromEntries((['kind', 'name', 'path', 'pattern', 'replace'] as const).filter((k) => n[k] !== undefined).map((k) => [k, n[k]])));
}
