import { statSync, watch } from 'node:fs';
import { join, normalize, relative, resolve, sep } from 'node:path';
import { signalExit } from './exit-codes.js';

/**
 * Re-runs something when the project changes, for `shadowlap replay --watch`.
 *
 * The debugging loop is edit, replay, read the diff, edit again, and the prefix before a fork is
 * free every time, so there is no reason to type the command in between. A save made while no
 * replay runs starts one, however many files it touched.
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
  /** The replay: run once as watching starts (`again` false), then after each change. */
  run: (again: boolean) => Promise<void>;
  /**
   * Files the run writes itself wherever they are (the store and its journals, a summary file),
   * relative to `cwd` or absolute: never taken for a change.
   */
  ignore?: readonly string[];
  log: (message: string) => void;
  /** Stops watching and resolves; without it, Ctrl-C ends the process. */
  signal?: AbortSignal;
}

/** How long after a run ends a change to a file that is gone is still taken for one of its own. */
const GONE_GRACE_MS = 1_000;

/**
 * Watches `cwd`, replaying once and then after each change, until the process is interrupted (or
 * `signal` aborts). `replay --watch` ends with Ctrl-C, and the exit code of a loop that runs forever
 * is the shell's business, not a summary's.
 *
 * A replay writes too: the agent's own files (a report, an output folder), what a stubbed or live
 * write leaves, the summary. None of that is a change to replay for, or one save would replay
 * forever. So a change made while a replay runs is taken for its own and dropped (it says so, in
 * case it was a save), and one reported after it ended counts only if the file was written after
 * it ended: the agent read whatever was there before it started.
 */
export function watchAndRerun(opts: WatchOptions): Promise<void> {
  const debounceMs = opts.debounceMs ?? 250;
  const ignored = new Set((opts.ignore ?? []).map((f) => normalize(relative(opts.cwd, resolve(opts.cwd, f)))));
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  /** When the last replay ended, and the files that changed while it ran. */
  let lastEnd = 0;
  let during = new Set<string>();
  let stopped = false;

  const replay = async (again: boolean) => {
    running = true;
    during = new Set();
    try {
      await opts.run(again);
    } finally {
      lastEnd = Date.now();
      running = false;
    }
    if (during.size) {
      const names = [...during].sort();
      const what = names.length === 1 ? names[0] : `${names.length} files (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`;
      opts.log(`${what} changed while the replay ran: taken for the replay's own ${names.length === 1 ? 'write' : 'writes'}, so no replay follows. If it was your edit, save it again.`);
    }
  };

  const fire = async () => {
    if (running || stopped) return;
    await replay(true);
  };

  /** A change reported while no replay runs: one to replay for, or a late report of the last one's own write. */
  const changedSinceLastRun = (filename: string): boolean => {
    try {
      return statSync(join(opts.cwd, filename)).mtimeMs > lastEnd;
    } catch {
      // Gone: removed by the run that just ended (a temporary file), or by the person later on.
      return Date.now() - lastEnd > GONE_GRACE_MS;
    }
  };

  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(opts.cwd, { recursive: true }, (_event, filename) => {
      if (!filename || isIgnored(filename) || ignored.has(normalize(filename))) return;
      if (running) {
        during.add(filename);
        return;
      }
      if (!changedSinceLastRun(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void fire(), debounceMs);
    });
  } catch (err) {
    // Recursive watching is unavailable on some platforms and filesystems; say so rather than
    // silently watching nothing.
    return Promise.reject(new Error(`--watch: cannot watch ${opts.cwd}: ${err instanceof Error ? err.message : String(err)}`));
  }

  return new Promise<void>((resolveWatch, reject) => {
    const close = () => {
      stopped = true;
      watcher.close();
      clearTimeout(timer);
      process.off('SIGINT', exit);
      process.off('SIGTERM', exit);
    };
    // Watching ends on a stop signal, with its status: 130 for Ctrl-C.
    const exit = (signal: NodeJS.Signals) => {
      close();
      process.exit(signalExit(signal));
    };
    watcher.on('error', (err) => {
      close();
      reject(err);
    });
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        close();
        resolveWatch();
      }, { once: true });
    } else {
      process.once('SIGINT', exit);
      process.once('SIGTERM', exit);
    }
    // Watching starts before the first replay, so what that replay writes is known for its own too.
    replay(false).then(
      () => {
        if (!stopped) opts.log(`watching ${opts.cwd} — saving a file replays again. Ctrl-C to stop.`);
      },
      (err: unknown) => {
        close();
        reject(err);
      },
    );
  });
}
