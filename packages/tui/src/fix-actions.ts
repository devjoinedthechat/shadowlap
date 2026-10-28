import { checkStatus, fixOfRun, hasRecordedCommand, recordingsOfRun, testsEntryFor, type RunRecord, type Store } from '@shadowlap/engine';

/**
 * Blame from the run in front of you: the model call a failed run was lost at, found as `shadowlap
 * blame` finds it. It is the CLI command you'd type, shown before it runs, since it replays the run
 * and asks models live, which costs. It is judged by the check the dashboard would blame under
 * (packages/dashboard/src/fixes.ts `blameCheckFor`): the run's own `--expect`, the config's for the
 * recording it replays, the fix it fails in, or the agent's exit; a run that failed a check none of
 * those name asks for one, since blaming on the exit alone would look for another failure than the
 * one it had.
 */
export interface FixAction {
  key: 'B';
  label: string;
  flag: string;
  hint: string;
  disabled?: string;
  /** The check it starts from, as `--expect` JSON; empty for the agent's exit. */
  expect: string;
  /** Where that check came from, in a few words, or why one is needed. */
  from: string;
  /** Whether an empty check is refused: the run failed a check nothing names. */
  needsExpect: boolean;
  build: (expect: string) => string[];
}

export interface FixContext {
  /** Whether the run failed, as its verdict says. */
  failing: boolean;
  /** Whether a process is recording the run right now. */
  recording: boolean;
  /** shadowlap.config.json's `tests` as written, and the folder it is in, for the check a golden's runs are judged by. */
  tests?: unknown;
  configDir?: string | null;
}

export interface BlameCheck {
  expect: Record<string, unknown> | null;
  from: 'replay' | 'config' | 'fix' | 'exit';
}

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `expect` the config's `tests` give the recording a run replays, through its ancestors. */
function configExpect(store: Store, run: RunRecord, tests: unknown, configDir: string): Record<string, unknown> | undefined {
  if (!plainObject(tests)) return undefined;
  const entries = Object.entries(tests).map(([recording, spec]) => ({ recording, spec }));
  for (const dir of recordingsOfRun(store, run)) {
    const entry = testsEntryFor(entries, dir, configDir);
    if (entry) return plainObject(entry.spec) && plainObject(entry.spec.expect) ? entry.spec.expect : undefined;
  }
  return undefined;
}

/** The check a blame of the run can use when nobody names one, in the dashboard's order; null when the run needs one named. */
export function blameCheck(store: Store, run: RunRecord, ctx: Pick<FixContext, 'tests' | 'configDir'> = {}): BlameCheck | null {
  const judged = run.meta?.expect;
  if (plainObject(judged)) return { expect: judged, from: 'replay' };
  const configured = ctx.configDir ? configExpect(store, run, ctx.tests, ctx.configDir) : undefined;
  if (configured) return { expect: configured, from: 'config' };
  const fix = (() => {
    try {
      return fixOfRun(store, run.runId);
    } catch {
      return null;
    }
  })();
  if (fix) return { expect: plainObject(fix.check.expect) ? fix.check.expect : null, from: 'fix' };
  if ((run.meta?.checks ?? []).some((c) => checkStatus(c) === 'failed')) return null;
  if (run.status === 'failed') return { expect: null, from: 'exit' };
  return null;
}

const FROM: Record<BlameCheck['from'], string> = {
  replay: 'the check its replay ran under (--expect)',
  config: 'its golden’s check in shadowlap.config.json',
  fix: 'the check of the fix it fails in',
  exit: 'the agent’s exit: it exited with an error',
};

function why(run: RunRecord, ctx: FixContext): string | undefined {
  if (ctx.recording) return 'once the recording finishes';
  if (!hasRecordedCommand(run)) return 'a capture has no command: replay it with yours first';
  if (!ctx.failing) return 'for a run that failed';
  return undefined;
}

export function fixActions(store: Store, run: RunRecord, ctx: FixContext): FixAction[] {
  const disabled = why(run, ctx);
  const check = disabled ? null : blameCheck(store, run, ctx);
  const expect = check?.expect ? JSON.stringify(check.expect) : '';
  return [
    {
      key: 'B',
      label: 'Find the call it was lost at',
      flag: 'blame',
      hint: 'Replays the run to see it fail, then asks model calls again, live, to find the last one whose answer, asked again, lets it pass.',
      expect,
      from: check ? `judged by ${FROM[check.from]}` : 'it failed a check nothing here names: say what a passing run does',
      needsExpect: !check,
      build: (e) => (e ? ['blame', run.runId, '--expect', e] : ['blame', run.runId]),
      ...(disabled ? { disabled } : {}),
    },
  ];
}

/** Whether a typed `--expect` is JSON the CLI will take: an object, or nothing at all when nothing is needed. */
export function expectError(value: string, needed = false): string | null {
  if (!value.trim()) return needed ? 'say what a passing run does, such as {"tools":{"send_email":0}}: the run failed a check nothing here names' : null;
  try {
    const v: unknown = JSON.parse(value);
    return plainObject(v) ? null : '--expect takes a JSON object, such as {"tools":{"send_email":0}}';
  } catch {
    return '--expect takes JSON, such as {"tools":{"send_email":0}}';
  }
}
