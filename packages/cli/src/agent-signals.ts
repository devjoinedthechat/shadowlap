import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { isatty } from 'node:tty';
import { inDashboardJob } from './job-events.js';
import { killTree } from './kill-tree.js';

/**
 * Stop signals while the CLI waits on an agent: `run`, `replay`, `test`, the attempts of `blame` and
 * `verify`, and `decisions --from-code`. A signal the CLI hears reaches the agent once, whatever sent
 * it (a Ctrl-C, a dashboard stopping its job, a closed terminal); a second one doesn't wait; the run
 * always ends, as interrupted; and an agent the CLI leaves behind when it exits early is killed.
 *
 * An agent that has the terminal to itself to read from, under `run` and `replay` in a terminal,
 * stays in the CLI's process group: the terminal's Ctrl-C reaches it directly, as it would without
 * Shadowlap, and so do its window size, Ctrl-Z and /dev/tty, which a process in a session of its own
 * can't open (a password prompt, `git` asking for credentials). So does the agent of `run` and
 * `replay` as a dashboard job: the dashboard stops a job by signalling its whole process group, and
 * kills the group, agent included, when it can't wait. Everywhere else the agent leads a group of
 * its own, which the signal is passed on to: no signal reaches it twice, and stopping the group
 * stops what the agent started (`npm start` runs node, `sh -c` its command).
 */

/** Signals that ask a process to stop: Ctrl-C, a supervisor's or a dashboard's stop, a closed terminal. */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** The status a shell reports for a process a signal ended: 128 + the signal's number (130 SIGINT, 129 SIGHUP, 143 SIGTERM). */
export function signalStatus(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

/** A child's exit status as a shell reports it: its code, or 128 + n when signal n ended it. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal ? signalStatus(signal) : 1);
}

/**
 * How long an agent has to end after a stop signal is passed on before what is left of it is killed:
 * less than the 5 seconds a dashboard gives a job before it kills the job's group, the CLI included,
 * which would leave an agent in a group of its own running with nobody to end it.
 */
export const STOP_GRACE_MS = 3_000;

/** Process groups are a POSIX idea: on Windows an agent's whole process tree is ended instead (killTree). */
export const GROUPS = process.platform !== 'win32';

/**
 * Whose process group the agent of `run` or `replay` shares, or null for a group of its own (see the
 * header): a dashboard job's, which the dashboard signals and kills as a whole, or, for an agent that
 * reads this process's stdin, the terminal's, when some standard stream is one, where a Ctrl-C
 * reaches the CLI and the agent alike.
 */
export function sharedGroup(stdinInherited: boolean, env: NodeJS.ProcessEnv = process.env, tty: (fd: number) => boolean = isatty): 'job' | 'terminal' | null {
  if (inDashboardJob(env)) return 'job';
  return stdinInherited && [0, 1, 2].some((fd) => tty(fd)) ? 'terminal' : null;
}

// ------------------------------------------------------------------------------- agents left behind

/** Agents still running, each with whether it leads a process group of its own. */
const tracked = new Map<ChildProcess, boolean>();
let hooked = false;

/**
 * Keeps an agent on the list the exit hook kills: an agent in a group of its own outlives this
 * process, so when the CLI exits before it (a second Ctrl-C under `decisions`, an error while
 * attempts run at once) the hook kills its group, and what it started with it.
 */
export function trackAgent(child: ChildProcess, group: boolean): void {
  if (!hooked) {
    hooked = true;
    process.on('exit', killTracked);
  }
  tracked.set(child, group);
  const forget = () => tracked.delete(child);
  child.once('exit', forget);
  child.once('error', forget);
}

/** The exit hook: every tracked agent still running is killed, with its group. Synchronous, as an exit hook must be. */
export function killTracked(): void {
  for (const [child, group] of tracked) {
    if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL', { group });
  }
  tracked.clear();
}

/** The agents the exit hook would kill now (tests). */
export function trackedAgents(): ChildProcess[] {
  return [...tracked.keys()];
}

// ------------------------------------------------------------------------------------ the handlers

/**
 * Ends this process as the signal would have, after whatever had to be done first: on macOS and
 * Linux by raising it again with no handler left, so a parent shell sees a process the signal ended
 * (status 128 + n, and a `for` loop around the command stops); on Windows, or where the signal is
 * ignored, with exit status 128 + n.
 */
export function exitBySignal(signal: NodeJS.Signals): never {
  // A process a signal ends runs no exit hook: the agents it leaves are killed first.
  killTracked();
  if (process.platform !== 'win32') {
    process.removeAllListeners(signal);
    try {
      process.kill(process.pid, signal);
    } catch {
      // can't signal ourselves: the status says it
    }
  }
  process.exit(signalStatus(signal));
}

export interface AgentStopOptions {
  /** The agent leads a process group of its own (spawned `detached`), which the signal is passed on to. */
  group: boolean;
  /**
   * The agent shares this process's group (see the header): a terminal's, where a Ctrl-C reached it
   * already, so SIGINT is not passed on; or a dashboard job's, whose every stop and kill reaches the
   * whole group, so nothing is.
   */
  shared?: 'job' | 'terminal' | null;
  /** Called on every stop signal, before it is passed on. */
  onSignal?: (signal: NodeJS.Signals) => void;
  /**
   * Called on a second signal while no agent runs any more (the run's judge checks are being asked,
   * the run ended): what must be done before the process ends now (end the run as interrupted).
   * The process then ends as the signal would have ended it.
   */
  abandon?: (signal: NodeJS.Signals) => void;
}

/**
 * The stop signals of one wait on agents, from `start()` until `stop()`: the first is passed on to
 * every agent being waited on, which then has STOP_GRACE_MS to end before it is killed; a second
 * kills them at once; and once no agent runs, a second signal ends the process (`abandon`).
 */
export class AgentStop {
  /** The first stop signal this process heard while waiting, or null. */
  signal: NodeJS.Signals | null = null;
  private readonly agents = new Set<ChildProcess>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly handler = (signal: NodeJS.Signals) => this.heard(signal);
  private listening = false;

  constructor(private readonly o: AgentStopOptions) {}

  /** Starts listening for SIGINT, SIGTERM and SIGHUP. */
  start(): this {
    if (!this.listening) {
      this.listening = true;
      for (const s of STOP_SIGNALS) process.on(s, this.handler);
    }
    return this;
  }

  /** Stops listening, and cancels any kill still to come. */
  stop(): void {
    if (this.listening) {
      this.listening = false;
      for (const s of STOP_SIGNALS) process.off(s, this.handler);
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** An agent to pass signals on to until it exits. A signal heard before it started reaches it at once. */
  add(child: ChildProcess): void {
    this.agents.add(child);
    const gone = () => this.agents.delete(child);
    child.once('exit', gone);
    child.once('error', gone);
    if (this.signal) this.pass(child, this.signal, false);
  }

  /** Whether an agent is still being waited on. */
  get waiting(): boolean {
    return [...this.agents].some(running);
  }

  private heard(signal: NodeJS.Signals): void {
    const again = this.signal !== null;
    this.signal ??= signal;
    this.o.onSignal?.(signal);
    const agents = [...this.agents].filter(running);
    if (!agents.length) {
      // Nothing left to pass it on to: the agent has exited and the run is winding down.
      if (again && this.o.abandon) {
        this.stop();
        this.o.abandon(signal);
        exitBySignal(signal);
      }
      return;
    }
    for (const child of agents) this.pass(child, signal, again);
  }

  private pass(child: ChildProcess, signal: NodeJS.Signals, again: boolean): void {
    const group = this.o.group && GROUPS;
    // The dashboard signalled the job's whole group, the agent with it, and kills the group itself.
    if (this.o.shared === 'job' && !group) return;
    if (this.o.shared === 'terminal' && !group) {
      // The terminal's Ctrl-C reached the agent already, the first and every one after it, as it
      // would without Shadowlap. Anything else is passed on, and a second one doesn't wait.
      if (signal === 'SIGINT') return;
      killTree(child, again ? 'SIGKILL' : signal, { group: false });
    } else {
      killTree(child, again ? 'SIGKILL' : signal, { group });
    }
    if (again) return;
    // An agent that ignores the signal is killed before whoever sent it kills this process. One that
    // shares the terminal is given the time it takes, as without Shadowlap, unless the terminal is gone.
    if (this.o.shared === 'terminal' && !group && signal !== 'SIGHUP') return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (running(child)) killTree(child, 'SIGKILL', { group });
    }, STOP_GRACE_MS);
    timer.unref();
    this.timers.add(timer);
  }
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}
