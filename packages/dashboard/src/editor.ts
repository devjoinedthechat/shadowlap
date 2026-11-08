import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, normalize, sep } from 'node:path';
import { messageOf } from '@shadowlap/engine';
import { HttpError } from './http.js';
import { within } from './worktree.js';

/**
 * Open in editor (A18): a file of the project opened at a line in the editor `$VISUAL` or `$EDITOR`
 * names, on the machine the dashboard runs on. The editor and how it is run come from the server's
 * environment only; a request names a file in the project folder and a line, which reach the editor
 * only as arguments, never through a shell's reading of them. The value is run as git runs an editor:
 * as it is where it is one program, through `sh -c '<value> "$@"'` where it needs a shell (arguments,
 * quotes). A windowed editor known here takes its own line form (`code --goto <file>:<line>`); any
 * other, `+<line> <file>`. A terminal-only editor has no terminal to run in, so there is none.
 */

/** What reads the editor: the server's environment and platform; tests pass their own, and a spawner. */
export interface EditorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

/** How this machine opens a file at a line: the program, its arguments for a file and a line, and the form the page shows. */
export interface EditorCommand {
  /** The value of `$VISUAL` or `$EDITOR`, as set. */
  value: string;
  /** The program's name, for what the page and the refusals say: `code`, `subl`. */
  name: string;
  /** The arguments that open `file` at `line`, after the value's own. */
  args: (file: string, line: string) => string[];
  /** Run through `sh -c`, as git runs a value with arguments or quotes in it. */
  shell: boolean;
  /** What it runs, as the card's `$` line shows it: `code --goto <file>:<line>`. */
  form: string;
}

const goto = (f: string, l: string) => ['--goto', `${f}:${l}`];
const colon = (f: string, l: string) => [`${f}:${l}`];
const lineFlag = (f: string, l: string) => ['--line', l, f];

/** Windowed editors' own line forms, by program name, from each editor's command line. */
const LINE_FORMS: Readonly<Record<string, (f: string, l: string) => string[]>> = {
  code: goto,
  'code-insiders': goto,
  codium: goto,
  cursor: goto,
  windsurf: goto,
  subl: colon,
  sublime_text: colon,
  zed: colon,
  mate: (f, l) => ['-l', l, f],
  idea: lineFlag,
  pycharm: lineFlag,
  webstorm: lineFlag,
  goland: lineFlag,
  phpstorm: lineFlag,
  rubymine: lineFlag,
  clion: lineFlag,
  rider: lineFlag,
  studio: lineFlag,
  kate: lineFlag,
};

/** Editors that run only in a terminal, which a dashboard's server has none of. */
const TERMINAL_ONLY = new Set(['vi', 'vim', 'nvim', 'view', 'nano', 'pico', 'micro', 'emacs', 'hx', 'helix', 'kak', 'joe', 'ne', 'ed', 'ex', 'mg', 'jed', 'vis', 'mcedit']);

/** Characters that make git run an editor's value through a shell. */
const SHELL_CHARS = /[|&;<>()$`\\"' \t\n*?[#~=%]/;

/** The program a value starts with, as a shell would read its first word: quotes taken off, without its folder or a Windows extension. */
function programOf(value: string): string {
  const v = value.trim();
  const quoted = /^(["'])(.*?)\1/.exec(v);
  const first = quoted ? quoted[2]! : (v.split(/\s+/)[0] ?? '');
  return basename(first.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Whether Windows' spawn can start the program without a shell: an .exe given by its path, or found on PATH. */
function windowsProgram(value: string, env: NodeJS.ProcessEnv): boolean {
  if (/\.exe$/i.test(value) && isAbsolute(value)) return existsSync(value);
  const name = /\.exe$/i.test(value) ? value : `${value}.exe`;
  return (env.PATH ?? env.Path ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

/**
 * How this machine opens an editor at a line, or why it can't: neither variable set, a terminal-only
 * editor, a windowed one with no display to open on (Linux without DISPLAY or WAYLAND_DISPLAY), or,
 * on Windows, a value spawn can't start as it is.
 */
export function editorCommand(o: EditorOptions = {}): EditorCommand | { off: string } {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const value = (env.VISUAL?.trim() || env.EDITOR?.trim()) ?? '';
  if (!value) return { off: 'Open in editor opens a file in the editor $VISUAL or $EDITOR names, and neither is set where the dashboard runs' };
  const name = programOf(value);
  if (TERMINAL_ONLY.has(name)) return { off: `${name} runs in a terminal, and the dashboard has none to open it in: set $VISUAL to a windowed editor, such as code` };
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { off: `there is no display here to open ${name} on` };
  const shell = SHELL_CHARS.test(value);
  if (platform === 'win32' && (shell || !windowsProgram(value, env))) return { off: `${value} can't be started here as it is: set $VISUAL to the editor's program, such as code.exe` };
  const args = LINE_FORMS[name] ?? ((f: string, l: string) => [`+${l}`, f]);
  return { value, name, args, shell, form: [value, ...args('<file>', '<line>')].join(' ') };
}

/** The form the page shows for Open in editor, as meta reports it; null where this machine can't open one. */
export function editorForm(o: EditorOptions = {}): string | null {
  const e = editorCommand(o);
  return 'off' in e ? null : e.form;
}

/** The most lines a file is opened at. */
const MAX_LINE = 10_000_000;

/** A request's line: an integer from 1, formatted here. */
export function editorLine(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > MAX_LINE) throw new HttpError(400, 'line: a line number from 1');
  return raw;
}

/**
 * A request's file, relative to the project folder `root` (a real path): no absolute path, no NUL
 * and no `..` part, then through its real path inside the folder and a regular file. Its real path,
 * and the name the page gave it.
 */
export function projectFile(root: string, raw: unknown): { real: string; name: string } {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw new HttpError(400, 'file: a path relative to the project folder');
  const name = normalize(raw);
  if (name.split(/[\\/]/).includes('..') || name.split(sep).includes('..')) throw new HttpError(400, 'file: a path inside the project folder');
  const path = join(root, name);
  if (!within(root, path)) throw new HttpError(404, `${raw} is not a file in the project folder`);
  const real = realpathSync(path);
  if (!statSync(real).isFile()) throw new HttpError(404, `${raw} is not a file in the project folder`);
  return { real, name: raw };
}

/**
 * Starts the editor at `line` of the file at `real`, in the project folder, and lets it go: detached,
 * its output ignored. Resolves once it has started, or with why it couldn't.
 */
export function openEditor(e: EditorCommand, real: string, line: number, cwd: string, o: EditorOptions = {}): Promise<{ ok: true } | { error: string }> {
  const spawn = o.spawn ?? nodeSpawn;
  const args = e.args(real, String(line));
  const [cmd, argv] = e.shell ? ['sh', ['-c', `${e.value} "$@"`, e.value, ...args]] : [e.value, args];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, argv, { cwd, stdio: 'ignore', detached: true, env: o.env ?? process.env });
      child.on('error', (err) => resolve({ error: `${e.name} could not start: ${err.message}` }));
      child.on('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({ error: `${e.name} could not start: ${messageOf(err)}` });
    }
  });
}
