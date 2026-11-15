import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { messageOf, type Store } from '@shadowlap/engine';
import { HttpError } from './http.js';
import { stepDone, type JobStep } from './job-step.js';
import { isLink } from './links.js';
import type { JobEstimate, JobFile, JobLink, JobListItem, JobView, ProjectView } from './views.js';
import { gitLine, isGitStep, leftConflicts, spawnGit, type GitOutcome, type GitStep } from './job-git.js';
import { jobCommands, treeClash, treeFolder, treeUse, within, type JobTree, type TreeUse } from './worktree.js';

/**
 * Jobs: the CLI runs the dashboard starts. The browser never sends a command line. It names a job
 * kind and its fields (`POST /api/jobs { kind, ... }`); the kind's builder, registered on the
 * server, checks them and returns the CLI arguments. Each feature registers its kinds from its own
 * route module:
 *
 *   ctx.jobs.registerJobKind('blame', {
 *     title: () => 'Blaming',
 *     build: (req, { store }) => {
 *       const run = typeof req.runId === 'string' ? lookupRun(store, req.runId) : null;
 *       if (!run) return { error: 'name the failed run to blame' };
 *       return { args: ['blame', run.runId, '--json'], runId: run.runId };
 *     },
 *   });
 *
 * Besides its output, a job reports what it made on a pipe at fd 3: the CLI writes one JSON object
 * per line there when SHADOWLAP_EVENTS_FD is set (`emitJobEvent` in packages/cli/src/job-events.ts).
 *
 *   {"type":"run","runId":"01K…","role":"new"}      a run it made; role "attempt", "probe" or "verify"
 *                                                    marks an attempt, which is listed but not opened;
 *                                                    any other ("new", "passing", "failing", "imported")
 *                                                    is a run to open, and the last becomes newRunId
 *   {"type":"link","label":"Open fix","href":"#/fixes/fx-…"}   where to go next (dashboard routes only)
 *   {"type":"file","path":".shadowlap/exports/x.jsonl","label":"Dataset"}   a file or folder it wrote
 *   {"type":"result","data":{…}}                     its outcome (what --json prints); the last one is kept
 *
 * A CLI that sends no events still works: a "recording run <id>" or "replaying run <id>" line in
 * its output names the run, as it always did.
 *
 * A project's working tree is one: a job whose command changes the agent's files (repair, fix
 * apply) runs alone in it, and one that runs the agent from them is refused meanwhile (worktree.ts).
 */

export interface SpawnCliOptions {
  /** The CLI's working directory, inside the project. */
  cwd?: string;
  /** Open fd 3 as a pipe and set SHADOWLAP_EVENTS_FD=3, for the job's structured events. */
  events?: boolean;
  /**
   * The store the job reads and writes, for `--db`: the project's it runs in, on a dashboard that
   * serves several. Without it, the spawner's own.
   */
  dbPath?: string;
  /** Variables the job's command gets besides the dashboard's environment (`JobBuild.env`). */
  env?: Record<string, string>;
}

/** Starts the CLI with these arguments (the spawner adds `--db <store>`); stdout and stderr must be pipes. */
export type SpawnCli = (args: string[], options?: SpawnCliOptions) => ChildProcess;

/**
 * The spawner `shadowlap dashboard` and `shadowlap ui` use: this CLI, against the same store,
 * without colours, with the events pipe when a job asks for it. On macOS and Linux each job leads a
 * process group of its own, so stopping it reaches the agent it started too, even one that ignores
 * the signal the CLI passes on.
 */
export function cliSpawner(o: { command: string[]; dbPath?: string; cwd: string; env?: NodeJS.ProcessEnv }): SpawnCli {
  const [cmd, ...pre] = o.command;
  if (!cmd) throw new Error('cliSpawner needs a command');
  return (args, so = {}) => {
    const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), ...(so.env ?? {}), NO_COLOR: '1' };
    delete env.SHADOWLAP_EVENTS_FD;
    if (so.events) env.SHADOWLAP_EVENTS_FD = '3';
    const dbPath = so.dbPath ?? o.dbPath;
    return spawn(cmd, [...pre, ...(dbPath ? ['--db', dbPath] : []), ...args], {
      cwd: so.cwd ?? o.cwd,
      env,
      stdio: so.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      // A group of its own (setsid). Not on Windows, where it would open a console window.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  };
}

/**
 * Signals a job's process group (the CLI and the agent it started), or the process alone when the
 * spawner gave it no group of its own. Windows has neither groups nor a SIGTERM the CLI could pass
 * on (the process is simply ended), so there it ends the job's whole process tree. Called only while
 * the job's process is alive, or (on macOS and Linux) the moment it exits.
 */
function signalJob(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    } catch {
      // taskkill missing: the process alone, below
    }
  }
  if (pid && process.platform !== 'win32') {
    try {
      // A negative pid is the group the job leads. A process group lives on, under the same id, while
      // anything in it does, so this reaches an agent the CLI left behind and nothing else.
      process.kill(-pid, signal);
      return;
    } catch {
      // not a group leader (a spawner that made no group), or the group is gone
    }
  }
  try {
    child.kill(signal);
  } catch {
    // gone already
  }
}

/** The project folder: jobs run here, and files they report must be inside it. */
export type ProjectInfo = ProjectView;

/** The fields of `POST /api/jobs`, untrusted: a builder checks every one it reads. */
export type JobRequest = Record<string, unknown>;

export interface JobBuild {
  /** CLI arguments. Never taken from the request as they are: built from checked fields. */
  args: string[];
  /**
   * Commands to run after `args`, in order, each only when the one before it exited 0: Add
   * normalizer and re-run is `normalize add …`, then `test <golden>`. The output shows each one as
   * `$ shadowlap …` before its lines; the job ends with the exit code of the last command that ran.
   * Each runs where the first does: the job's project, its store, and `env`.
   */
  then?: string[][];
  /**
   * A step the server runs between two of the job's commands, such as Pack with injection gate…'s
   * write of the golden's tests entry once it is packed (job-step's JobStep).
   */
  step?: JobStep;
  /**
   * A git command to run first, in the job's folder (job-git.ts): Revert's `git revert --no-commit`.
   * Built on the server from what the store holds, like the arguments; the CLI's commands run only
   * once it exits 0. Its job holds the working tree as a writer.
   */
  git?: GitStep;
  /** The run the job is about (its full id), if any. */
  runId?: string | null;
  /** The fix it acts on (its full id), if any: a blame of a fix, its repair, verify or apply. */
  fixId?: string;
  /** The working directory, relative to the project folder or absolute inside it. Defaults to the project folder. */
  cwd?: string;
  /** The job makes a run to open when it ends. */
  opensRun?: boolean;
  /** Overrides the kind's title, when the request says more than the kind does. */
  title?: string;
  /**
   * Variables the command gets besides the dashboard's environment, such as the model server a
   * recording forwards to. Built on the server, like the arguments; names are capitals, digits and
   * underscores, and the events pipe's own can't be set.
   */
  env?: Record<string, string>;
  /**
   * Called once the command has started: what the builder keeps only for a job that runs (the
   * setup remembers a command was confirmed), not for one refused after it built (too many jobs,
   * the dashboard stopping) or one whose command couldn't start.
   */
  started?: () => void;
}

/**
 * The estimate a job starts with, as the page showed it on its card and its ask (the request's
 * `estimate`), so its drawer says the same whatever the store does after: only its shape is checked,
 * `usd` a finite amount or null, `ceiling` true or false, `per` a short unit, `stops` a finite
 * amount. Anything else is none, and the job still starts: nothing reads it to decide what runs, and
 * it never reaches the command line.
 */
export function shownEstimate(v: unknown): JobEstimate | null {
  if (typeof v !== 'object' || v === null) return null;
  const { usd, ceiling, per, stops } = v as Record<string, unknown>;
  const amount = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!(usd === null || amount(usd)) || typeof ceiling !== 'boolean') return null;
  if (!(per === undefined || (typeof per === 'string' && per.length <= 40)) || !(stops === undefined || amount(stops))) return null;
  return { usd, ceiling, ...(per === undefined ? {} : { per }), ...(stops === undefined ? {} : { stops }) };
}

/** A job built, or why not: a question asking a yes to a command line carries its `confirm` (consent.ts). */
export type JobBuildResult = JobBuild | { error: string; status?: number; confirm?: string; live?: unknown };

/**
 * Where a job runs: the project that is current when it starts, with its store and the store's
 * path. The job keeps it to the end, so switching projects while it runs changes nothing for it:
 * its files, its runs and its working directory stay that project's.
 */
export interface JobPlace {
  store: Store;
  project: ProjectInfo | null;
  /** The store's path, passed to the spawner for `--db`; null keeps the spawner's own. */
  dbPath: string | null;
  /** The project's id in the dashboard's list; null for a dashboard that serves one store. */
  projectId: string | null;
}

/** What `JobManager.onJob` listeners hear: a job reported a run, or ended. */
export interface JobNotice {
  type: 'run' | 'end';
  /** The job as the API shows it, with its result. */
  job: JobView;
  /** The project it runs in ({@link JobPlace.projectId}). */
  projectId: string | null;
  /** For `run`: the run it reported, with its role. */
  runId?: string;
  role?: string | null;
}

/** What a builder can use besides what its route module closed over. */
export interface JobBuildContext {
  store: Store;
  project: ProjectInfo | null;
  /** The project's id in the dashboard's list, or null ({@link JobPlace.projectId}). */
  projectId: string | null;
  /**
   * A file the browser sent with `POST /api/uploads`, claimed for this job: its path, or null for
   * an unknown id. It is deleted when the job ends.
   */
  /** An upload the job claims; `named`, moved into a folder of its own under the name it arrived with (uploads.ts). */
  upload: (uploadId: unknown, o?: { named?: boolean }) => { path: string; name: string; original?: string | null; bytes: number } | null;
}

export interface JobKind {
  /** What the drawer calls the job: "Blaming", "Importing a capture". */
  title(req: JobRequest): string;
  /** Checks the request and returns the CLI arguments, or why it cannot run. */
  build(req: JobRequest, ctx: JobBuildContext): JobBuildResult | Promise<JobBuildResult>;
}

/** Where uploads come from (`uploads.ts`): claimed by a job's builder, released when it fails, discarded when the job ends. */
export interface UploadSource {
  /** `project`: the one the job runs in; an upload that arrived in another is refused (an HttpError). */
  claim(uploadId: unknown, jobId: string, project?: ProjectInfo | null, o?: { named?: boolean }): { path: string; name: string; original?: string | null; bytes: number } | null;
  release(jobId: string): void;
  discard(jobId: string): void;
}

/** Roles of runs a job made that are attempts, bundled under another run rather than opened. */
const ATTEMPT_ROLES = new Set(['attempt', 'probe', 'verify']);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const RUN_LINE = /(?:recording|replaying) run ([0-9A-Z]{26})/;
const RUN_ID = /^[0-9A-Z]{26}$/;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_LINES = 2000;
const MAX_LINE = 16 * 1024;
const MAX_EVENT = 1024 * 1024;
const MAX_RUNS = 10_000;
const MAX_LINKS = 50;
const MAX_FILES = 100;
/** Jobs remembered (finished ones are forgotten oldest first), and jobs running at once. */
export const KEEP_JOBS = 50;
export const MAX_RUNNING = 16;
/** How long a stopped job has to end before it is killed. */
export const STOP_GRACE_MS = 5000;
/** After the process exits, how long to wait for its pipes to close (a process it left behind may hold them). */
const DRAIN_MS = 2000;

/** What a job is about, as its builder says: the run, the fix, and whether it makes a run to open. */
const subjectOf = (built: JobBuild): Pick<Job, 'runId' | 'fixId' | 'opensRun'> => ({ runId: built.runId ?? null, fixId: built.fixId ?? null, opensRun: built.opensRun ?? false });
/** A job's server step, until it has run, and how many of its commands have started. */
const stepOf = (built: JobBuild): Pick<Job, 'step' | 'ran'> => ({ step: built.step ?? null, ran: 0 });

interface Job {
  id: string;
  kind: string;
  /** The request it was started with, less its yes and its estimate: what Run again builds again (`again`). */
  request: JobRequest;
  title: string;
  args: string[];
  /** What the page showed it would bill as it started it (`shownEstimate`); null for none. */
  estimate: JobEstimate | null;
  /** How it uses its working tree (worktree.ts), while it runs, and that tree's folder through links. */
  worktree: JobTree | null;
  treeAt: string | null;
  /** Commands still to run after the one running now (`JobBuild.then`). */
  rest: string[][];
  /** Its server step, until it has run (`JobBuild.step`), and the commands started so far, which say when it is due. */
  step: JobStep | null;
  ran: number;
  /** Its git step, until it has started (`JobBuild.git`), and what it left once it has ended. */
  git: GitStep | null;
  gitOutcome: GitOutcome | null;
  /** What every command of the job gets besides the dashboard's environment (`JobBuild.env`). */
  env: Record<string, string>;
  runId: string | null;
  fixId: string | null;
  opensRun: boolean;
  cwd: string | null;
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  code: number | null;
  newRunId: string | null;
  sawRunEvent: boolean;
  runs: string[];
  /**
   * Runs the command reported making on fd 3. When it is gone, one still recording has nobody left
   * to end it. (A run only named in the output is not counted: the output could name anyone's.)
   */
  made: Set<string>;
  links: JobLink[];
  files: JobFile[];
  result: unknown;
  lines: string[];
  /** Lines dropped from the front to keep the last MAX_LINES; `after` counts from the first line ever. */
  dropped: number;
  child: ChildProcess | null;
  /** Someone asked it to stop. */
  stopping: boolean;
  /** The CLI process itself has exited (its pipes may still be open). */
  exited: boolean;
  killTimer: NodeJS.Timeout | null;
  /** Resolves when the job is done. */
  ended: Promise<void>;
  markEnded: () => void;
  /** The project it runs in, its store and the store's path, as they were when it started. */
  place: JobPlace;
  /** That project's folder, resolved through links once: files the job reports must be inside it. */
  root?: string | null;
}

/**
 * The CLI's commands that take `--allow-unrecorded`, each replaying a recording: a replay that serves
 * the model's answers again would run a tool the recording never recorded again for real, and they
 * refuse one that writes unless the flag names it (cli/src/unrecorded.ts).
 */
const ALLOWS_UNRECORDED: ReadonlySet<string> = new Set(['replay', 'calibrate', 'blame', 'verify', 'repair', 'test', 'bisect', 'injection', 'serve']);
/** A tool's name as `--allow-unrecorded` takes it among others: one word with no comma, never starting like a flag, nothing hidden in it. */
const TOOL_NAME = /^[^\s,@-][^\s,\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]{0,199}$/u;

/** The tools a Run again allows, checked: one to fifty names, each a tool's. */
function allowedTools(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 50 || !v.every((n): n is string => typeof n === 'string' && TOOL_NAME.test(n))) throw new HttpError(400, 'allowUnrecorded names the tools to allow, as the CLI named them: one to fifty names, each one word with no comma');
  return [...new Set(v)];
}

/**
 * A job built, its commands that replay a recording (ALLOWS_UNRECORDED) given `--allow-unrecorded`
 * with the tools, before their `--` so the flag is shadowlap's and not the agent's. Refused where it
 * runs no such command: it has no tool to allow.
 */
function allowing(built: JobBuild, tools: readonly string[]): JobBuild {
  let any = false;
  const add = (args: string[]): string[] => {
    if (!ALLOWS_UNRECORDED.has(args[0] ?? '')) return args;
    any = true;
    const at = args.indexOf('--');
    const flag = ['--allow-unrecorded', tools.join(',')];
    return at < 0 ? [...args, ...flag] : [...args.slice(0, at), ...flag, ...args.slice(at)];
  };
  const out = { ...built, args: add(built.args), ...(built.then ? { then: built.then.map(add) } : {}) };
  if (!any) throw new HttpError(400, 'this job runs no command that replays a recording, so it has no tool to allow');
  return out;
}

/** Names a job's command may set (`JobBuild.env`): not the events pipe's, which the spawner sets. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

function checkedEnv(env: unknown): Record<string, string> {
  if (env === undefined) return {};
  if (typeof env !== 'object' || env === null || Array.isArray(env)) throw new Error('env must map names to values');
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || name === 'SHADOWLAP_EVENTS_FD') throw new Error(`env: ${name.slice(0, 64)} can't be set for a job`);
    if (typeof value !== 'string' || value.includes('\0') || value.length > 8192) throw new Error(`env: ${name} must be a short string`);
    out[name] = value;
  }
  return out;
}

/**
 * Splits a stream into lines, each cut at `max` characters, whether it arrived in one chunk or many.
 * Returns a flush for the end.
 */
export function lines(stream: Readable | null | undefined, max: number, onLine: (line: string, cut: boolean) => void): () => void {
  let buffer = '';
  let cutting = false;
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (cutting) cutting = false;
      else if (line.length > max) onLine(line.slice(0, max), true);
      else onLine(line.replace(/\r$/, ''), false);
    }
    if (buffer.length > max) {
      if (!cutting) onLine(buffer.slice(0, max), true);
      cutting = true;
      buffer = '';
    }
  });
  // A destroyed pipe (a job stopped, a process left behind) must not take the server down.
  stream?.on('error', () => undefined);
  return () => {
    if (buffer && !cutting) onLine(buffer.replace(/\r$/, ''), false);
    buffer = '';
  };
}

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** A command a builder returned: CLI arguments, at least one, each a string without a NUL. */
const isCommand = (args: unknown): args is string[] => Array.isArray(args) && args.length > 0 && args.every((a) => typeof a === 'string' && !a.includes('\0'));

/** A command as typed, for the line that starts it in a job's output: `shadowlap test goldens/x`. */
function commandLine(args: readonly string[]): string {
  return `shadowlap ${args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}`;
}

/** A project's folder resolved through symbolic links, or null without one (or when it is gone). */
function realRoot(project: ProjectInfo | null): string | null {
  if (!project) return null;
  try {
    return realpathSync(project.path);
  } catch {
    return null;
  }
}

export class JobManager {
  private readonly kinds = new Map<string, JobKind>();
  private readonly jobs = new Map<string, Job>();
  private readonly files = new Map<string, { path: string; jobId: string; name: string }>();
  private readonly listeners = new Set<(notice: JobNotice) => void>();
  /**
   * Goes up whenever a job starts, ends, or reports a run, link, file or result: `/api/changes`
   * reads it. Output lines do not move it; a page follows a running job's output with
   * `GET /api/jobs/:id?after=n` until it is done.
   */
  version = 0;
  private readonly stopGraceMs: number;
  /** The dashboard is stopping: no job starts any more. */
  private closed = false;

  constructor(
    private readonly o: {
      store: Store;
      spawnCli?: SpawnCli | undefined;
      project: ProjectInfo | null;
      uploads?: UploadSource | undefined;
      log?: ((line: string) => void) | undefined;
      /** How long a stopped job has to end before it is killed (5 s). */
      stopGraceMs?: number | undefined;
      /**
       * Where the next job runs, on a dashboard that serves several projects: asked when a job
       * starts, and kept by it to the end. Without it, `store` and `project`.
       */
      place?: (() => JobPlace) | undefined;
    },
  ) {
    this.stopGraceMs = o.stopGraceMs ?? STOP_GRACE_MS;
  }

  /** Where a job starting now runs. */
  private here(): JobPlace {
    return this.o.place?.() ?? { store: this.o.store, project: this.o.project, dbPath: null, projectId: null };
  }

  /**
   * Hears every job's runs and its end, whichever kind it is: what a feature keeps up to date from
   * other features' jobs (the setup notes a recording, a calibration, a test). A listener that
   * throws is logged and skipped. Returns a function that stops listening.
   */
  onJob(listener: (notice: JobNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(job: Job, notice: Omit<JobNotice, 'job' | 'projectId'>): void {
    if (!this.listeners.size) return;
    const full: JobNotice = { ...notice, job: this.view(job), projectId: job.place.projectId };
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch (err) {
        this.o.log?.(`a job listener failed on job ${job.id}: ${messageOf(err)}`);
      }
    }
  }

  /**
   * Makes `POST /api/jobs { kind, ... }` accept a kind. A feature calls this from its route
   * module's `register`; a kind is registered once.
   */
  registerJobKind(kind: string, def: JobKind): void {
    if (!KIND.test(kind)) throw new Error(`job kind "${kind}": lowercase letters, digits and dashes, starting with a letter`);
    if (this.kinds.has(kind)) throw new Error(`job kind "${kind}" is registered twice`);
    this.kinds.set(kind, def);
  }

  /** The kinds `POST /api/jobs` accepts, sorted. */
  kindNames(): string[] {
    return [...this.kinds.keys()].sort();
  }

  /** Whether jobs can start at all: the dashboard was given a way to run the CLI. */
  get available(): boolean {
    return !!this.o.spawnCli;
  }

  private running(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (!j.done) n++;
    return n;
  }

  /** The working trees running jobs hold. */
  private *heldTrees(): Iterable<{ tree: JobTree | null; at: string | null }> {
    for (const j of this.jobs.values()) if (!j.done) yield { tree: j.worktree, at: j.treeAt };
  }

  /**
   * Builds and starts a job of `kind`. Throws an HttpError the client should see when it cannot.
   * `allow`: the tools its commands that replay a recording run again though their recording never
   * recorded them (Run again, allowing, `again`).
   */
  async start(kind: unknown, req: JobRequest, allow?: readonly string[]): Promise<JobView> {
    const { def, spawnCli } = this.startable(kind);
    const id = randomBytes(8).toString('hex');
    const uploads = this.o.uploads;
    // The project current now: the builder reads its store, and the job runs there to the end.
    let place: JobPlace;
    try {
      place = this.here();
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(409, messageOf(err));
    }
    let built: JobBuildResult;
    try {
      built = await def.build(req, {
        store: place.store,
        project: place.project,
        projectId: place.projectId,
        upload: (uploadId, o) => uploads?.claim(uploadId, id, place.project, o) ?? null,
      });
    } catch (err) {
      uploads?.release(id);
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, messageOf(err));
    }
    if ('error' in built) {
      uploads?.release(id);
      throw new HttpError(built.status ?? 400, built.error, built.confirm, built.live);
    }
    if (allow) {
      try {
        built = allowing(built, allow);
      } catch (err) {
        uploads?.release(id);
        throw err;
      }
    }
    const root: { value?: string | null } = {};
    let set: ReturnType<JobManager['settle']>;
    try {
      set = this.settle(kind as string, built, def.title(req), place, root);
    } catch (err) {
      uploads?.release(id);
      throw err instanceof HttpError ? err : new HttpError(500, messageOf(err));
    }

    let markEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => (markEnded = resolve));
    const { yes: _yes, estimate: _estimate, ...request } = req;
    const job: Job = {
      id,
      kind: kind as string,
      request,
      args: [...built.args],
      estimate: shownEstimate(req.estimate),
      ...set,
      rest: (built.then ?? []).map((a) => [...a]),
      ...stepOf(built),
      git: built.git ? { ...built.git, args: [...built.git.args] } : null,
      gitOutcome: null,
      ...subjectOf(built),
      startedAt: Date.now(),
      endedAt: null,
      done: false,
      code: null,
      newRunId: null,
      sawRunEvent: false,
      runs: [],
      made: new Set(),
      links: [],
      files: [],
      result: null,
      lines: [],
      dropped: 0,
      child: null,
      stopping: false,
      exited: false,
      killTimer: null,
      ended,
      markEnded,
      place,
      ...('value' in root ? { root: root.value } : {}),
    };
    this.jobs.set(id, job);
    this.evict();
    this.version++;
    if (job.git) this.runGit(job, spawnCli, job.git);
    else this.runNext(job, spawnCli, job.args, false);
    if (job.child && built.started) {
      try {
        built.started();
      } catch (err) {
        this.o.log?.(`job ${id} (${kind as string}): what its kind does once it starts failed: ${messageOf(err)}`);
      }
    }
    return this.view(job);
  }

  /**
   * Run again, allowing: a job that ended starts again as it was asked for, its request built again
   * by its kind's builder (every field checked as before, and the yes its kind asks asked again: a
   * 409 the page answers, `yes` then), with `--allow-unrecorded` naming the tools on each command
   * that replays a recording. Only in the project it ran in.
   */
  async again(id: string, req: JobRequest): Promise<JobView> {
    const was = this.jobs.get(id);
    if (!was) throw new HttpError(404, `no job ${id.slice(0, 40)}`);
    if (!was.done) throw new HttpError(409, 'the job is still running');
    const tools = allowedTools(req.allowUnrecorded);
    if (this.here().projectId !== was.place.projectId) throw new HttpError(409, 'that job ran in another project: switch to it to run it again');
    return this.start(was.kind, { ...was.request, ...(req.yes !== undefined ? { yes: req.yes } : {}), ...(req.estimate !== undefined ? { estimate: req.estimate } : {}) }, tools);
  }

  /** The kind a job is started as, and the spawner, or why none can start now. */
  private startable(kind: unknown): { def: JobKind; spawnCli: SpawnCli } {
    if (typeof kind !== 'string' || !kind) throw new HttpError(400, 'kind is required');
    const def = this.kinds.get(kind);
    if (!def) throw new HttpError(400, `no job kind "${kind.slice(0, 40)}" (this dashboard runs: ${this.kindNames().join(', ') || 'none'})`);
    const spawnCli = this.o.spawnCli;
    if (!spawnCli) throw new HttpError(501, 'actions are not available: start the dashboard with shadowlap dashboard');
    if (this.closed) throw new HttpError(503, 'the dashboard is stopping');
    if (this.running() >= MAX_RUNNING) throw new HttpError(429, `${MAX_RUNNING} jobs are running; wait for one to finish`);
    return { def, spawnCli };
  }

  /**
   * What a job built runs with: its folder, environment and title, checked, and the working tree it
   * holds, refused while another job holds it against it. A git step (`JobBuild.git`) changes the
   * tree, so its job holds it as a writer.
   */
  private settle(kind: string, built: JobBuild, title: string, place: JobPlace, root: { value?: string | null }): Pick<Job, 'cwd' | 'env' | 'title' | 'worktree' | 'treeAt'> {
    // A builder can take its time (an async one reads files): the dashboard may have begun to stop meanwhile.
    if (this.closed) throw new HttpError(503, 'the dashboard is stopping');
    if (!isCommand(built.args)) throw new HttpError(500, `job kind "${kind}" built no command`);
    if (built.then !== undefined && (!Array.isArray(built.then) || !built.then.every(isCommand))) throw new HttpError(500, `job kind "${kind}" built a command to run next that is not one`);
    if (built.git !== undefined && !isGitStep(built.git)) throw new HttpError(500, `job kind "${kind}" built a git step that is not one`);
    const cwd = this.jobCwd(built.cwd, place.project, root);
    const env = checkedEnv(built.env);
    if (this.running() >= MAX_RUNNING) throw new HttpError(429, `${MAX_RUNNING} jobs are running; wait for one to finish`);
    // A project's working tree is one: no job runs the agent from it while another changes it.
    const use: TreeUse | null = built.git ? { use: 'writes', doing: built.git.doing, verb: built.git.verb } : treeUse(jobCommands(built));
    if (!use) return { cwd, env, title: clean(built.title ?? title, 120) || kind, worktree: null, treeAt: null };
    const treeAt = treeFolder(cwd);
    const clash = treeClash(this.heldTrees(), use.use, treeAt);
    if (clash) throw new HttpError(409, `${clash.doing}: ${use.verb} once it is done`);
    return { cwd, env, title: clean(built.title ?? title, 120) || kind, worktree: { use: use.use, doing: use.doing, folder: cwd }, treeAt };
  }

  /**
   * Runs a job's git step first (`JobBuild.git`), in its folder, its lines as git prints them: once
   * it exits 0, its `ok` line, then the job's CLI commands, each shown as `$ shadowlap …` and each
   * after any server step due before it (`runNext`). Otherwise the job ends with git's exit code,
   * with what git left in the tree asked of git (`GitOutcome`).
   */
  private runGit(job: Job, spawnCli: SpawnCli, step: GitStep): void {
    job.git = null;
    this.push(job, gitLine(step.args));
    let child: ChildProcess;
    try {
      child = spawnGit(step.args, job.cwd, job.env);
    } catch (err) {
      this.push(job, `failed to start: git: ${messageOf(err)}`);
      job.gitOutcome = 'untouched';
      this.finish(job, 127);
      return;
    }
    job.child = child;
    job.exited = false;
    const flushOut = lines(child.stdout, MAX_LINE, (line, cut) => this.output(job, line, cut));
    const flushErr = lines(child.stderr, MAX_LINE, (line, cut) => this.output(job, line, cut));
    let over = false;
    const end = async (code: number | null) => {
      if (over || job.done) return;
      over = true;
      flushOut();
      flushErr();
      if (code === 0 && !job.stopping && !this.closed) {
        job.gitOutcome = 'done';
        this.push(job, step.ok);
        this.runNext(job, spawnCli, job.args, true);
        return;
      }
      // Stopped once git had done its part: the commands after it never ran, so it did not finish.
      if (code === 0) this.push(job, `(stopped before ${commandLine(job.args)})`);
      job.gitOutcome = code === 0 ? 'done' : (await leftConflicts(job.cwd)) ? 'conflicts' : 'untouched';
      this.finish(job, code === 0 ? null : code);
    };
    child.on('error', (err) => {
      this.push(job, `failed to start: git: ${err.message}`);
      void end(127);
    });
    child.on('exit', () => (job.exited = true));
    child.on('close', (code) => void end(code));
  }

  /**
   * Starts a job's next command (`shown`: with its `$ shadowlap …` line), its server step first when
   * one is due before it (`JobBuild.step`).
   */
  private runNext(job: Job, spawnCli: SpawnCli, args: string[], shown: boolean): void {
    const step = job.step?.before === job.ran ? job.step : null;
    if (step) {
      job.step = null;
      void this.runStep(job, spawnCli, step, args);
      return;
    }
    if (shown) this.push(job, `$ ${commandLine(args)}`);
    this.version++;
    this.runCommand(job, spawnCli, args);
  }

  /** Runs a job's server step, its lines as it words them: one that refuses ends the job there, and so does a stop asked for meanwhile. */
  private async runStep(job: Job, spawnCli: SpawnCli, step: JobStep, args: string[]): Promise<void> {
    const done = await stepDone(step);
    for (const line of done.lines) this.push(job, line);
    if (done.code !== undefined) return this.finish(job, done.code);
    if (job.stopping || this.closed) {
      this.push(job, `(stopped before ${commandLine(args)})`);
      return this.finish(job, null);
    }
    this.runNext(job, spawnCli, args, true);
  }

  /**
   * Runs one command of a job, in its folder, against its project's store, with its environment.
   * When it exits 0 and the job has commands left (`JobBuild.then`), the next one starts, unless the
   * job was asked to stop or the dashboard is stopping; otherwise the job ends with this command's
   * exit code.
   */
  private runCommand(job: Job, spawnCli: SpawnCli, args: string[]): void {
    job.ran++;
    let child: ChildProcess;
    try {
      child = spawnCli(args, { events: true, ...(job.cwd ? { cwd: job.cwd } : {}), ...(job.place.dbPath ? { dbPath: job.place.dbPath } : {}), ...(Object.keys(job.env).length ? { env: job.env } : {}) });
    } catch (err) {
      this.push(job, `failed to start: ${messageOf(err)}`);
      this.finish(job, 127);
      return;
    }
    job.child = child;
    job.exited = false;
    const flushOut = lines(child.stdout, MAX_LINE, (line, cut) => this.output(job, line, cut));
    const flushErr = lines(child.stderr, MAX_LINE, (line, cut) => this.output(job, line, cut));
    const events = child.stdio[3] as Readable | null | undefined;
    const flushEvents = lines(events, MAX_EVENT, (line, cut) => (cut ? this.push(job, '(a job event over 1 MB was left out)') : this.event(job, line)));
    let drain: NodeJS.Timeout | null = null;
    // `exit` (after the drain) and `close` both end this command; only the first counts.
    let over = false;
    const end = (code: number | null) => {
      if (drain) clearTimeout(drain);
      if (over || job.done) return;
      over = true;
      flushOut();
      flushErr();
      flushEvents();
      const next = job.rest.shift();
      if (next && code === 0 && !job.stopping && !this.closed) {
        this.runNext(job, spawnCli, next, true);
        return;
      }
      // Stopped between two commands: the ones after it never ran, so it did not finish.
      if (next && code === 0) {
        this.push(job, `(stopped before ${commandLine(next)})`);
        this.finish(job, null);
        return;
      }
      this.finish(job, code);
    };
    child.on('error', (err) => {
      this.push(job, `failed to start: ${err.message}`);
      end(127);
    });
    child.on('exit', (code) => {
      job.exited = true;
      // A job that was asked to stop takes down whatever it left in its group (an agent that ignored
      // the signal), at once: the group's id cannot have been reused while anything is in it. Not on
      // Windows, which has no such groups and reuses a process id soon after it is freed.
      if (job.stopping && process.platform !== 'win32') signalJob(child, 'SIGKILL');
      // `close` waits for every pipe; a process the job left behind may hold one open for good.
      drain = setTimeout(() => {
        for (const s of [child.stdout, child.stderr, events]) s?.destroy();
        end(code);
      }, DRAIN_MS);
      drain.unref();
    });
    child.on('close', (code) => end(code));
  }

  /** The job's working directory: its project's folder, or a folder inside it the builder asked for. `root` keeps the folder's real path once worked out. */
  private jobCwd(asked: string | undefined, project: ProjectInfo | null, root: { value?: string | null }): string | null {
    if (asked === undefined) return project?.path ?? null;
    if (!project) throw new HttpError(500, 'a job asked for a working directory, but the dashboard has no project folder');
    const dir = resolve(project.path, asked);
    root.value = realRoot(project);
    if (!within(root.value, dir)) throw new HttpError(400, 'the working directory must be inside the project folder');
    return dir;
  }

  /** The real path of the folder of the project a job runs in, worked out once per job. */
  private projectRoot(job: Job): string | null {
    if (job.root === undefined) job.root = realRoot(job.place.project);
    return job.root;
  }

  /**
   * Keeps a line of the job's output. The oldest are let go in batches, not one per line: shifting
   * the whole list for every line of a chatty job would slow every request the dashboard answers.
   * `view` shows the last MAX_LINES however many are held.
   */
  private push(job: Job, line: string): void {
    job.lines.push(line);
    if (job.lines.length >= 2 * MAX_LINES) {
      const over = job.lines.length - MAX_LINES;
      job.lines.splice(0, over);
      job.dropped += over;
    }
  }

  private output(job: Job, raw: string, cut: boolean): void {
    const line = raw.replace(ANSI, '');
    const m = RUN_LINE.exec(line);
    if (m) {
      this.addRun(job, m[1]!);
      // Structured events are the better source; a line names the run only for a CLI that sends none.
      if (!job.sawRunEvent) job.newRunId = m[1]!;
    }
    this.push(job, cut ? `${line}…` : line);
  }

  private addRun(job: Job, runId: string): void {
    if (job.runs.includes(runId) || job.runs.length >= MAX_RUNS) return;
    job.runs.push(runId);
    this.version++;
  }

  /** One line from fd 3. Anything malformed is ignored: the output still tells the story. */
  private event(job: Job, line: string): void {
    if (!line.trim()) return;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return;
    const ev = e as Record<string, unknown>;
    switch (ev.type) {
      case 'run': {
        if (typeof ev.runId !== 'string' || !RUN_ID.test(ev.runId)) return;
        const role = typeof ev.role === 'string' ? ev.role.slice(0, 32) : null;
        this.addRun(job, ev.runId);
        if (job.made.size < MAX_RUNS) job.made.add(ev.runId);
        if (!role || !ATTEMPT_ROLES.has(role)) {
          job.sawRunEvent = true;
          job.newRunId = ev.runId;
          this.version++;
        }
        this.notify(job, { type: 'run', runId: ev.runId, role });
        return;
      }
      case 'link': {
        // A route of the page, as the one link builder writes them (links.ts).
        if (!isLink(ev.href)) return;
        const label = typeof ev.label === 'string' ? clean(ev.label, 120) : '';
        if (!label) return;
        // The drawer ends on one primary action; a secondary link shows beside it as a plain one.
        const link: JobLink = { label, href: ev.href, ...(ev.secondary === true ? { secondary: true } : {}) };
        const at = job.links.findIndex((l) => l.href === ev.href);
        if (at >= 0) job.links[at] = link;
        else if (job.links.length < MAX_LINKS) job.links.push(link);
        else return;
        this.version++;
        return;
      }
      case 'file': {
        if (typeof ev.path !== 'string' || !ev.path || ev.path.length > 4096 || ev.path.includes('\0')) return;
        const label = typeof ev.label === 'string' ? clean(ev.label, 120) || null : null;
        this.addFile(job, ev.path, label);
        return;
      }
      case 'result':
        if (!('data' in ev)) return;
        job.result = ev.data ?? null;
        this.version++;
        return;
      default:
        return;
    }
  }

  /** Names a file or folder the job wrote, if it is inside the project folder; a file is offered for download. */
  private addFile(job: Job, path: string, label: string | null): void {
    const root = this.projectRoot(job);
    if (!root) return;
    const abs = resolve(job.cwd ?? root, path);
    if (!within(root, abs)) {
      this.push(job, `(${basename(path)} is outside the project folder, so the dashboard does not offer it)`);
      return;
    }
    let real: string;
    let bytes: number | null;
    let directory: boolean;
    try {
      real = realpathSync(abs);
      const st = statSync(real);
      directory = st.isDirectory();
      if (!directory && !st.isFile()) return;
      bytes = directory ? null : st.size;
    } catch {
      return;
    }
    const existing = job.files.find((f) => this.files.get(f.fileId)?.path === real);
    if (!existing && job.files.length >= MAX_FILES) return;
    const name = basename(real);
    const file: JobFile = { fileId: existing?.fileId ?? randomBytes(12).toString('hex'), name, path: relative(root, real).split(sep).join('/') || '.', label: label ?? existing?.label ?? null, bytes, directory };
    if (existing) Object.assign(existing, file);
    else job.files.push(file);
    this.files.set(file.fileId, { path: real, jobId: job.id, name });
    this.version++;
  }

  /**
   * Opens a file a job reported, for download, checked again now: still a regular file inside the
   * project folder (it could have been replaced since), and not a symbolic link. The caller closes
   * the descriptor. Throws a 404 for anything else.
   */
  openFile(fileId: string): { fd: number; name: string; bytes: number } {
    const f = /^[0-9a-f]{24}$/.test(fileId) ? this.files.get(fileId) : undefined;
    const job = f ? this.jobs.get(f.jobId) : undefined;
    if (!f || !job) throw new HttpError(404, 'no such file: the dashboard offers only files its jobs reported, while it remembers the job');
    if (!within(this.projectRoot(job), f.path)) throw new HttpError(404, `${f.name} is no longer inside the project folder`);
    let fd: number;
    try {
      fd = openSync(f.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      throw new HttpError(404, `${f.name} is gone`);
    }
    try {
      const st = fstatSync(fd);
      if (st.isDirectory()) throw new HttpError(400, `${f.name} is a folder: find it in the project folder`);
      if (!st.isFile()) throw new HttpError(404, `${f.name} is not a regular file`);
      return { fd, name: f.name, bytes: st.size };
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  private finish(job: Job, code: number | null): void {
    if (job.done) return;
    job.done = true;
    job.code = code;
    job.endedAt = Date.now();
    job.child = null;
    if (job.killTimer) clearTimeout(job.killTimer);
    job.killTimer = null;
    this.endOrphanedRuns(job);
    this.o.uploads?.discard(job.id);
    this.version++;
    this.o.log?.(`job ${job.id} (${job.kind}: shadowlap ${job.args.join(' ')}) exited ${String(code)}`);
    this.notify(job, { type: 'end' });
    job.markEnded();
  }

  /**
   * The command is gone, so a run it made that is still recording (it was killed before it could
   * end it) never will be: it ends as crashed, as an interrupted run does, and stops showing as live.
   * In the store of the project the job ran in, whichever is current now.
   */
  private endOrphanedRuns(job: Job): void {
    const store = job.place.store;
    for (const runId of job.made) {
      try {
        if (store.getRun(runId)?.status !== 'running') continue;
        store.endRun(runId, 'crashed');
        this.push(job, `(run ${runId} was still recording when the command ended; it is marked as interrupted)`);
      } catch {
        // the store is closing; the run stays as it is
      }
    }
  }

  /** Keeps the most recent jobs; only finished ones go. */
  private evict(): void {
    if (this.jobs.size <= KEEP_JOBS) return;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= KEEP_JOBS) break;
      if (!j.done) continue;
      this.jobs.delete(id);
      for (const f of j.files) this.files.delete(f.fileId);
    }
  }

  /** The job as the API returns it, with output lines from `after` on (counted from the first line ever). A 404 for an unknown id. */
  view(idOrJob: string | Job, after = 0): JobView {
    const job = typeof idOrJob === 'string' ? this.jobs.get(idOrJob) : idOrJob;
    if (!job) throw new HttpError(404, 'no such job');
    // The last MAX_LINES lines; any older ones still held count as dropped.
    const shown = Math.max(0, job.lines.length - MAX_LINES);
    const from = Math.max(shown, after - job.dropped);
    return { ...this.item(job), result: job.result, lines: job.lines.slice(from) };
  }

  private item(job: Job): JobListItem {
    return {
      id: job.id,
      kind: job.kind,
      title: job.title,
      args: [...job.args],
      ...(job.estimate ? { estimate: { ...job.estimate } } : {}),
      worktree: job.worktree,
      ...(job.gitOutcome ? { git: job.gitOutcome } : {}),
      runId: job.runId,
      ...(job.fixId ? { fixId: job.fixId } : {}),
      opensRun: job.opensRun,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      done: job.done,
      stopped: job.stopping,
      code: job.code,
      newRunId: job.newRunId,
      runs: [...job.runs],
      links: job.links.map((l) => ({ ...l })),
      files: job.files.map((f) => ({ ...f })),
      total: job.dropped + job.lines.length,
      ...(job.place.projectId ? { project: { id: job.place.projectId, name: job.place.project?.name ?? job.place.projectId } } : {}),
    };
  }

  /** Recent jobs, newest first, without their output or result (a result can be large; the job's own view has it). */
  list(): JobListItem[] {
    return [...this.jobs.values()].reverse().map((j) => this.item(j));
  }

  /**
   * Asks a running job to stop: SIGTERM to its process group (the CLI ends its run as interrupted
   * and passes the signal on to the agent), then SIGKILL to the group if it has not ended within
   * the grace time (5 s). False when it is not running.
   */
  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.done || !job.child) return false;
    this.terminate(job);
    return true;
  }

  private terminate(job: Job): void {
    const child = job.child;
    if (!child || job.stopping) return;
    job.stopping = true;
    // The CLI has exited and only its pipes are open (a process it left holds them): its group may be
    // gone and its id another's by now. The drain closes the pipes and ends the job within seconds.
    if (job.exited) return;
    signalJob(child, 'SIGTERM');
    job.killTimer = setTimeout(() => {
      job.killTimer = null;
      // Only while the CLI is alive: its group surely exists then. After it exited, its exit handler killed what was left.
      if (!job.exited && !job.done) signalJob(child, 'SIGKILL');
    }, this.stopGraceMs);
    job.killTimer.unref();
  }

  /**
   * Kills every running job at once, with whatever it started: the dashboard was told to stop again
   * while it waited for them (a second Ctrl-C). A run one leaves recording is marked as interrupted
   * when it ends, as after a stop. A job whose command has already exited is left to finish: its
   * process group may be gone, and its id taken by another.
   */
  kill(): void {
    this.closed = true;
    for (const job of this.jobs.values()) {
      const child = job.child;
      if (job.done || !child) continue;
      job.stopping = true;
      if (!job.exited) signalJob(child, 'SIGKILL');
    }
  }

  /**
   * Stops every running job, the server is closing: each gets the grace time to end, then is
   * killed, and its runs still recording are marked as interrupted. Resolves when they are done.
   */
  async close(): Promise<void> {
    // No job starts from here on, not even one whose builder is still at work.
    this.closed = true;
    const running = [...this.jobs.values()].filter((j) => !j.done && j.child);
    for (const j of running) this.terminate(j);
    if (!running.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(running.map((j) => j.ended)), new Promise<void>((resolve) => (timer = setTimeout(resolve, this.stopGraceMs + DRAIN_MS + 1000)))]);
    clearTimeout(timer);
  }
}
