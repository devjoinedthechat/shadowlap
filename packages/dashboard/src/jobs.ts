import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { Store } from '@shadowlap/engine';
import { HttpError } from './http.js';
import type { JobFile, JobLink, JobListItem, JobView, ProjectView } from './views.js';

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
 *   {"type":"link","label":"Open the fix","href":"#/fixes/fx-…"}   where to go next (dashboard routes only)
 *   {"type":"file","path":".shadowlap/exports/x.jsonl","label":"Dataset"}   a file or folder it wrote
 *   {"type":"result","data":{…}}                     its outcome (what --json prints); the last one is kept
 *
 * A CLI that sends no events still works: a "recording run <id>" or "replaying run <id>" line in
 * its output names the run, as it always did.
 */

export interface SpawnCliOptions {
  /** The CLI's working directory, inside the project. */
  cwd?: string;
  /** Open fd 3 as a pipe and set SHADOWLAP_EVENTS_FD=3, for the job's structured events. */
  events?: boolean;
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
    const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), NO_COLOR: '1' };
    delete env.SHADOWLAP_EVENTS_FD;
    if (so.events) env.SHADOWLAP_EVENTS_FD = '3';
    return spawn(cmd, [...pre, ...(o.dbPath ? ['--db', o.dbPath] : []), ...args], {
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
  /** The run the job is about (its full id), if any. */
  runId?: string | null;
  /** The working directory, relative to the project folder or absolute inside it. Defaults to the project folder. */
  cwd?: string;
  /** The job makes a run to open when it ends. */
  opensRun?: boolean;
  /** Overrides the kind's title, when the request says more than the kind does. */
  title?: string;
}

export type JobBuildResult = JobBuild | { error: string; status?: number };

/** What a builder can use besides what its route module closed over. */
export interface JobBuildContext {
  store: Store;
  project: ProjectInfo | null;
  /**
   * A file the browser sent with `POST /api/uploads`, claimed for this job: its path, or null for
   * an unknown id. It is deleted when the job ends.
   */
  upload(uploadId: unknown): { path: string; name: string; bytes: number } | null;
}

export interface JobKind {
  /** What the drawer calls the job: "Blaming", "Importing a capture". */
  title(req: JobRequest): string;
  /** Checks the request and returns the CLI arguments, or why it cannot run. */
  build(req: JobRequest, ctx: JobBuildContext): JobBuildResult | Promise<JobBuildResult>;
}

/** Where uploads come from (`uploads.ts`): claimed by a job's builder, released when it fails, discarded when the job ends. */
export interface UploadSource {
  claim(uploadId: unknown, jobId: string): { path: string; name: string; bytes: number } | null;
  release(jobId: string): void;
  discard(jobId: string): void;
}

/** Roles of runs a job made that are attempts, bundled under another run rather than opened. */
const ATTEMPT_ROLES = new Set(['attempt', 'probe', 'verify']);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const RUN_LINE = /(?:recording|replaying) run ([0-9A-Z]{26})/;
const RUN_ID = /^[0-9A-Z]{26}$/;
const HREF = /^#\/[\w\-./~%?=&+:@,!*$]*$/;
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

interface Job {
  id: string;
  kind: string;
  title: string;
  args: string[];
  runId: string | null;
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
}

/** Splits a stream into lines, each cut at `max` characters. Returns a flush for the end. */
function lines(stream: Readable | null | undefined, max: number, onLine: (line: string, cut: boolean) => void): () => void {
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

export class JobManager {
  private readonly kinds = new Map<string, JobKind>();
  private readonly jobs = new Map<string, Job>();
  private readonly files = new Map<string, { path: string; jobId: string; name: string }>();
  private projectReal: string | null | undefined;
  /**
   * Goes up whenever a job starts, ends, or reports a run, link, file or result: `/api/changes`
   * reads it. Output lines do not move it; a page follows a running job's output with
   * `GET /api/jobs/:id?after=n` until it is done.
   */
  version = 0;
  private readonly stopGraceMs: number;

  constructor(
    private readonly o: {
      store: Store;
      spawnCli?: SpawnCli | undefined;
      project: ProjectInfo | null;
      uploads?: UploadSource | undefined;
      log?: ((line: string) => void) | undefined;
      /** How long a stopped job has to end before it is killed (5 s). */
      stopGraceMs?: number | undefined;
    },
  ) {
    this.stopGraceMs = o.stopGraceMs ?? STOP_GRACE_MS;
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

  /** Builds and starts a job of `kind`. Throws an HttpError the client should see when it cannot. */
  async start(kind: unknown, req: JobRequest): Promise<JobView> {
    if (typeof kind !== 'string' || !kind) throw new HttpError(400, 'kind is required');
    const def = this.kinds.get(kind);
    if (!def) throw new HttpError(400, `no job kind "${kind.slice(0, 40)}" (this dashboard runs: ${this.kindNames().join(', ') || 'none'})`);
    const spawnCli = this.o.spawnCli;
    if (!spawnCli) throw new HttpError(501, 'actions are not available: start the dashboard with shadowlap dashboard');
    if (this.running() >= MAX_RUNNING) throw new HttpError(429, `${MAX_RUNNING} jobs are running; wait for one to finish`);

    const id = randomBytes(8).toString('hex');
    const uploads = this.o.uploads;
    let built: JobBuildResult;
    try {
      built = await def.build(req, {
        store: this.o.store,
        project: this.o.project,
        upload: (uploadId) => uploads?.claim(uploadId, id) ?? null,
      });
    } catch (err) {
      uploads?.release(id);
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if ('error' in built) {
      uploads?.release(id);
      throw new HttpError(built.status ?? 400, built.error);
    }
    let cwd: string | null;
    let title: string;
    try {
      if (!Array.isArray(built.args) || !built.args.length || built.args.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new HttpError(500, `job kind "${kind}" built no command`);
      cwd = this.jobCwd(built.cwd);
      title = clean(built.title ?? def.title(req), 120) || kind;
      if (this.running() >= MAX_RUNNING) throw new HttpError(429, `${MAX_RUNNING} jobs are running; wait for one to finish`);
    } catch (err) {
      uploads?.release(id);
      throw err instanceof HttpError ? err : new HttpError(500, err instanceof Error ? err.message : String(err));
    }

    let markEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => (markEnded = resolve));
    const job: Job = {
      id,
      kind,
      title,
      args: [...built.args],
      runId: built.runId ?? null,
      opensRun: built.opensRun ?? false,
      cwd,
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
    };
    this.jobs.set(id, job);
    this.evict();
    this.version++;

    let child: ChildProcess;
    try {
      child = spawnCli(job.args, { events: true, ...(cwd ? { cwd } : {}) });
    } catch (err) {
      this.push(job, `failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.finish(job, 127);
      return this.view(job);
    }
    job.child = child;
    const flushOut = lines(child.stdout, MAX_LINE, (line, cut) => this.output(job, line, cut));
    const flushErr = lines(child.stderr, MAX_LINE, (line, cut) => this.output(job, line, cut));
    const events = child.stdio[3] as Readable | null | undefined;
    const flushEvents = lines(events, MAX_EVENT, (line, cut) => (cut ? this.push(job, '(a job event over 1 MB was left out)') : this.event(job, line)));
    let drain: NodeJS.Timeout | null = null;
    const end = (code: number | null) => {
      if (drain) clearTimeout(drain);
      if (job.done) return;
      flushOut();
      flushErr();
      flushEvents();
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
    return this.view(job);
  }

  private jobCwd(asked: string | undefined): string | null {
    const project = this.o.project;
    if (asked === undefined) return project?.path ?? null;
    if (!project) throw new HttpError(500, 'a job asked for a working directory, but the dashboard has no project folder');
    const dir = resolve(project.path, asked);
    if (!this.inProject(dir)) throw new HttpError(400, 'the working directory must be inside the project folder');
    return dir;
  }

  /** Whether `path` (resolved through symbolic links) is inside the project folder. */
  private inProject(path: string): boolean {
    const root = this.projectRoot();
    if (!root) return false;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return false;
    }
    const rel = relative(root, real);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  }

  private projectRoot(): string | null {
    if (this.projectReal === undefined) {
      try {
        this.projectReal = this.o.project ? realpathSync(this.o.project.path) : null;
      } catch {
        this.projectReal = null;
      }
    }
    return this.projectReal;
  }

  private push(job: Job, line: string): void {
    job.lines.push(line);
    if (job.lines.length > MAX_LINES) {
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
        return;
      }
      case 'link': {
        if (typeof ev.href !== 'string' || ev.href.length > 512 || !HREF.test(ev.href)) return;
        const label = typeof ev.label === 'string' ? clean(ev.label, 120) : '';
        if (!label) return;
        const at = job.links.findIndex((l) => l.href === ev.href);
        if (at >= 0) job.links[at] = { label, href: ev.href };
        else if (job.links.length < MAX_LINKS) job.links.push({ label, href: ev.href });
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
    const root = this.projectRoot();
    if (!root) return;
    const abs = resolve(job.cwd ?? root, path);
    if (!this.inProject(abs)) {
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
    if (!f || !this.jobs.has(f.jobId)) throw new HttpError(404, 'no such file: the dashboard offers only files its jobs reported, while it remembers the job');
    if (!this.inProject(f.path)) throw new HttpError(404, `${f.name} is no longer inside the project folder`);
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
    this.o.log?.(`job ${job.id} (${job.kind}: shadowlap ${job.args.join(' ')}) exited ${code}`);
    job.markEnded();
  }

  /**
   * The command is gone, so a run it made that is still recording (it was killed before it could
   * end it) never will be: it ends as crashed, as an interrupted run does, and stops showing as live.
   */
  private endOrphanedRuns(job: Job): void {
    for (const runId of job.made) {
      try {
        if (this.o.store.getRun(runId)?.status !== 'running') continue;
        this.o.store.endRun(runId, 'crashed');
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
    const from = Math.max(0, after - job.dropped);
    return { ...this.item(job), result: job.result, lines: job.lines.slice(from) };
  }

  private item(job: Job): JobListItem {
    return {
      id: job.id,
      kind: job.kind,
      title: job.title,
      args: [...job.args],
      runId: job.runId,
      opensRun: job.opensRun,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      done: job.done,
      code: job.code,
      newRunId: job.newRunId,
      runs: [...job.runs],
      links: job.links.map((l) => ({ ...l })),
      files: job.files.map((f) => ({ ...f })),
      total: job.dropped + job.lines.length,
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
    const running = [...this.jobs.values()].filter((j) => !j.done && j.child);
    for (const j of running) this.terminate(j);
    if (!running.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(running.map((j) => j.ended)), new Promise<void>((resolve) => (timer = setTimeout(resolve, this.stopGraceMs + DRAIN_MS + 1000)))]);
    clearTimeout(timer);
  }
}
