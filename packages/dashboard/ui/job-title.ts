import { ACTIONS } from './labels.js';

/**
 * What the first look needs of a job: what to call it, what it runs and how to go on following it.
 * How a job ended is `jobs.ts`'s, which loads with the job's drawer. No DOM here: the tests import it.
 */

export interface JobLike {
  args: string[];
  done: boolean;
  code: number | null;
  title?: string;
  kind?: string;
  /** What the command reported as its outcome (what `--json` would print). */
  result?: unknown;
  /** Someone asked it to stop. */
  stopped?: boolean;
}

/** What following a job does after a poll for it failed. */
export type AfterPollError = 'retry' | 'wait' | 'stop' | 'lost';

/**
 * After a failed poll: wait while the server is unreachable and pick the job up again once it is
 * back; stop when the link expired (the page says so); call the job lost when the server no longer
 * has it (it was restarted) or keeps refusing to say.
 */
export function afterPollError(e: { status: number | null; unreachable: boolean; failures: number }): AfterPollError {
  if (e.status === 401) return 'stop';
  if (e.status === 404) return 'lost';
  if (e.unreachable) return 'wait';
  return e.failures >= 5 ? 'lost' : 'retry';
}

/** A command's own options: what follows `--` is the agent's command, with flags of its own. */
export function ownArgs(args: readonly string[]): readonly string[] {
  const end = args.indexOf('--');
  return end < 0 ? args : args.slice(0, end);
}

/** The replay options that change the run at a call: a replay with one of them is a fork. */
const FORK_FLAGS = ['--inject', '--override', '--fail-at', '--model', '--prompt-from', '--diverge-at', '--live-tool', '--inject-result', '--set', '--live-input'];

/** Whether a replay's options fork it at a call (`--inject 17=…`, `--fail-at=19=529`). */
function forks(args: readonly string[]): boolean {
  return ownArgs(args).some((a) => FORK_FLAGS.includes(a.split('=')[0]!));
}

/**
 * A Replay: `replay <run>` with nothing that forks it and no `--repeat`. A policy for the writes or
 * the reads keeps it one (Replay with writes stubbed), and so does the command a capture is replayed with.
 */
export function isPlainReplay(job: Pick<JobLike, 'args'>): boolean {
  const own = ownArgs(job.args);
  return own[0] === 'replay' && !own.includes('--repeat') && !forks(job.args);
}

/** The drawer's title for a command a job runs with no title of its own: the -ing form of its action's name. */
const DOING: Readonly<Record<string, string>> = {
  pack: ACTIONS.packRun.doing,
  normalize: ACTIONS.addNormalizer.doing,
  redact: ACTIONS.addRedactionRule.doing,
  blame: ACTIONS.runBlame.doing,
  repair: ACTIONS.runRepair.doing,
  verify: ACTIONS.runVerify.doing,
  test: ACTIONS.runTests.doing,
  import: ACTIONS.importCapture.doing,
  calibrate: ACTIONS.calibrate.doing,
  bisect: ACTIONS.findBreakingCommit.doing,
  gc: 'Cleaning up',
  rm: 'Deleting',
};

/** Each export's, by what it exports. */
const EXPORTING: Readonly<Record<string, string>> = { html: ACTIONS.exportHtml.doing, har: ACTIONS.exportHar.doing, otel: ACTIONS.exportTrace.doing, dataset: ACTIONS.exportDataset.doing };

/** What the drawer calls a job: "Replaying", "Forking", "Packing", the server's title when it sends one. */
export function jobTitle(job: JobLike): string {
  if (job.title) return job.title;
  const [cmd, sub] = job.args;
  if (cmd === 'replay') return ownArgs(job.args).includes('--repeat') ? ACTIONS.repeat.doing : forks(job.args) ? 'Forking' : ACTIONS.replay.doing;
  if (cmd === 'export') return EXPORTING[sub ?? ''] ?? 'Exporting';
  return DOING[cmd ?? ''] ?? 'Running';
}

/** The command as typed, for the drawer's first line. */
export function jobCommand(args: readonly string[]): string {
  return `shadowlap ${args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}`;
}

/**
 * Whether a job of one of `kinds` (the jobs that run the goldens) is still running, as far as this
 * page follows it: the palette offers no second session meanwhile. A job the server lost is over.
 */
export function jobRunning(jobs: ReadonlyArray<{ job: Pick<JobLike, 'done' | 'kind'>; lost?: boolean }>, kinds: ReadonlySet<string>): boolean {
  return jobs.some((w) => !w.job.done && !w.lost && kinds.has(w.job.kind ?? ''));
}

/** A job as Stop and the status bar's chip read it: whether it runs, and how it uses its working tree. */
export interface RunningJob {
  id: string;
  done: boolean;
  args?: readonly string[];
  title?: string;
  kind?: string;
  stopped?: boolean;
  /** When it started: the chip opens the newest. */
  startedAt?: number;
  worktree?: { use: 'reads' | 'writes'; doing: string } | null;
}

/** What the status bar's chip says and opens. */
export interface JobChipView {
  /** `Forking · running`, `Forked · exit 0`, `2 jobs running`. */
  label: string;
  /** Its name for a screen reader: `Show job: Forking, running`. */
  name: string;
  opens: string;
  running: boolean;
  tone: '' | 'ok' | 'warn' | 'err';
  /** Several running: which, on hover. */
  title?: string;
}
