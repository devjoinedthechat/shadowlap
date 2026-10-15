import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { displayPath, isWithin, realpathOrNull } from './paths.js';

/**
 * Recording from the dashboard. The browser never sends a command line to run, with one exception
 * that already exists for a capture's replay: the agent's own command, which only ever becomes what
 * follows `--` in `shadowlap run -- <command>`. The server builds the arguments here, without a
 * shell, and asks before the first run of a command in a folder: the project list keeps each
 * confirmed (folder, command) pair, so the same command there doesn't ask again.
 */

export const COMMAND_LIMITS = Object.freeze({ chars: 4000, args: 200 });

export type ParsedCommand = { ok: true; argv: string[] } | { ok: false; error: string };

/** Shell syntax that would change what runs, or with which arguments, if a shell ran the line. */
const SHELL_SYNTAX: ReadonlyArray<readonly [RegExp, string]> = [
  [/[|]/, 'a pipe'],
  [/[;&]/, 'chained commands'],
  [/[<>]/, 'a redirection'],
  [/[`]|\$[({]/, 'a substitution'],
  [/\$[A-Za-z_]/, 'a variable'],
  [/[()]/, 'a subshell'],
  [/[*?[]/, 'a wildcard'],
  [/\{[^{} ]*(?:,|\.\.)[^{} ]*\}/, 'a brace expansion'],
  [/(?:^| )#/, 'a comment'],
];

/**
 * Splits the agent's command into arguments, honouring single and double quotes as the terminal
 * UI's prompt does (backslashes are kept as typed, so Windows paths survive). No shell runs it, so
 * shell syntax outside quotes is refused rather than passed on as literal text: a pipe, `&&`, a
 * redirection, `$VAR`, `~`, a wildcard or a leading `NAME=value` would not do what it does in a
 * terminal. A leading `shadowlap run --` is dropped: it is what the step's command line shows.
 */
export function parseAgentCommand(line: string): ParsedCommand {
  if (line.length > COMMAND_LIMITS.chars) return { ok: false, error: `The command is longer than ${COMMAND_LIMITS.chars} characters.` };
  // Control characters (a newline among them) have no place in one command line.
  if (/[\u0000-\u001f\u007f]/.test(line.replace(/\t/g, ' '))) return { ok: false, error: 'The command has a line break or a control character in it: give one line.' };
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  let bare = '';
  const flush = () => {
    if (started) args.push(current);
    current = '';
    started = false;
  };
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      flush();
      bare += ' ';
    } else {
      if (ch === '~' && !started) return { ok: false, error: 'Shadowlap runs the command without a shell, so ~ would not mean your home folder. Give the path from the project folder, or in full.' };
      current += ch;
      started = true;
      bare += ch;
    }
  }
  if (quote) return { ok: false, error: `A ${quote === '"' ? 'double' : 'single'} quote is never closed.` };
  flush();
  for (const [re, what] of SHELL_SYNTAX) {
    if (re.test(bare)) return { ok: false, error: `Shadowlap runs the command without a shell, so ${what} would not do what it does in a terminal. Put it in a script and give the script, or quote the text.` };
  }
  // What the step shows in full: `shadowlap run -- <command>`. Pasting that is fine.
  const lead = args[0] === 'npx' ? 1 : 0;
  if (args[lead] === 'shadowlap' && args[lead + 1] === 'run' && args[lead + 2] === '--') args.splice(0, lead + 3);
  if (!args.length) return { ok: false, error: 'Give the command that starts your agent.' };
  if (args[0] === 'shadowlap' || (args[0] === 'npx' && args[1] === 'shadowlap')) return { ok: false, error: 'Give the command that starts your agent: Shadowlap runs it with shadowlap run.' };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!)) return { ok: false, error: 'Shadowlap runs the command without a shell, so NAME=value before it would not set a variable. Set it before starting the dashboard, or in a script.' };
  if (args.length > COMMAND_LIMITS.args) return { ok: false, error: `The command has more than ${COMMAND_LIMITS.args} arguments.` };
  return { ok: true, argv: args };
}

/** Arguments as a terminal would take them back: plain words bare, anything else in single quotes. */
export function quoteArgs(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
}

/** The dialog that asks before a command's first run in a folder. */
export interface RecordConfirmation {
  title: string;
  text: string;
  /** `shadowlap run -- uv run agent.py` */
  command: string;
  button: string;
}

export interface RecordPlan {
  /** The CLI arguments the job runs (the server puts `--db <store>` first): `run -- <argv>`. */
  args: string[];
  /** The agent's command, as arguments. */
  argv: string[];
  /** Where it runs: the project's folder. */
  cwd: string;
  /** As a terminal shows it: `shadowlap run -- uv run agent.py`. */
  display: string;
  /** Set the first time this command runs in this folder: ask with this before running it. */
  confirm: RecordConfirmation | null;
}

export type RecordPlanResult = { ok: true; plan: RecordPlan } | { ok: false; error: string };

/** A confirmed command matches only exactly: the same arguments, in the same order. */
export function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * What recording a typed command in a project's folder takes: the arguments for the job, and the
 * confirmation to show first unless this exact command was confirmed in this folder before.
 * The server records the pair once the person confirms (`ProjectRegistry.confirmCommand`).
 */
export function planRecording(project: { path: string; confirmed: ReadonlyArray<{ argv: string[] }> }, line: string, options: { home?: string } = {}): RecordPlanResult {
  const parsed = parseAgentCommand(line);
  if (!parsed.ok) return parsed;
  const argv = parsed.argv;
  const display = `shadowlap run -- ${quoteArgs(argv)}`;
  const known = project.confirmed.some((c) => sameArgv(c.argv, argv));
  const confirm: RecordConfirmation | null = known
    ? null
    : {
        title: `Run this command in ${displayPath(project.path, options.home ?? homedir())}?`,
        text: 'The first command in a folder asks first. Shadowlap starts a local sidecar, runs it once, and records every model and tool call. Model calls go to the real API with your keys, which are never stored.',
        command: display,
        button: 'Run and record',
      };
  return { ok: true, plan: { args: ['run', '--', ...argv], argv, cwd: project.path, display, confirm } };
}

export type GoldenPathResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Where the setup keeps its golden, as typed in its last step: a folder inside the project, such as
 * `goldens/triage-inbox`. A bare name goes under `goldens/`, where Tests finds packs. Never absolute,
 * never `..`, never hidden, plain characters only: `pack` writes there. Given the project's folder,
 * it also checks that no part of the path that exists already is a link out of the folder, so a
 * `goldens` link planted in a checkout can't send the pack somewhere else.
 */
export function goldenPath(input: string, options: { folder?: string } = {}): GoldenPathResult {
  let path = input.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!path) return { ok: false, error: 'Give the golden a folder, such as goldens/first-run.' };
  if (path.length > 200) return { ok: false, error: 'That path is longer than 200 characters.' };
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('~')) return { ok: false, error: 'The golden goes inside the project: give a path such as goldens/first-run.' };
  if (!path.includes('/')) path = `goldens/${path}`;
  const segments = path.split('/');
  if (segments.length > 8) return { ok: false, error: 'That path is too deep.' };
  for (const s of segments) {
    if (!s || s === '.' || s === '..') return { ok: false, error: 'The golden goes inside the project: no empty, . or .. parts.' };
    if (s.startsWith('.')) return { ok: false, error: 'The golden can’t go in a hidden folder.' };
    if (!/^[A-Za-z0-9._-]+$/.test(s)) return { ok: false, error: 'Use letters, digits, dots, dashes and underscores in the golden’s path.' };
  }
  if (options.folder) {
    const root = realpathOrNull(options.folder);
    if (!root) return { ok: false, error: 'The project’s folder doesn’t exist any more.' };
    for (let i = 1; i <= segments.length; i++) {
      const here = join(options.folder, ...segments.slice(0, i));
      let link: boolean;
      try {
        link = lstatSync(here).isSymbolicLink();
      } catch {
        break; // nothing there yet: pack creates the rest inside what was checked
      }
      // A link that leads nowhere yet could lead anywhere by the time pack runs.
      const real = realpathOrNull(here);
      if (!real || !isWithin(real, root)) return { ok: false, error: `${segments.slice(0, i).join('/')} ${link && !real ? 'is a link to nowhere' : 'leads out of the project'}, so Shadowlap won’t pack there.` };
    }
  }
  return { ok: true, path: segments.join('/') };
}

/** A golden name the setup offers first: `goldens/<project id>`. */
export function defaultGolden(projectId: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return `goldens/${slug || 'first-run'}`;
}

/** A run id as the setup shows it in commands; the CLI takes any unique prefix. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 10);
}

/**
 * The CLI arguments for each setup step, as the dashboard's jobs run them (each in the project's
 * folder, with `--db` added by the server). Pack and test are two jobs, test after pack.
 */
export const setupJobArgs = {
  inspect: (): string[] => ['init', '--json'],
  calibrate: (runId: string, write = false): string[] => ['calibrate', runId, ...(write ? ['--write'] : [])],
  pack: (runId: string, golden: string): string[] => ['pack', runId, golden],
  test: (golden: string): string[] => ['test', golden],
};

/** The same steps as commands to type in a terminal, as the setup shows them beside each step. */
export function setupCommands(input: { argv: readonly string[] | null; runId: string | null; golden: string }): { inspect: string[]; record: string[]; calibrate: string[]; test: string[] } {
  const run = input.runId ? shortRunId(input.runId) : '<run>';
  return {
    inspect: ['shadowlap init'],
    record: [`shadowlap run -- ${input.argv?.length ? quoteArgs(input.argv) : '<the command that starts your agent>'}`],
    calibrate: [`shadowlap calibrate ${run} --write`],
    test: [`shadowlap pack ${run} ${input.golden}`, `shadowlap test ${input.golden}`],
  };
}
