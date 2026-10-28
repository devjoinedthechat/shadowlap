import type { SpawnOptions } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * How a command the user gave starts: an agent (`shadowlap run -- npm start`) or an MCP server
 * (`npx -y some-server`). On Windows `npm`, `npx`, `pnpm`, `yarn` and every bin npm installs into
 * node_modules/.bin are batch files (`.cmd`), which Node won't start the way it starts a program: it
 * finds none by its bare name (ENOENT) and refuses one named in full (EINVAL). Such a command runs
 * through cmd.exe, each argument escaped so that it reaches the program as it was given, the way
 * cross-spawn starts one, and escaped twice for a batch file that passes its arguments on, which has
 * cmd.exe read them again (passesArgumentsOn). Everything Node starts by itself starts as before, and
 * nothing changes on other systems.
 */
export function startCommand(command: string, args: readonly string[], options: SpawnOptions, o: { platform?: NodeJS.Platform; exists?: (file: string) => boolean; read?: (file: string) => string | null } = {}): { command: string; args: string[]; options: SpawnOptions } {
  const asGiven = { command, args: [...args], options };
  if ((o.platform ?? process.platform) !== 'win32') return asGiven;
  const env = options.env ?? process.env;
  const cwd = win32.resolve(typeof options.cwd === 'string' ? options.cwd : process.cwd());
  // Looked up as Node looks: on the child's PATH, else this process's.
  const path = envValue(env, 'PATH') ?? envValue(process.env, 'PATH') ?? '';
  const file = batchFile(command, { cwd, path, pathext: envValue(env, 'PATHEXT') ?? envValue(process.env, 'PATHEXT') ?? '', exists: o.exists ?? isFile });
  // A line break ends a cmd.exe command line, so an argument holding one can't be passed through it:
  // that command fails to start as it did before.
  if (!file || args.some((a) => /[\r\n]/.test(a))) return asGiven;
  const twice = passesArgumentsOn(file, o.read ?? batchText);
  const line = [`"${file}"`, ...args.map((a) => cmdArgument(a, twice))].join(' ');
  // This process's cmd.exe, as Node's own `shell` option takes it: never one the child's environment names.
  return { command: envValue(process.env, 'COMSPEC') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { ...options, windowsVerbatimArguments: true } };
}

/**
 * The batch file a command names on Windows, when Node can't start it itself: null when Node finds a
 * program for it (the name as given when it has an extension, else with .com or .exe, in the working
 * directory and then each folder of PATH, as Node looks), or nothing at all. A name without a folder is
 * looked up in the working directory and then on PATH, a path with one where it points. `path` and
 * `pathext` are the values of PATH and PATHEXT.
 */
export function batchFile(command: string, o: { cwd: string; path: string; pathext?: string; exists: (file: string) => boolean }): string | null {
  if (!command) return null;
  const isBatch = (file: string) => /\.(?:bat|cmd)$/i.test(file);
  const dirs = /[\\/]/.test(command) ? [null] : [o.cwd, ...o.path.split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)];
  const base = (dir: string | null) => (dir === null ? win32.resolve(o.cwd, command) : win32.resolve(o.cwd, dir, command));
  const hasExtension = /\.[^.\\/]+$/.test(win32.basename(command));
  // What Node starts by itself; a batch file only when named with its extension, which Node refuses.
  for (const dir of dirs) {
    const b = base(dir);
    const found = [...(hasExtension ? [b] : []), `${b}.com`, `${b}.exe`].find(o.exists);
    if (found) return isBatch(found) ? found : null;
  }
  // Nothing Node can start: a batch file, in the order PATHEXT gives (.bat before .cmd by default).
  const order = (o.pathext || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';');
  const rank = (ext: string) => (order.includes(ext) ? order.indexOf(ext) : order.length);
  const exts = ['.bat', '.cmd'].sort((a, b) => rank(a) - rank(b));
  for (const dir of dirs) {
    const b = base(dir);
    const found = exts.map((e) => `${b}${e}`).find(o.exists);
    if (found) return found;
  }
  return null;
}

/**
 * Whether a batch file has cmd.exe read its arguments a second time, so they are escaped twice: an npm
 * bin in node_modules\.bin, or a file whose text refers to them anywhere but as `"%~1"`. One that
 * passes them on (`%*`, as every bin npm, pnpm and yarn install does, globally too, and npm's own
 * npm.cmd and npx.cmd), or puts one in its line (`%1`, `%~1`, `"%1"`, `%~dp1`), has cmd.exe read it
 * again: escaped once, a quote inside an argument would end its quoting there, or `%~1` would take
 * the quotes off, and a `&` or `|` after it would run what follows as a command of its own; text
 * from production, such as a capture's message `coverage --pack` puts in the agent's command, could
 * run anything. Only `"%~1"`, the argument unquoted and quoted again by the file, is read safely
 * escaped once, and escaped twice would reach its program garbled. `read` gives a file's text, null
 * when it can't be read; such a file is taken to read them again, the safer guess.
 */
export function passesArgumentsOn(file: string, read: (file: string) => string | null): boolean {
  if (/node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)) return true;
  const text = read(file);
  if (text === null || text.includes('%*')) return true;
  // Each reference to an argument, `%1` to `%9`, with `~` and its modifiers (`%~f1`, `%~$PATH:1`) or not.
  for (const m of text.matchAll(/(")?%(~[a-z]*(?:\$[^:%\s]*:)?)?[1-9](")?/gi)) if (!(m[1] && m[2] && m[3])) return true;
  return false;
}

/** A batch file's text, or null when it can't be read or is larger than a launcher would be (1 MiB). */
function batchText(file: string): string | null {
  try {
    return statSync(file).size > 1 << 20 ? null : readFileSync(file, 'latin1');
  } catch {
    return null;
  }
}

/** Characters cmd.exe acts on (http://www.robvanderwoude.com/escapechars.php), each escaped with ^. */
const CMD_SPECIAL = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument on a cmd.exe command line, so the program behind it reads it as given: quoted the way
 * a Windows program splits its command line (backslashes doubled before a quote and at the end, a
 * quote escaped with one), then every character cmd.exe acts on escaped with ^, the quotes included,
 * so cmd.exe passes the argument on as it is (https://qntm.org/cmd). `twice` escapes them twice, for
 * a batch file that passes its arguments through cmd.exe again (passesArgumentsOn).
 */
export function cmdArgument(arg: string, twice = false): string {
  let quoted = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    quoted += ch === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  quoted += `${'\\'.repeat(backslashes * 2)}"`;
  const once = quoted.replace(CMD_SPECIAL, '^$1');
  return twice ? once.replace(CMD_SPECIAL, '^$1') : once;
}

/** A variable of `env`, whatever the case of its name: Windows' names ignore case (`Path`, `ComSpec`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
