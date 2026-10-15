import { createWriteStream, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
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
 * dashboard closes.
 */

export const UPLOAD_LIMIT = 64 * 1024 * 1024;
export const UPLOAD_MAX_IDLE_MS = 60 * 60 * 1000;
/** Uploads kept at once, counting those still arriving: enough for a batch of imports, not enough to fill a disk by mistake. */
export const MAX_UPLOADS = 32;
const SWEEP_EVERY_MS = 5 * 60 * 1000;
const FILE = /^[0-9A-Z]{26}-[\w.-]+$/;

interface Upload {
  id: string;
  name: string;
  path: string;
  bytes: number;
  lastUsed: number;
  /** The job that claimed it, or null while nobody has. */
  jobId: string | null;
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
    if (!o.readOnly) this.sweepLeftovers();
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
    const dir = this.dir;
    if (this.o.readOnly) throw new HttpError(403, 'this dashboard is read-only: it takes no uploads');
    if (!dir || !this.o.project) throw new HttpError(501, 'uploads need a project folder: start the dashboard in your project with shadowlap dashboard');
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
      this.ensureDir(dir);
      bytes = await this.write(req, path);
    } catch (err) {
      throw this.closed ? new HttpError(503, 'the dashboard is stopping') : err;
    } finally {
      this.arriving--;
    }
    if (this.closed) {
      // The dashboard stopped while it arrived: nothing is kept after close.
      removeFile(path);
      if (!this.arriving) this.removeDir();
      throw new HttpError(503, 'the dashboard is stopping');
    }
    this.uploads.set(id, { id, name, path, bytes, lastUsed: this.now(), jobId: null });
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
        out.once('close', () => removeFile(path));
        out.destroy();
        reject(err);
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

  /** The upload for a job that asked for it by id, or null for an unknown id or one another job holds. */
  claim(uploadId: unknown, jobId: string): { path: string; name: string; bytes: number } | null {
    if (typeof uploadId !== 'string' || !/^[0-9A-Z]{26}$/.test(uploadId)) return null;
    const u = this.uploads.get(uploadId);
    if (!u || (u.jobId !== null && u.jobId !== jobId)) return null;
    u.jobId = jobId;
    u.lastUsed = this.now();
    return { path: u.path, name: u.name, bytes: u.bytes };
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
    if (!this.arriving) this.removeDir();
  }

  private removeDir(): void {
    const dir = this.dir;
    if (!dir || this.o.readOnly) return;
    try {
      rmdirSync(dir); // only when empty: another dashboard on this project may be using it
    } catch {
      // not empty, or never made
    }
  }

  private remove(u: Upload): void {
    this.uploads.delete(u.id);
    removeFile(u.path);
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
  private ensureDir(dir: string): void {
    const project = this.o.project!;
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

  /** Uploads a dashboard that stopped without closing left behind, unused for the idle time. */
  private sweepLeftovers(): void {
    const dir = this.dir;
    if (!dir) return;
    let names: string[];
    try {
      if (!lstatSync(dir).isDirectory()) return;
      names = readdirSync(dir);
    } catch {
      return;
    }
    const now = this.now();
    for (const n of names) {
      if (!FILE.test(n)) continue;
      const path = join(dir, n);
      try {
        const st = lstatSync(path);
        if (st.isFile() && now - st.mtimeMs >= this.maxIdleMs) removeFile(path);
      } catch {
        // gone already
      }
    }
  }
}
