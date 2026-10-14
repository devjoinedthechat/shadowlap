import { watch } from 'node:fs';
import { sep } from 'node:path';

/**
 * Re-runs something when the project changes, for `shadowlap replay --watch`.
 *
 * The debugging loop is edit, replay, read the diff, edit again, and the prefix before a fork is
 * free every time, so there is no reason to type the command in between. A run already in progress
 * is left to finish and one re-run is queued behind it, however many files the save touched.
 */

/** Anything generated, hidden, or vendored: watching it would re-run on Shadowlap's own writes. */
const IGNORED = new Set(['node_modules', '.git', '.shadowlap', 'coverage', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache']);

/**
 * Windows names a path with either separator and allows neither inside a filename, so both split
 * it. POSIX allows a backslash in a filename, where splitting on one would cut a name in half.
 */
const SEPARATORS = sep === '\\' ? /[\\/]/ : /\//;

export function isIgnored(relative: string): boolean {
  return relative.split(SEPARATORS).some((part) => IGNORED.has(part) || (part.startsWith('.') && part !== '.'));
}

export interface WatchOptions {
  cwd: string;
  /** Milliseconds to wait after the last change, so one save does not start several runs. */
  debounceMs?: number;
  onChange: () => Promise<void>;
  log: (message: string) => void;
}

/**
 * Watches `cwd` until the process is interrupted. Never resolves: `replay --watch` ends with Ctrl-C,
 * and the exit code of a loop that runs forever is the shell's business, not a summary's.
 */
export function watchAndRerun(opts: WatchOptions): Promise<never> {
  const debounceMs = opts.debounceMs ?? 250;
  let running = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;

  const fire = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      do {
        queued = false;
        await opts.onChange();
      } while (queued);
    } finally {
      running = false;
    }
  };

  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(opts.cwd, { recursive: true }, (_event, filename) => {
      if (!filename || isIgnored(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void fire(), debounceMs);
    });
  } catch (err) {
    // Recursive watching is unavailable on some platforms and filesystems; say so rather than
    // silently watching nothing.
    return Promise.reject(new Error(`--watch: cannot watch ${opts.cwd}: ${err instanceof Error ? err.message : String(err)}`));
  }

  opts.log(`watching ${opts.cwd} — saving a file replays again. Ctrl-C to stop.`);
  return new Promise<never>((_resolve, reject) => {
    watcher.on('error', (err) => {
      watcher.close();
      reject(err);
    });
    const stop = () => {
      watcher.close();
      clearTimeout(timer);
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
