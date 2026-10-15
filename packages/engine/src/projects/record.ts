import { lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quoteArgv } from '../text.js';
import { readPack } from './folders.js';
import { displayPath, isWithin, realpathOrNull } from './paths.js';

/**
 * Recording from the dashboard. The browser never sends a command line to run, with one exception
 * that already exists for a capture's replay: the agent's own command, which only ever becomes what
 * follows `--` in `shadowlap run -- <command>`. The server builds the arguments here, without a
 * shell, and asks before the first run of a command in a folder: the project list keeps each
 * confirmed (folder, command) pair, with the model server it records through, so the same command
 * there doesn't ask again, unless its model calls would now go somewhere else.
 */

export const COMMAND_LIMITS = Object.freeze({ chars: 4000, args: 200 });

export type ParsedCommand = { ok: true; argv: string[] } | { ok: false; error: string };

/**
 * Shell syntax in the text outside quotes (escaped characters left out) that would change what
 * runs, or with which arguments, if a shell ran the line.
 */
const SHELL_SYNTAX: ReadonlyArray<readonly [RegExp, string]> = [
  [/[|]/, 'a pipe'],
  [/[;&]/, 'chained commands'],
  [/[<>]/, 'a redirection'],
  [/[`]|\$[({]/, 'a substitution'],
  [/\$[A-Za-z0-9_@#!$*?-]/, 'a variable'],
  [/[()]/, 'a subshell'],
  [/[*?[]/, 'a wildcard'],
  [/\{[^{} ]*(?:,|\.\.)[^{} ]*\}/, 'a brace expansion'],
];

/** What follows `$` when a terminal expands it: a name, a digit, a special parameter, `${` or `$(`. */
const EXPANDS = /[A-Za-z0-9_@#!$*?{(-]/;
/** After a backslash outside quotes, characters a Windows path has there: the backslash is kept. */
const PATH_CHAR = /[\p{L}\p{N}._-]/u;

const refuse = (error: string): ParsedCommand => ({ ok: false, error });
const NO_SHELL = 'Shadowlap runs the command without a shell, so';

/**
 * Splits the agent's command into arguments as a terminal on macOS or Linux would, so the line it
 * shows (`quoteArgv`) reads back as the same arguments. No shell runs it, so what only a shell would
 * understand is refused rather than passed on as text: outside quotes a pipe, `&&`, a redirection,
 * `$VAR`, a leading `~`, a wildcard, a comment or a leading `NAME=value`; inside double quotes `$VAR`
 * or a substitution, which a terminal expands there too; `$'…'` and `$"…"`; and a backslash ending
 * the line. Quotes work as in a terminal: single quotes keep text as it is, a backslash makes the
 * next character text (`it'\''s`, `my\ file`, `"say \"hi\""`). One difference, so a Windows path
 * survives: a backslash before a letter, a digit, `.`, `_` or `-` is kept (`C:\agents\run.py`),
 * and two backslashes in a row, one character in a terminal on macOS and Linux but two on Windows,
 * are refused. Spaces and tabs separate arguments. A leading `shadowlap run --` is dropped: it is
 * what the step's command line shows.
 */
export function parseAgentCommand(line: string): ParsedCommand {
  if (line.length > COMMAND_LIMITS.chars) return refuse(`The command is longer than ${COMMAND_LIMITS.chars} characters.`);
  // Control characters (a newline among them) have no place in one command line.
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) return refuse('The command has a line break or a control character in it: give one line.');
  const chars = Array.from(line.replace(/^[ \t]+|[ \t]+$/g, ''));
  const args: string[] = [];
  let current = '';
  let started = false;
  /** The text outside quotes, escaped characters left out: where shell syntax would act. */
  let bare = '';
  const twoBackslashes = refuse(`${NO_SHELL} two backslashes in a row would be one in a terminal on macOS and Linux, and two on Windows. Put the argument in single quotes to keep it as typed.`);
  const expandsInDoubleQuotes = refuse(`${NO_SHELL} a variable or a substitution inside double quotes would not be expanded as in a terminal. Type the value itself, use single quotes to keep the text as it is, or put the command in a script.`);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    if (ch === ' ' || ch === '\t') {
      if (started) args.push(current);
      current = '';
      started = false;
      bare += ' ';
      continue;
    }
    if (ch === "'") {
      const end = chars.indexOf("'", i + 1);
      if (end < 0) return refuse('A single quote is never closed.');
      current += chars.slice(i + 1, end).join('');
      started = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < chars.length && chars[j] !== '"'; j++) {
        const c = chars[j]!;
        const after = chars[j + 1];
        if (c === '\\') {
          if (after === '\\') return twoBackslashes;
          // Inside double quotes a backslash makes `"`, `$` and a backquote text; before anything else it stays, as in a terminal.
          if (after === '"' || after === '$' || after === '`') {
            current += after;
            j++;
          } else current += c;
          continue;
        }
        if (c === '`' || (c === '$' && after !== undefined && EXPANDS.test(after))) return expandsInDoubleQuotes;
        current += c;
      }
      if (j >= chars.length) return refuse('A double quote is never closed.');
      started = true;
      i = j;
      continue;
    }
    if (ch === '\\') {
      if (next === undefined) return refuse(`${NO_SHELL} a backslash at the end would carry the command on to the next line in a terminal. Give the command on one line.`);
      if (next === '\\') return twoBackslashes;
      started = true;
      // Kept before what a Windows path has there; before anything else, the next character is text.
      if (PATH_CHAR.test(next)) {
        current += ch;
        bare += ch;
      } else {
        current += next;
        bare += '_';
        i++;
      }
      continue;
    }
    if (!started && ch === '~') return refuse(`${NO_SHELL} ~ would not mean your home folder. Give the path from the project folder, or in full.`);
    if (!started && ch === '#') return refuse(`${NO_SHELL} a comment would not do what it does in a terminal. Leave it out, or quote the text.`);
    if (ch === '$' && (next === "'" || next === '"')) return refuse(`${NO_SHELL} $'…' and $"…" would not do what they do in a terminal. Put the text in single quotes.`);
    current += ch;
    started = true;
    bare += ch;
  }
  if (started) args.push(current);
  for (const [re, what] of SHELL_SYNTAX) {
    if (re.test(bare)) return refuse(`${NO_SHELL} ${what} would not do what it does in a terminal. Put it in a script and give the script, or quote the text.`);
  }
  // `name=~/x` gets the home folder in bash, as a leading ~ does.
  if (/(?:^| )[A-Za-z_][A-Za-z0-9_]*=~/.test(bare)) return refuse(`${NO_SHELL} ~ would not mean your home folder. Give the path from the project folder, or in full.`);
  // What the step shows in full: `shadowlap run -- <command>`. Pasting that is fine.
  const lead = args[0] === 'npx' ? 1 : 0;
  if (args[lead] === 'shadowlap' && args[lead + 1] === 'run' && args[lead + 2] === '--') args.splice(0, lead + 3);
  if (!args.length) return refuse('Give the command that starts your agent.');
  if (!args[0]) return refuse('The command starts with an empty argument: give the program that starts your agent first.');
  if (args[0] === 'shadowlap' || (args[0] === 'npx' && args[1] === 'shadowlap')) return refuse('Give the command that starts your agent: Shadowlap runs it with shadowlap run.');
  // The step's command for a project on its own model server starts with the upstream; the dashboard sets that itself.
  const upstream = /^(SHADOWLAP_UPSTREAM_[A-Z0-9_]+)=/.exec(args[0]);
  if (upstream) return refuse(`Leave out ${upstream[1]}=…: the dashboard records through the model server init finds in the project. To record through another one, use a terminal.`);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) return refuse(`${NO_SHELL} NAME=value before it would not set a variable. Set it before starting the dashboard, or in a script.`);
  if (args.length > COMMAND_LIMITS.args) return refuse(`The command has more than ${COMMAND_LIMITS.args} arguments.`);
  return { ok: true, argv: args };
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
  /**
   * Variables the job sets for the command, beside the dashboard's own environment: the model
   * server the project points at, as {@link UPSTREAM_ENV}. Empty for a project on a provider's API.
   */
  env: Record<string, string>;
  /** As a terminal shows it: `shadowlap run -- uv run agent.py`. */
  display: string;
  /** The model server it records through ({@link UPSTREAM_ENV}), or null for the provider's API: part of what is confirmed. */
  upstream: string | null;
  /**
   * Set the first time this command runs in this folder, or when its model calls would go somewhere
   * else than when it was confirmed: ask with this before running it, then
   * `ProjectRegistry.confirmCommand(id, plan.argv, { upstream: plan.upstream })`.
   */
  confirm: RecordConfirmation | null;
}

export type RecordPlanResult = { ok: true; plan: RecordPlan } | { ok: false; error: string };

/** A confirmed command matches only exactly: the same arguments, in the same order. */
export function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * A project that talks to its own model server (Ollama, vLLM, a proxy: `OPENAI_BASE_URL` in its
 * `.env` or a base URL in its code) is recorded with this variable naming it, so the sidecar
 * forwards there instead of to the provider's API. `init` prints it before `shadowlap run` in a
 * terminal; the dashboard sets it for the job.
 */
export const UPSTREAM_ENV = 'SHADOWLAP_UPSTREAM_OPENAI';

/** A model server as the project list keeps it, from `init`. */
export interface ModelServer {
  /** Where the project points, credentials removed. */
  url: string;
  /**
   * What recording sets {@link UPSTREAM_ENV} to; null when the address holds credentials (never
   * stored) or isn't a plain http(s) URL, and the dashboard won't record through it.
   */
  upstream: string | null;
  /** Where `init` found it: `OPENAI_BASE_URL in .env`. */
  from: string;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** `SHADOWLAP_UPSTREAM_OPENAI=<url>` as a terminal takes it: only the value is quoted, or it would not set a variable. */
function upstreamAssignment(upstream: string): string {
  return `${UPSTREAM_ENV}=${quoteArgv([upstream])}`;
}

/** An http(s) address recording may forward to: no credentials in it, nothing but the URL. */
export function upstreamUrl(value: unknown): string | null {
  const url = parseUrl(value);
  return url && !url.username && !url.password ? (value as string) : null;
}

/** Query parameters that carry a key or a token (`api_key`, `token`, `sig`): an address with one holds credentials. */
const SECRET_PARAM = /key|token|secret|passw|pwd|auth|credential|signature|^sig$/i;

/**
 * A model server `init` found, as the project list keeps it and `init --json` prints it: never with
 * the credentials its address holds (a user and password, or a key in its query), which are removed
 * from the address shown; such a server gets no upstream, so the dashboard won't record through it.
 */
export function modelServerFinding(server: { url: string; upstream?: string | null; from: string }): ModelServer | null {
  const url = parseUrl(server.url);
  if (!url) return null;
  const params = [...url.searchParams.keys()].filter((k) => SECRET_PARAM.test(k));
  const secret = !!(url.username || url.password || params.length);
  url.username = '';
  url.password = '';
  for (const k of params) url.searchParams.delete(k);
  return { url: secret ? url.toString() : server.url, upstream: secret ? null : upstreamUrl(server.upstream), from: server.from };
}

/** Whether a command was confirmed in a folder: the same arguments, recorded through the same model server. */
export function isConfirmedCommand(confirmed: ReadonlyArray<{ argv: readonly string[]; upstream?: string | null }>, argv: readonly string[], upstream: string | null): boolean {
  return confirmed.some((c) => sameArgv(c.argv, argv) && (c.upstream ?? null) === upstream);
}

/**
 * What recording a typed command in a project's folder takes: the arguments for the job, the
 * variables it sets (the project's model server, when `init` found one), and the confirmation to
 * show first unless this exact command was confirmed in this folder before, through the same model
 * server. The server records the pair once the person confirms (`ProjectRegistry.confirmCommand`).
 */
export function planRecording(
  project: { path: string; confirmed: ReadonlyArray<{ argv: string[]; upstream?: string | null }> },
  line: string,
  options: { home?: string; modelServer?: Pick<ModelServer, 'url' | 'upstream'> | null } = {},
): RecordPlanResult {
  const parsed = parseAgentCommand(line);
  if (!parsed.ok) return parsed;
  const server = options.modelServer ?? null;
  // Without the upstream, the calls meant for that server would go to the provider's API.
  if (server && !server.upstream) return { ok: false, error: `The dashboard can’t record through this project’s model server (${server.url}): its address isn’t a plain http(s) URL, or holds credentials, which Shadowlap never stores. Record it in a terminal with ${UPSTREAM_ENV} set to the server.` };
  const argv = parsed.argv;
  const env: Record<string, string> = server?.upstream ? { [UPSTREAM_ENV]: server.upstream } : {};
  const display = `${server?.upstream ? `${upstreamAssignment(server.upstream)} ` : ''}shadowlap run -- ${quoteArgv(argv)}`;
  const upstream = server?.upstream ?? null;
  const known = isConfirmedCommand(project.confirmed, argv, upstream);
  // Confirmed before, with its model calls going elsewhere (the project's .env changed since): ask again.
  const moved = !known && project.confirmed.some((c) => sameArgv(c.argv, argv));
  const calls = server?.upstream ? `Model calls go to ${server.url}, the model server this project uses.` : 'Model calls go to the real API with your keys, which are never stored.';
  const confirm: RecordConfirmation | null = known
    ? null
    : {
        title: `Run this command in ${displayPath(project.path, options.home ?? homedir())}?`,
        text: `${moved ? 'It ran here before with its model calls going somewhere else, so it asks again.' : 'The first command in a folder asks first.'} Shadowlap starts a local sidecar, runs it once, and records every model and tool call. ${calls}`,
        command: display,
        button: 'Run and record',
      };
  return { ok: true, plan: { args: ['run', '--', ...argv], argv, cwd: project.path, env, display, upstream, confirm } };
}

export type GoldenPathResult =
  | { ok: true; path: string }
  /** `taken`: something is at that path already, a golden or other files; another name is free. */
  | { ok: false; error: string; taken?: boolean };

/**
 * Where the setup keeps its golden, as typed in its last step: a folder inside the project, such as
 * `goldens/triage-inbox`. A bare name goes under `goldens/`, where Tests finds packs. Never absolute,
 * never `..`, never hidden, never a part that starts with a dash (the CLI would read it as an
 * option), plain characters only: `pack` writes there. Given the project's folder, it also checks
 * that no part of the path that exists already is a link out of the folder, so a `goldens` link
 * planted in a checkout can't send the pack somewhere else, and that nothing is there yet: `pack`
 * writes over what it finds, so a golden already there (from an earlier setup, or another
 * recording) is refused, unless it holds `runId` itself, the run being packed again.
 */
export function goldenPath(input: string, options: { folder?: string; runId?: string | null } = {}): GoldenPathResult {
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
    if (s.startsWith('-')) return { ok: false, error: 'A part of the golden’s path can’t start with a dash.' };
    if (!/^[A-Za-z0-9._-]+$/.test(s)) return { ok: false, error: 'Use letters, digits, dots, dashes and underscores in the golden’s path.' };
  }
  const clean = segments.join('/');
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
    const target = join(options.folder, ...segments);
    const there = realpathOrNull(target);
    if (there) {
      if (!statSync(there).isDirectory()) return { ok: false, taken: true, error: `${clean} is a file, so Shadowlap won’t pack there.` };
      const held = readPack(there);
      if (held) {
        if (!options.runId || !held.includes(options.runId)) return { ok: false, taken: true, error: `${clean} already holds a golden. Give this one another name: Shadowlap never packs over a golden.` };
      } else if (readdirSync(there).length) {
        return { ok: false, taken: true, error: `${clean} isn’t empty. Give the golden a folder of its own.` };
      }
    }
  }
  return { ok: true, path: clean };
}

/** A golden name the setup offers first: `goldens/<project id>`. */
export function defaultGolden(projectId: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return `goldens/${slug || 'first-run'}`;
}

/**
 * The golden's path the setup offers, free on disk: `goldens/<project id>`, or `goldens/<project
 * id>-2` and so on when a golden from an earlier setup is there (one holding `runId` is the setup's
 * own, and fine). `goldens/<project id>` when no free one is found, which the pack then refuses.
 */
export function freeGoldenPath(folder: string, projectId: string, runId?: string | null): string {
  const base = defaultGolden(projectId);
  for (let n = 1; n <= 99; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const check = goldenPath(candidate, { folder, runId: runId ?? null });
    if (check.ok) return check.path;
    if (!check.taken) break;
  }
  return base;
}

/** A run id as the setup shows it in commands; the CLI takes any unique prefix. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 10);
}

/**
 * The CLI arguments for each setup step, as the dashboard's jobs run them (each in the project's
 * folder, with `--db` added by the server). Pack and test are two jobs, test after pack. Calibrate
 * runs without `--json`, so its rounds stream into the job's output; its result arrives as the
 * job's `result` event (the object `--json` prints), for `calibrationOutcome`. `init --json`
 * writes its findings to the project list itself.
 */
export const setupJobArgs = {
  inspect: (): string[] => ['init', '--json'],
  calibrate: (runId: string, write = false): string[] => ['calibrate', runId, ...(write ? ['--write'] : [])],
  pack: (runId: string, golden: string): string[] => ['pack', runId, golden],
  test: (golden: string): string[] => ['test', golden],
};

/**
 * The same steps as commands to type in a terminal, as the setup shows them beside each step. A
 * project on its own model server records with {@link UPSTREAM_ENV} before the command, as `init`
 * prints it; `<your model server>` stands in for an address that holds credentials.
 */
export function setupCommands(input: { argv: readonly string[] | null; runId: string | null; golden: string; modelServer?: Pick<ModelServer, 'upstream'> | null }): { inspect: string[]; record: string[]; calibrate: string[]; test: string[] } {
  const run = input.runId ? shortRunId(input.runId) : '<run>';
  const upstream = input.modelServer ? `${input.modelServer.upstream ? upstreamAssignment(input.modelServer.upstream) : `${UPSTREAM_ENV}=<your model server>`} ` : '';
  return {
    inspect: ['shadowlap init'],
    record: [`${upstream}shadowlap run -- ${input.argv?.length ? quoteArgv(input.argv) : '<the command that starts your agent>'}`],
    calibrate: [`shadowlap calibrate ${run} --write`],
    test: [`shadowlap pack ${run} ${input.golden}`, `shadowlap test ${input.golden}`],
  };
}
