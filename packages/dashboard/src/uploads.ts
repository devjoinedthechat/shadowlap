import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ulid } from '@shadowlap/engine';
import { HttpError, refuseOversized, safeFileName, tooLarge } from './http.js';
import type { ProjectInfo, UploadSource } from './jobs.js';
import type { UploadView } from './views.js';

/**
 * Files the browser sends for a job: a capture to import, a trace. `POST /api/uploads` takes the raw
 * bytes (the name in `x-filename`) up to its own limit, separate from the small JSON limit, and
 * keeps them under `<project>/.shadowlap/uploads/<ulid>-<name>`, readable by the owner only. They
 * are untrusted data: a job's builder resolves an upload id to a path and hands it to the CLI,
 * which parses it as it would any file.
 *
 * An upload is deleted when the job that used it ends, after an hour nobody used it, and when the
 * dashboard closes. On a dashboard that serves several projects, an upload goes to the folder of the
 * project current as it arrives (where its job will run), and each project's folder is swept of
 * what an earlier dashboard left there the first time it is served.
 */

export const UPLOAD_LIMIT = 64 * 1024 * 1024;
export const UPLOAD_MAX_IDLE_MS = 60 * 60 * 1000;
/** Uploads kept at once, counting those still arriving: enough for a batch of imports, not enough to fill a disk by mistake. */
export const MAX_UPLOADS = 32;
const SWEEP_EVERY_MS = 5 * 60 * 1000;
const FILE = /^[0-9A-Z]{26}-[\w.-]+$/;
/** The folder of its own a claimed upload moved into, by its id. */
const FOLDER = /^[0-9A-Z]{26}$/;

interface Upload {
  id: string;
  name: string;
  /** The name as the browser gave it, when it is a file name a run's source can carry (`pickedName`). */
  original: string | null;
  path: string;
  bytes: number;
  lastUsed: number;
  /** The job that claimed it, or null while nobody has. */
  jobId: string | null;
  /** The project it arrived in, the one current then: only a job of that project may claim it. */
  project: { path: string; name: string };
  /** The folder of its own it was moved into, under the name it arrived with (`claim`'s `named`), or null. */
  folder: string | null;
}

/**
 * The name a file was picked by, kept as it was ("my capture (2).har") when it can be a run's
 * source: no folders, no control characters, at most 200 characters, as `shadowlap import --name`
 * checks it. Null otherwise; the file on disk always goes by its safe name.
 */
export function pickedName(given: string): string | null {
  const name = given.trim();
  return name && name.length <= 200 && !/[\\/]/.test(name) && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

/** A claimed upload's own folder, once its file is gone; left for the next sweep while it can't go. */
function removeFolder(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // still open on Windows: the next sweep of leftovers takes it
  }
}

function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // still open on Windows: the next sweep of leftovers takes it
  }
}

export class UploadStore implements UploadSource {
  private readonly uploads = new Map<string, Upload>();
  /** Uploads still arriving: each holds a slot, so many sent at once cannot pass the limit together. */
  private arriving = 0;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  /** The uploads folders of the projects this dashboard served: swept once, and removed (when empty) on close. */
  private readonly folders = new Set<string>();
  private readonly limit: number;
  private readonly maxIdleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly o: {
      project: ProjectInfo | null;
      /** Bytes per upload; 64 MB by default. */
      limit?: number | undefined;
      /** How long an upload no job claimed is kept; an hour by default. */
      maxIdleMs?: number | undefined;
      now?: (() => number) | undefined;
      /**
       * A read-only dashboard: it takes no uploads and touches nothing in the uploads folder, not
       * even the leftovers of another dashboard (which that one, or the next writable one, sweeps).
       */
      readOnly?: boolean | undefined;
    },
  ) {
    this.limit = o.limit ?? UPLOAD_LIMIT;
    this.maxIdleMs = o.maxIdleMs ?? UPLOAD_MAX_IDLE_MS;
    this.now = o.now ?? Date.now;
    const project = o.project;
    if (project) this.adopt(project.path);
  }

  /**
   * A project folder this dashboard serves: what an earlier dashboard left in its uploads folder,
   * unused for the idle time, is swept the first time, and the folder is removed on close if empty.
   * A read-only dashboard touches nothing there.
   */
  adopt(projectPath: string): void {
    const dir = join(projectPath, '.shadowlap', 'uploads');
    if (this.o.readOnly || this.folders.has(dir)) return;
    this.folders.add(dir);
    this.sweepLeftovers(dir);
  }

  /** The folder uploads go to, or null without a project. */
  get dir(): string | null {
    return this.o.project ? join(this.o.project.path, '.shadowlap', 'uploads') : null;
  }

  /** The most an upload may hold. */
  get maxBytes(): number {
    return this.limit;
  }

  /** Stores the request body as a new upload. Throws an HttpError the client should see. */
  async receive(req: IncomingMessage): Promise<UploadView> {
    // The project current as it arrives, to the end: its job runs there.
    const project = this.o.project;
    if (this.o.readOnly) throw new HttpError(403, 'this dashboard is read-only: it takes no uploads');
    if (!project) throw new HttpError(501, 'uploads need a project folder: start the dashboard in your project with shadowlap dashboard');
    // A project whose folder is gone (or whose store can't be opened) runs no job to take it.
    if (project.problem) throw new HttpError(409, project.problem);
    if (!existsSync(project.path)) throw new HttpError(409, `${project.display ?? project.name} doesn’t exist any more. Remove the project, or put the folder back.`);
    const dir = join(project.path, '.shadowlap', 'uploads');
    this.adopt(project.path);
    refuseOversized(req, this.limit, 'file');
    if (this.uploads.size + this.arriving >= MAX_UPLOADS) {
      this.sweep();
      if (this.uploads.size + this.arriving >= MAX_UPLOADS) throw new HttpError(429, `${MAX_UPLOADS} uploads are waiting for a job or still arriving; start a job with them, or wait an hour`);
    }
    const raw = req.headers['x-filename'];
    let given = typeof raw === 'string' ? raw : '';
    try {
      given = decodeURIComponent(given);
    } catch {
      // not percent-encoded: taken as it is
    }
    const name = safeFileName(given, 'upload');
    // The slot is taken before the first byte is written and given back however the upload ends.
    this.arriving++;
    let bytes: number;
    const id = ulid();
    const path = join(dir, `${id}-${name}`);
    try {
      this.ensureDir(project, dir);
      bytes = await this.write(req, path);
    } catch (err) {
      throw this.closed ? new HttpError(503, 'the dashboard is stopping') : err;
    } finally {
      this.arriving--;
    }
    if (this.closed) {
      // The dashboard stopped while it arrived: nothing is kept after close.
      removeFile(path);
      if (!this.arriving) this.removeDirs();
      throw new HttpError(503, 'the dashboard is stopping');
    }
    this.uploads.set(id, { id, name, original: pickedName(given), path, bytes, lastUsed: this.now(), jobId: null, project: { path: project.path, name: project.name }, folder: null });
    this.schedule();
    return { uploadId: id, name, bytes };
  }

  /** Streams the body to a new file, refused past the limit; a refused or cut-off upload leaves nothing behind. */
  private write(req: IncomingMessage, path: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      // `wx` never follows a link or overwrites; the file is the owner's alone.
      const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
      let size = 0;
      let failed = false;
      const fail = (err: unknown) => {
        if (failed) return;
        failed = true;
        req.unpipe(out);
        // Refused once the file is gone: on a busy machine its open can finish after a refusal sent
        // at once, and the file would be there after the answer.
        out.once('close', () => {
          removeFile(path);
          reject(err);
        });
        out.destroy();
      };
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > this.limit) fail(tooLarge(this.limit, 'file'));
      });
      req.on('error', fail);
      req.on('close', () => {
        if (!req.complete) fail(new HttpError(400, 'the upload was cut off'));
      });
      out.on('error', (err) => fail(new HttpError(500, `could not store the upload: ${err.message}`)));
      out.on('finish', () => {
        if (!failed) resolve(size);
      });
      req.pipe(out);
    });
  }

  /**
   * The upload for a job that asked for it by id, or null for an unknown id or one another job holds.
   * A job of another project than the one the file arrived in is refused: the dashboard switched
   * between the upload and the job, and the file would be read in a project it wasn't sent to.
   */
  claim(uploadId: unknown, jobId: string, project?: ProjectInfo | null, o: { named?: boolean } = {}): { path: string; name: string; original: string | null; bytes: number } | null {
    if (typeof uploadId !== 'string' || !/^[0-9A-Z]{26}$/.test(uploadId)) return null;
    const u = this.uploads.get(uploadId);
    if (!u || (u.jobId !== null && u.jobId !== jobId)) return null;
    if (project && project.path !== u.project.path) throw new HttpError(409, `${u.name} was sent to ${u.project.name}, and the dashboard has switched to ${project.name} since. Send it again.`);
    if (o.named && !u.folder) this.moveNamed(u);
    u.jobId = jobId;
    u.lastUsed = this.now();
    return { path: u.path, name: u.name, original: u.original, bytes: u.bytes };
  }

  /**
   * A job that names what it reads by the file's name (a payload file's ids read `payloads.txt#2`):
   * the file moves into a folder of its own, `<uploads>/<id>/<name>`, under the name it arrived
   * with (safeFileName's), inside the uploads folder the guard keeps in the project.
   */
  private moveNamed(u: Upload): void {
    const folder = join(dirname(u.path), u.id);
    const to = join(folder, u.name);
    mkdirSync(folder, { recursive: true });
    renameSync(u.path, to);
    u.folder = folder;
    u.path = to;
  }

  /**
   * An upload nobody has claimed yet, read before a job takes it (Run injection test…'s payload
   * file, counted once it arrives): null for an unknown id, one a job holds, or one sent to another
   * project than `project`.
   */
  peek(uploadId: unknown, project?: ProjectInfo | null): { path: string; name: string; original: string | null; bytes: number } | null {
    if (typeof uploadId !== 'string' || !/^[0-9A-Z]{26}$/.test(uploadId)) return null;
    const u = this.uploads.get(uploadId);
    if (!u || u.jobId !== null || (project && project.path !== u.project.path)) return null;
    u.lastUsed = this.now();
    return { path: u.path, name: u.name, original: u.original, bytes: u.bytes };
  }

  /** A job that claimed uploads did not start: they wait for another. */
  release(jobId: string): void {
    for (const u of this.uploads.values()) {
      if (u.jobId !== jobId) continue;
      u.jobId = null;
      u.lastUsed = this.now();
    }
  }

  /** A job ended: the uploads it used are deleted. */
  discard(jobId: string): void {
    for (const u of [...this.uploads.values()]) if (u.jobId === jobId) this.remove(u);
  }

  /** Deletes uploads nobody has claimed for the idle time. Runs every few minutes on its own. */
  sweep(now = this.now()): void {
    for (const u of [...this.uploads.values()]) if (u.jobId === null && now - u.lastUsed >= this.maxIdleMs) this.remove(u);
  }

  /** How many uploads are kept now (not counting those still arriving). */
  get size(): number {
    return this.uploads.size;
  }

  /** Deletes every upload: the dashboard is closing. */
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of [...this.uploads.values()]) this.remove(u);
    // An upload still arriving is deleted when it has, and the folder with it.
    if (!this.arriving) this.removeDirs();
  }

  /** Each project's uploads folder, when empty: another dashboard on the project may be using it. */
  private removeDirs(): void {
    if (this.o.readOnly) return;
    for (const dir of this.folders) {
      try {
        rmdirSync(dir);
      } catch {
        // not empty, or never made
      }
    }
  }

  private remove(u: Upload): void {
    this.uploads.delete(u.id);
    removeFile(u.path);
    if (u.folder) removeFolder(u.folder);
    if (!this.uploads.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), Math.min(SWEEP_EVERY_MS, this.maxIdleMs));
    this.timer.unref();
  }

  /**
   * Makes the uploads folder, refusing a `.shadowlap` or `uploads` that is a link or leads outside
   * the project (a checkout could have planted one pointing anywhere), checked before anything is
   * made inside it. A new `.shadowlap` is kept out of git, as the store keeps its own folder.
   */
  private ensureDir(project: ProjectInfo, dir: string): void {
    const parent = join(project.path, '.shadowlap');
    for (const d of [parent, dir]) {
      let made = false;
      try {
        if (!lstatSync(d).isDirectory()) throw new HttpError(500, `${relative(project.path, d)} is not a folder; remove it and try again`);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        mkdirSync(d, { mode: 0o700 });
        made = true;
      }
      if (made && d === parent) {
        try {
          writeFileSync(join(parent, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' });
        } catch {
          // there already
        }
      }
    }
    const rel = relative(realpathSync(project.path), realpathSync(dir));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HttpError(500, 'the uploads folder leads outside the project; remove .shadowlap/uploads and try again');
  }

  /** Uploads a dashboard that stopped without closing left behind in `dir`, unused for the idle time. */
  private sweepLeftovers(dir: string): void {
    let names: string[];
    try {
      if (!lstatSync(dir).isDirectory()) return;
      names = readdirSync(dir);
    } catch {
      return;
    }
    const now = this.now();
    for (const n of names) {
      if (!FILE.test(n) && !FOLDER.test(n)) continue;
      const path = join(dir, n);
      try {
        const st = lstatSync(path);
        if (now - st.mtimeMs < this.maxIdleMs) continue;
        if (st.isFile() && FILE.test(n)) removeFile(path);
        else if (st.isDirectory() && FOLDER.test(n)) removeFolder(path);
      } catch {
        // gone already
      }
    }
  }
}
