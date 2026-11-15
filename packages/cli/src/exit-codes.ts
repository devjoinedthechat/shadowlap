import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { messageOf } from '@shadowlap/engine';
import { CommanderError } from 'commander';

/**
 * The exit status every command ends with: the contract scripts and CI build on, documented in
 * docs/cli.md under "Exit status".
 *
 *   0      ok: the command did what it was asked, and what it judged passed.
 *   1      failed: a check, gate or test failed, a replay diverged where it may not, verify or
 *          repair rejected the change, or the work could not be finished (a host that didn't answer).
 *   2      usage or configuration: a bad flag or argument, an unknown run, a file it can't read,
 *          an invalid shadowlap.config.json, a live command with no key.
 *   3      inconclusive: a gate that could not decide (unless --inconclusive warn), a budget spent
 *          before a verdict, the provider unavailable.
 *   70     internal error: a bug in shadowlap.
 *   128+n  stopped by signal n: 130 for Ctrl-C (SIGINT), 129 for SIGHUP, 143 for SIGTERM.
 *
 * `run` and `replay` end with the agent's own status when nothing above applies, as the agent would
 * have ended without shadowlap in between (127 for a command not found).
 */
export const EXIT = { ok: 0, failed: 1, usage: 2, inconclusive: 3, internal: 70 } as const;

const require = createRequire(import.meta.url);
/** Where a bug is reported: the package's own `bugs` address. */
const BUGS: string = (require('../package.json') as { bugs?: { url?: string } }).bugs?.url ?? 'the project\'s issue tracker';

/**
 * A failure that is the person's to fix, or a verdict, with the status it ends the command with:
 * what a command throws where it can't go on. `reported` marks one whose message is on the terminal
 * already (commander printed a usage error with the command's help), so the entry point only exits.
 */
export class CliError extends Error {
  readonly reported: boolean;

  constructor(
    readonly exitCode: number,
    message: string,
    options: { cause?: unknown; reported?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.reported = options.reported === true;
  }
}

/** A bad flag or argument, an unknown run, a file that can't be read, a config that isn't valid, a missing key: exit status 2. */
export function usageError(message: string, cause?: unknown): CliError {
  return new CliError(EXIT.usage, message, cause === undefined ? {} : { cause });
}

/** The work ran and the answer is no, or it could not be finished: exit status 1. */
export function failedError(message: string, cause?: unknown): CliError {
  return new CliError(EXIT.failed, message, cause === undefined ? {} : { cause });
}

/** 128 plus the signal's number, as a shell reports a command the signal stopped: 130 for SIGINT, 129 for SIGHUP, 143 for SIGTERM. */
export function signalExit(signal: NodeJS.Signals): number {
  const n = constants.signals[signal];
  return 128 + (typeof n === 'number' ? n : constants.signals.SIGTERM);
}

/** An inconclusive verdict's status: 3, or 0 when `--inconclusive warn` lets it through. */
export function inconclusiveStatus(mode: 'fail' | 'warn' = 'fail'): number {
  return mode === 'warn' ? EXIT.ok : EXIT.inconclusive;
}

// ---- stop signals ----

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
let received: NodeJS.Signals | null = null;
let watching = false;

/**
 * Notes the first stop signal this process gets, for the status it ends with, without changing what
 * the signal does: alone among its listeners, the watcher stands in for the default and ends the
 * process the way the signal would have (a shell then reports 128 + n). A command that handles the
 * signal itself (winding its agents down first) keeps doing so; the watcher only remembers which one
 * it was, and makes it the status the process ends with: a signal that comes once the command has
 * set its own (after verify's verdict, as repair closes its store) still ends it with 128 + n.
 * Called once, by the entry point.
 */
export function watchStopSignals(): void {
  if (watching) return;
  watching = true;
  for (const signal of STOP_SIGNALS) {
    const note = (): void => {
      received ??= signal;
      process.exitCode = signalExit(received);
      if (process.listenerCount(signal) > 1) return;
      process.removeListener(signal, note);
      try {
        process.kill(process.pid, signal);
      } catch {
        // a signal this platform can't send to itself (SIGHUP on Windows): end with its status instead
        process.exit(signalExit(signal));
      }
    };
    process.on(signal, note);
  }
  // A process whose loop has nothing left to do ends without reading a signal still waiting to be
  // read: one more turn reads it, and the signal ends the process (or its status does).
  process.once('beforeExit', () => afterPendingSignals(() => undefined));
}

/**
 * Calls `then` once the event loop has polled for I/O again. A stop signal that comes while the
 * process is busy with synchronous work (git removing repair's worktree after its last verify, a
 * store closing) waits for the loop to read it, and a process that ended first would end with its
 * own status, the signal never read. An immediate queued from an immediate runs on the loop's next
 * turn, after that turn's poll has read the signal: one alone could run in the very turn whose poll
 * had run before the signal came. One that comes after that last poll, in the moment the process
 * exits, still finds it ending with its own status: nothing can read it any later.
 */
export function afterPendingSignals(then: () => void): void {
  setImmediate(() => setImmediate(then));
}

/**
 * Runs the CLI's command to its end, as the entry point does: a stop signal ends the process with
 * 128 + n however the command wound down, and what the command throws is reported with the status
 * the contract gives it, once a signal that came meanwhile has been read (afterPendingSignals), so
 * a signal ends it with 128 + n there too.
 */
export function runToEnd(command: () => Promise<unknown>): void {
  new Promise<unknown>((resolve) => resolve(command())).then(
    () => {
      const signal = stoppedBy();
      if (signal) process.exitCode = signalExit(signal);
    },
    (err: unknown) => afterPendingSignals(() => process.exit(reportError(err))),
  );
}

/**
 * Ends the process on an error nothing caught, as the entry point does: what was thrown is reported
 * with the status the contract gives it, once a signal that came meanwhile has been read
 * (afterPendingSignals), so a signal ends it with 128 + n here too. A closed terminal sends one: its
 * SIGHUP comes with the errors of a terminal that is gone (EIO, reading the keyboard or drawing the
 * screen), and the process ending on the first of those at once ended with 2, not 129. The first
 * error ends it: one more while it waits would end it later, so it is never reported.
 */
export function endUncaught(err: unknown): void {
  afterPendingSignals(() => process.exit(reportError(err)));
}

/** The first stop signal this process got, or null. */
export function stoppedBy(): NodeJS.Signals | null {
  return received;
}

/** The status of a command a stop signal cut short: the signal this process got, else the one named, else Ctrl-C's. */
export function interruptedStatus(signal?: NodeJS.Signals | null): number {
  return signalExit(received ?? signal ?? 'SIGINT');
}

// ---- what was thrown ----

/** Errors a bug makes, not a person: these never carry a message written for the person. */
const FAULTS: ReadonlyArray<new (...args: never[]) => Error> = [TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError];

/** A file it was given, or the store, that can't be read or written: the system's own reason is the message. */
const FILE_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EROFS', 'EEXIST']);

/** A host that didn't answer, at any depth of `cause` (fetch wraps the socket's error in a TypeError). */
const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']);

/** SQLite's result codes for a store that can't be opened or read as one: no access, read-only, damaged, can't open, not a database. */
const SQLITE_UNREADABLE = new Set([3, 8, 11, 14, 23, 26]);
/** SQLite's result codes for a store another process held too long, a full disk or a failed read: the work could not finish. */
const SQLITE_BUSY = new Set([5, 6, 10, 13]);

const codeOf = (err: unknown): unknown => (typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined);

function network(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const code = codeOf(e);
    if (typeof code === 'string' && NETWORK_ERRORS.has(code)) return true;
    if (e.name === 'TimeoutError') return true;
  }
  return false;
}

/**
 * The status for what a command threw. shadowlap raises what a person has to fix as an `Error`
 * with a message written for them (an unknown run, a flag that doesn't parse, a config that isn't
 * valid), or as a {@link CliError} that names its status; a bug surfaces as a TypeError, a
 * RangeError, an assertion or one of Node's internal errors instead. So:
 *
 *   - a CliError: its own status; commander's errors: 2 (0 for --help and --version);
 *   - a file or the store that can't be read or written: 2;
 *   - a host that didn't answer, or a store another process held too long: 1;
 *   - JSON that doesn't parse, from a file or an argument: 2;
 *   - a bug's kind of error, or anything thrown that isn't an Error: 70;
 *   - any other Error: 2, a message for the person.
 */
export function exitCodeOf(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
  if (!(err instanceof Error)) return EXIT.internal;
  const code = codeOf(err);
  if (err.name === 'AbortError') return received ? signalExit(received) : EXIT.failed;
  if (typeof code === 'string' && FILE_ERRORS.has(code)) return EXIT.usage;
  if (network(err)) return EXIT.failed;
  if (code === 'ERR_SQLITE_ERROR') {
    const errcode = (err as { errcode?: unknown }).errcode;
    const primary = typeof errcode === 'number' ? errcode & 0xff : null;
    return primary !== null && SQLITE_UNREADABLE.has(primary) ? EXIT.usage : primary !== null && SQLITE_BUSY.has(primary) ? EXIT.failed : EXIT.internal;
  }
  if (err instanceof SyntaxError && /JSON|Unexpected (token|end|non-whitespace)/.test(err.message)) return EXIT.usage;
  if (typeof code === 'string' && (code.startsWith('ERR_') || code === 'ABORT_ERR')) return EXIT.internal;
  if (FAULTS.some((Fault) => err instanceof Fault)) return EXIT.internal;
  return EXIT.usage;
}

/**
 * Says what was thrown, in one line for a person, and returns the status to end with. A message
 * already on the terminal (commander's) isn't repeated. An internal error says it is a bug, how to
 * see where it happened (`SHADOWLAP_DEBUG=1`, which prints the stack of any error) and where to
 * report it. A command a stop signal cut short ends with the signal's status, whatever it threw.
 */
export function reportError(err: unknown, write: (text: string) => void = (text) => void process.stderr.write(text)): number {
  const status = received ? signalExit(received) : exitCodeOf(err);
  if (err instanceof CliError && err.reported) return status;
  const debug = !!process.env.SHADOWLAP_DEBUG;
  const message = messageOf(err);
  const stack = debug && err instanceof Error && err.stack ? err.stack : null;
  if (stack) write(`${stack}\n`);
  if (status === EXIT.internal) {
    if (!stack) write(`shadowlap: internal error: ${message}\n`);
    write(stack ? `This is a bug in shadowlap: please report it, with the stack above, at ${BUGS}\n` : `This is a bug in shadowlap: run the command again with SHADOWLAP_DEBUG=1 to see where it happened, and report it at ${BUGS}\n`);
  } else if (!stack) write(`shadowlap: ${message}\n`);
  return status;
}
