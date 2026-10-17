import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * Whether the repairer a repair would ask can be asked from this machine, as far as that can be told
 * without asking it, so Repair from here says so before any run is blamed for nothing. Only what is
 * certain is checked: the claude-code repairer runs `claude`, or the program SHADOWLAP_CLAUDE names,
 * and it must be found where a job's command finds it, on the PATH of the environment the
 * dashboard's jobs get (its own). An API repairer's key, sign-in or gateway can't be told without a
 * request; the repair says why one could not be asked.
 */

/**
 * Why the repairer can't be asked, as a sentence for the Repair from here dialog and `fix show`; null
 * when nothing stands in the way. `configured`: shadowlap.config.json names it (otherwise it is the
 * user's own Claude Code, the dashboard's default).
 */
export function repairerProblem(repairer: string, configured: boolean, o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; isFile?: (path: string) => boolean } = {}): string | null {
  if (!/^claude-code(?::|$)/.test(repairer.trim())) return null;
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const named = envValue(env, 'SHADOWLAP_CLAUDE')?.trim() || null;
  if (findProgram(named ?? 'claude', { path: envValue(env, 'PATH') ?? '', pathext: envValue(env, 'PATHEXT') ?? '', platform, isFile: o.isFile ?? isFile })) return null;
  const elsewhere = configured ? 'or have the config name another repairer' : 'or name another repairer in shadowlap.config.json (repair.repairer)';
  const asks = configured ? 'shadowlap.config.json names Claude Code as the repairer' : 'This repair asks your own Claude Code';
  if (named) return `${asks}, and ${named}, which SHADOWLAP_CLAUDE names, was not found: point SHADOWLAP_CLAUDE at Claude Code, ${elsewhere}.`;
  return `${asks}, and claude was not found on this machine: install Claude Code, or set SHADOWLAP_CLAUDE to its path, ${elsewhere}.`;
}

/**
 * Whether a program is found as starting it would find it: a path where it points (an absolute one;
 * the repairer starts in a folder of its own, so a relative one finds nothing), a bare name in each
 * folder of PATH, which on Windows also tries the extensions PATHEXT lists (`claude.cmd`, as npm
 * installs it). Empty and relative PATH entries name the folder it starts in, so they are skipped.
 */
export function findProgram(program: string, o: { path: string; pathext?: string; platform: NodeJS.Platform; isFile: (path: string) => boolean }): boolean {
  const win = o.platform === 'win32';
  const p = win ? win32 : posix;
  // Windows' names ignore case: `.CMD` in PATHEXT finds claude.cmd, which npm installs.
  const exts = win ? ['', ...(o.pathext || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)] : [''];
  const tries = (base: string) => exts.some((ext) => o.isFile(base + ext));
  if (/[\\/]/.test(program) || (win && /^[a-z]:/i.test(program))) return p.isAbsolute(program) && tries(program);
  return o.path
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && p.isAbsolute(d))
    .some((dir) => tries(p.join(dir, program)));
}

/** A variable of `env`, whatever the case of its name: Windows' names ignore case (`Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** A file that is there, and on macOS and Linux one this user may run. */
function isFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
