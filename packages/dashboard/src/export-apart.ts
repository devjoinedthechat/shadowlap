import { Worker } from 'node:worker_threads';
import type { Normalizer, Price } from '@shadowlap/engine';
import { repeatsARepeat } from './redaction-preview.js';
import type { ExportHtmlResult } from './static.js';

/**
 * The HTML download (`GET /api/runs/:id/export`), made where it can't hold up the dashboard server.
 * The file holds every request and response of the run and the runs it came from, each masked by the
 * project's redaction rules: a long run takes seconds, and a pattern like (a+)+ can take minutes on
 * one value. So the file is made on a worker thread of its own, against the store file, and the
 * thread is ended when it takes too long; the page then says which rule is the likely cause.
 */

export interface ExportLimits {
  /** After this long making the file, the thread is ended where it is. */
  hardMs: number;
  /** How long opening the store may take (another command holding it): past that, the page asks again. */
  openMs: number;
  /** Files made at once; past that, one is refused until another is done. */
  workers: number;
}

/** What a download may take. The server reads these for every download; tests lower them. */
export const EXPORT_LIMITS: ExportLimits = { hardMs: 120_000, openMs: 15_000, workers: 2 };

/** What the worker is given: the store's file and what `exportHtml` takes besides the store. */
export interface ExportWork {
  dbPath: string;
  runIds: string[];
  redact: Normalizer[];
  prices?: Record<string, Price>;
  version: string | null;
  uiDir?: string;
}

/** What it posts back: that the store is open (making the file starts), then the file or why there is none. */
export type ExportAnswer = { type: 'open' } | { type: 'answer'; ok: true; result: ExportHtmlResult } | { type: 'answer'; ok: false; error: string; busy: boolean };

/** Why there is no file, with the HTTP status the route answers with. */
export class ExportError extends Error {
  override readonly name = 'ExportError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The worker's script, beside this module once built; run from the TypeScript source (the tests), the built one. */
function workerScript(): URL {
  const here = new URL(import.meta.url);
  return here.pathname.endsWith('.ts') ? new URL('../dist/export-apart-worker.js', here) : new URL('./export-apart-worker.js', here);
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** What the page says when making the file took too long: the rule most likely at fault, when one has the shape, else the terminal's way. */
export function exportTookTooLong(rules: readonly Normalizer[], ms: number, runId: string): string {
  const suspect = rules.findIndex((r) => r.pattern !== undefined && repeatsARepeat(r.pattern));
  const head = `Making the HTML file took longer than ${minutes(ms)}, so it was stopped.`;
  if (suspect >= 0) return `${head} Redaction rule #${suspect + 1}, ${rules[suspect]!.pattern}, repeats a group that repeats itself, which can take minutes on some text: write it without the outer repeat.`;
  return `${head} A redaction rule may take that long on this run’s text, or the run is too long for a download: shadowlap export html ${runId.slice(0, 10)} --lineage makes the file from a terminal.`;
}

let making = 0;
/** Threads asked to end and not yet gone: one stopped for taking too long holds the store's file open until it is. */
const ending = new Set<Promise<unknown>>();

/**
 * Resolves once every thread making a file that was asked to end has ended and let go of the
 * store's file. The dashboard waits for it when it closes: Windows can't delete or move a file
 * another thread holds.
 */
export async function exportsEnded(): Promise<void> {
  await Promise.allSettled([...ending]);
}

/**
 * The HTML file of `work.runIds` (the run and the runs it came from), made on a worker thread
 * against the store at `work.dbPath`. Rejects with an ExportError when other files are being made
 * or another command holds the store (503), when making it took longer than `hardMs` (422, naming
 * the likely rule), or with what the worker said (500).
 */
export function exportHtmlApart(work: ExportWork, o: { limits?: ExportLimits } = {}): Promise<ExportHtmlResult> {
  const limits = o.limits ?? EXPORT_LIMITS;
  if (making >= limits.workers) return Promise.reject(new ExportError(503, 'Other HTML files are being made: download it again in a moment.'));
  making++;
  return new Promise<ExportHtmlResult>((resolve, reject) => {
    // A heap of its own, capped: a big file never takes the server's memory with it.
    const worker = new Worker(workerScript(), { workerData: work, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      making--;
      clearTimeout(timer);
      const ended = worker.terminate().catch(() => undefined);
      ending.add(ended);
      void ended.finally(() => ending.delete(ended));
      done();
    };
    const busy = () => new ExportError(503, 'The store is busy with another command: download it again in a moment.');
    let timer = setTimeout(() => settle(() => reject(busy())), limits.openMs);
    worker.on('message', (m: ExportAnswer) => {
      if (m.type === 'open') {
        clearTimeout(timer);
        timer = setTimeout(() => settle(() => reject(new ExportError(422, exportTookTooLong(work.redact, limits.hardMs, work.runIds.at(-1) ?? '')))), limits.hardMs);
        return;
      }
      settle(() => (m.ok ? resolve(m.result) : reject(m.busy ? busy() : new ExportError(500, m.error))));
    });
    worker.once('error', (err) => settle(() => reject(new ExportError(500, `making the file stopped: ${err.message}`))));
    worker.once('exit', (code) => settle(() => reject(new ExportError(500, `making the file stopped before it was done (exit code ${code})`))));
  });
}

