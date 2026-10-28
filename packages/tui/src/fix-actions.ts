import { checkStatus, DEFAULT_REPAIRER, fixOfRun, fixRecords, hasRecordedCommand, needsConsent, noFixToTry, recordingsOfRun, repairArgv, repairerProblem, repairJobArgv, selectedRuns, shownBlame, testsEntryFor, verifyArgv, type RunRecord, type Store, type StoredFix } from '@shadowlap/engine';

/**
 * The Fixes flow from the run in front of you, each the CLI command you'd type, shown before it
 * runs, since each replays runs and asks models live, which costs.
 *
 * Blame finds the model call a failed run was lost at, as `shadowlap blame` finds it, judged by the
 * check the dashboard would blame under (packages/dashboard/src/fixes.ts `blameCheckFor`): the run's
 * own `--expect`, the config's for the recording it replays, the fix it fails in, or the agent's
 * exit; a run that failed a check none of those name asks for one, since blaming on the exit alone
 * would look for another failure than the one it had.
 *
 * Repair and verify work on the fix the run fails in, with the engine's builders (fix-jobs.ts), which
 * the dashboard's are: the same command line, the same repairer when the config names none, and the
 * same question, digest-bound, about every run the line selects that came from someone else.
 */
export type FixAction = BlameAction | FixJob;

export interface BlameAction {
  kind: 'blame';
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
  /** The repairer shadowlap.config.json names now, read again each time it is asked for; none: the user's own Claude Code. */
  repairer?: () => string | null;
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
      kind: 'blame',
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
    fixJob(store, run, 'R', ctx),
    fixJob(store, run, 'V', ctx),
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

/** Repair the fix the run fails in (R), or verify a change for it (V). */
export interface FixJob {
  kind: 'repair' | 'verify';
  key: 'R' | 'V';
  label: string;
  flag: string;
  hint: string;
  disabled?: string;
  /** The fix it works on: its short id, as `shadowlap fix` prints it, and its title. */
  fix: { id: string; title: string } | null;
  /** What runs after `shadowlap`, without the `--yes` a yes to the question adds. */
  args: string[];
  /** Who a repair asks for candidates, in words: `your own Claude Code (claude-code)`, `anthropic (from shadowlap.config.json)`. */
  who: string | null;
  /** Why a repair would end “No fix to try” without running the agent, as the dashboard's dialog says it. */
  aside: string | null;
  /** Why the repairer can't be asked from here: nothing runs. */
  blocked: string | null;
  /**
   * The question before it runs, when a run the line selects came from someone else's pack or the
   * team store: its words, and the digest of the lines it shows, which a yes answers. Null: nothing
   * is asked.
   */
  ask: { text: string; confirm: string } | null;
}

const shortFix = (fix: StoredFix) => fix.fixId.slice(0, 13);

/** The fix a run fails in, or null for none (or a store that can't say). */
function fixOf(store: Store, run: RunRecord): StoredFix | null {
  try {
    return fixOfRun(store, run.runId);
  } catch {
    return null;
  }
}

const JOB = {
  R: {
    kind: 'repair',
    label: 'Repair the fix it fails in',
    flag: 'repair',
    hint: 'Blames each failing run (or reuses its blame), asks the repairer to rewrite the prompt or tool descriptions, and keeps the smallest change verify accepts: the failing runs pass, the good runs still do. Writes a patch.',
  },
  V: {
    kind: 'verify',
    label: 'Verify a change for the fix',
    flag: 'verify',
    hint: 'Replays the fix’s failing runs, which your change must now fix, and the good runs it keeps, which it must not leave worse, under the code in your working tree as it is now.',
  },
} as const;

/**
 * Repair (R) or verify (V) from the run in front of you, worked out from the store as it is now: the
 * line the dashboard would run for the run's fix, and what stands in the way. Built again when the
 * user says yes (`settleJob`), so a yes runs only the lines it was shown.
 */
export function fixJob(store: Store, run: RunRecord, key: 'R' | 'V', ctx: FixContext): FixJob {
  return jobOf(store, run, key, ctx).job;
}

/** The job, and every run its line selects (`--fixes`, `--keeps`), which its question is about. */
function jobOf(store: Store, run: RunRecord, key: 'R' | 'V', ctx: FixContext): { job: FixJob; selects: RunRecord[] } {
  const { kind, label, flag, hint } = JOB[key];
  const base: FixJob = { kind, key, label, flag, hint, fix: null, args: [], who: null, aside: null, blocked: null, ask: null };
  const none = (disabled: string, fix: FixJob['fix'] = null) => ({ job: { ...base, fix, disabled }, selects: [] });
  if (ctx.recording) return none('once the recording finishes');
  const fix = fixOf(store, run);
  if (!fix) return none('for a run in a fix: B blames it, which opens one');
  const named = { id: shortFix(fix), title: fix.title };
  if (key === 'R' && fix.status !== 'open') return none(`its fix is ${fix.status} already: a change was verified for it`, named);
  const rec = fixRecords(store, fix);
  const argv = key === 'R' ? repairArgv(store, rec) : verifyArgv(store, rec);
  if (!argv.length) return none('its fix’s check or its blame’s scope can’t go on a command line', named);
  const configured = key === 'R' ? ctx.repairer?.()?.trim() || null : null;
  const args = key === 'R' ? repairJobArgv(argv, configured) : argv;
  // Every run the line will select, as the CLI selects it: a label can bring in an imported run.
  const selects = selectedRuns(store, argv);
  const consent = needsConsent({ runs: selects, yes: undefined, args });
  const job: FixJob = { ...base, fix: named, args, ask: 'ask' in consent ? { text: consent.ask.error, confirm: consent.ask.confirm } : null };
  if (key === 'R') {
    job.who = configured ? `${configured} (from shadowlap.config.json)` : `your own Claude Code (${DEFAULT_REPAIRER})`;
    job.aside = noFixToTry(store, rec, shownBlame(rec)?.scope ?? null);
    job.blocked = repairerProblem(configured ?? DEFAULT_REPAIRER, configured !== null);
  }
  return { job, selects };
}

/**
 * A yes to the job the user was shown (`shown`), answered against the store as it is now: the line
 * to run (with `--yes` when a question was asked and answered), or the job asked again when the line
 * it would run, or the lines the question showed, changed since (a pull, a label, the config's
 * repairer), or why it can't run now.
 */
export function settleJob(store: Store, run: RunRecord, shown: FixJob, ctx: FixContext): { run: string[] } | { again: FixJob } | { refused: string } {
  const { job, selects } = jobOf(store, store.getRun(run.runId) ?? run, shown.key, ctx);
  if (job.disabled) return { refused: job.disabled };
  if (job.blocked) return { refused: job.blocked };
  if (JSON.stringify(job.args) !== JSON.stringify(shown.args)) return { again: job };
  const consent = needsConsent({ runs: selects, yes: shown.ask?.confirm, args: job.args });
  return 'ask' in consent ? { again: job } : { run: [...job.args, ...consent.yes] };
}
