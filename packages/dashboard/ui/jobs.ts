import { fixJobStatus } from './fixes/model.js';

/**
 * What the job drawer says about a CLI run the dashboard started: its title, how each output line
 * is coloured, and how it ended. No DOM here: the tests import it.
 */

export interface JobLike {
  args: string[];
  done: boolean;
  code: number | null;
  title?: string;
  kind?: string;
  /** What the command reported as its outcome (what `--json` would print). */
  result?: unknown;
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

const FORK_FLAGS = ['--inject', '--override', '--fail-at', '--model', '--prompt-from', '--diverge-at', '--live-tool', '--inject-result'];

/** What the drawer calls a job: "Replaying", "Forking", "Packing". */
export function jobTitle(job: JobLike): string {
  if (job.title) return job.title;
  const [cmd, sub] = job.args;
  switch (cmd) {
    case 'replay':
      if (job.args.includes('--repeat')) return 'Repeating';
      return job.args.some((a) => FORK_FLAGS.includes(a)) ? 'Forking' : 'Replaying';
    case 'pack':
      return 'Packing';
    case 'normalize':
      return 'Adding a normalizer';
    case 'redact':
      return 'Adding a redaction rule';
    case 'export':
      return sub === 'html' ? 'Exporting HTML' : sub === 'har' ? 'Exporting HAR' : sub === 'otel' ? 'Exporting a trace' : sub === 'dataset' ? 'Exporting a dataset' : 'Exporting';
    case 'blame':
      return 'Blaming';
    case 'repair':
      return 'Repairing';
    case 'verify':
      return 'Verifying';
    case 'test':
      return 'Running the tests';
    case 'import':
      return 'Importing a capture';
    case 'calibrate':
      return 'Calibrating';
    case 'gc':
      return 'Cleaning up';
    case 'rm':
      return 'Deleting';
    case 'bisect':
      return 'Finding the commit';
    default:
      return 'Running';
  }
}

/** The command as typed, for the drawer's first line. */
export function jobCommand(args: readonly string[]): string {
  return `shadowlap ${args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}`;
}

export type LineTone = '' | 'p' | 'ok' | 'y' | 'no';

/** How the drawer colours an output line, from the marks the CLI prints. */
export function lineTone(line: string): LineTone {
  const t = line.trimStart();
  if (t.startsWith('$ ')) return 'p';
  if (/^(✓|●)/.test(t)) return 'ok';
  if (/^(✗|error\b|Error\b)/.test(t)) return 'no';
  if (/^(⑂|⚠|!|warning\b)/.test(t)) return 'y';
  // Training: a `tasks score` attempt that missed a check ("3 · ✓ … · ✗ … · 0.33"), as the mock marks it.
  if (/^\d+ · /.test(t) && t.includes('✗')) return 'y';
  return '';
}

/**
 * How a job ended, in the drawer's status line: the outcome first, then the exit code. Worked out
 * from the CLI's own words when the server sends no structured result.
 */
export function jobStatus(job: JobLike, lines: readonly string[], lost = false): { text: string; tone: '' | 'ok' | 'warn' | 'err' } {
  if (lost && !job.done) return { text: 'lost · the dashboard server no longer has this job', tone: 'err' };
  if (!job.done) return { text: 'running', tone: '' };
  // Blame, repair and fix apply say how they came out in their result.
  const fixes = fixJobStatus(job);
  if (fixes) return fixes;
  const all = lines.join('\n');
  const code = job.code;
  if (code === null) return { text: 'stopped', tone: 'err' };
  const exit = `exit ${code}`;
  // Find the commit: whether bisect named the first bad commit.
  if (/^✓ first bad commit /m.test(all)) return { text: `found · ${exit}`, tone: 'ok' };
  if (/^✗ no first bad commit/m.test(all)) return { text: `not found · ${exit}`, tone: 'warn' };
  // `shadowlap test` (Run tests, Update golden, Add normalizer and re-run): the last totals it printed.
  const totals = [...all.matchAll(/^(\d+) passed, (\d+) failed(, \d+ not run: interrupted)?/gm)].at(-1);
  if (totals) {
    // Stopped: the goldens after the one it was replaying didn't run, so the counts are no verdict.
    if (totals[3] || code === 130 || code === 143) return { text: `interrupted · ${exit}`, tone: 'warn' };
    const failed = Number(totals[2]);
    return failed ? { text: `${failed} failed · ${exit}`, tone: 'err' } : { text: `${totals[1]} passed · ${exit}`, tone: code === 0 ? 'ok' : 'err' };
  }
  if (code === 0) {
    if (/check(s)? passed/i.test(all)) return { text: `check passed · ${exit}`, tone: 'ok' };
    if (/Replay clean|Reproduced exactly/.test(all)) return { text: `reproduced · ${exit}`, tone: 'ok' };
    if (/Forked at call/.test(all)) return { text: `forked · ${exit}`, tone: 'ok' };
    return { text: `finished · ${exit}`, tone: 'ok' };
  }
  if (/check(s)? failed/i.test(all)) return { text: `check failed · ${exit}`, tone: 'err' };
  if (/Diverged at call/.test(all) && !/Forked at call/.test(all)) return { text: `diverged · ${exit}`, tone: 'err' };
  if (/the agent process exited with an error|--fail-at/.test(all)) return { text: `agent exited ${code}`, tone: 'warn' };
  return { text: exit, tone: 'err' };
}

/** The last line worth repeating in a toast when a job finishes behind a closed drawer. */
export function lastLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.replace(/^[\s✓✗⑂●!]+/, '').trim();
    if (t) return t.length > 70 ? `${t.slice(0, 69)}…` : t;
  }
  return '';
}

/**
 * What the toast says when a job ends behind a closed drawer: its title and how it came out, in the
 * drawer's status words ("Running the tests finished · 1 failed · exit 1"). When those say no more than
 * the exit code, the last line the job printed says it instead.
 */
export function endToast(job: JobLike, lines: readonly string[]): string {
  const status = jobStatus(job, lines).text;
  const generic = /^(finished · )?exit \d+$/.test(status);
  const last = lastLine(lines);
  return `${jobTitle(job)} finished · ${generic && last ? last : status.replace(/^finished · /, '')}`;
}
