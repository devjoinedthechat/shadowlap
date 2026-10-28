import { hasRecordedCommand, type RunRecord, type StoredFix } from '@shadowlap/engine';

/**
 * The Fixes flow from the run in front of you: blame finds the model call a failed run was lost at,
 * repair asks the repairer for a change and checks it, verify checks the change in the working
 * directory. Each is the CLI command you'd type, shown before it runs: they replay the run and ask
 * models live, which costs. What a passing run does (`--expect`) starts from what the run or its fix
 * already says, and can be changed; empty means the agent's exit code alone, as the CLI takes it.
 */
export interface FixAction {
  key: 'B' | 'R' | 'V';
  label: string;
  /** The command, in short, on the right of the menu. */
  flag: string;
  hint: string;
  disabled?: string;
  /** The `--expect` JSON it starts from. */
  expect: string;
  build: (expect: string) => string[];
}

export interface FixContext {
  /** The fix that lists the run among its failing runs, if any. */
  fix: StoredFix | null;
  /** Whether the run failed, as its verdict says. */
  failing: boolean;
  /** Whether a process is recording the run right now. */
  recording: boolean;
  /** Whether any run is labelled good: the runs a change must keep passing (`--keeps label:good`). */
  goodRuns: boolean;
}

const asJson = (v: unknown) => (v === undefined || v === null ? '' : JSON.stringify(v));

/** What a passing run does, as far as the run or its fix knows: `replay --expect`'s, else the fix's check. */
export function knownExpect(run: RunRecord, fix: StoredFix | null): string {
  return asJson(run.meta?.expect) || asJson(fix?.check.expect);
}

function why(run: RunRecord, ctx: FixContext): string | undefined {
  if (ctx.recording) return 'once the recording finishes';
  if (!hasRecordedCommand(run)) return 'a capture has no command: replay it with yours first';
  if (!ctx.failing) return 'for a run that failed';
  return undefined;
}

const withExpect = (args: string[], expect: string) => (expect ? [...args, '--expect', expect] : args);

export function fixActions(run: RunRecord, ctx: FixContext): FixAction[] {
  const id = run.runId;
  const disabled = why(run, ctx);
  const keeps = ctx.goodRuns ? ['--keeps', 'label:good'] : [];
  const expect = knownExpect(run, ctx.fix);
  const off = disabled ? { disabled } : {};
  return [
    {
      key: 'B',
      label: 'Find the call it was lost at',
      flag: 'blame',
      hint: 'Replays the run to see it fail, then asks model calls again, live, to find the last one whose answer, asked again, lets it pass.',
      expect,
      build: (e) => withExpect(['blame', id], e),
      ...off,
    },
    {
      key: 'R',
      label: 'Propose a fix and check it',
      flag: `repair${keeps.length ? ' --keeps label:good' : ''}`,
      hint: 'Blames the run if it needs to, asks the repairer (repair.repairer in shadowlap.config.json) for a change, and keeps one only when this run passes under it and the good runs still do. Needs git.',
      expect,
      build: (e) => withExpect(['repair', '--fixes', id, ...keeps], e),
      ...off,
    },
    {
      key: 'V',
      label: 'Check the code here fixes it',
      flag: `verify${keeps.length ? ' --keeps label:good' : ''}`,
      hint: 'Replays this run under the code in the working directory, with the good runs, and accepts the change only when this run now passes and they still do.',
      expect,
      build: (e) => withExpect(['verify', '--fixes', id, ...keeps], e),
      ...off,
    },
  ];
}

/** Whether a typed `--expect` is JSON the CLI will take: an object, or nothing at all. */
export function expectError(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const v: unknown = JSON.parse(value);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? null : '--expect takes a JSON object, such as {"tools":{"send_email":0}}';
  } catch {
    return '--expect takes JSON, such as {"tools":{"send_email":0}}';
  }
}
