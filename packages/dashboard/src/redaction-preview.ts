import { Worker } from 'node:worker_threads';
import { previewRedaction, regexProblem, type Normalizer, type RedactionPreview, type Store } from '@shadowlap/engine';

/**
 * The Redaction tab's preview, read where it can't hold up the dashboard server: every rule runs
 * over the run's stored requests and responses, which takes a while on a long run, and a pattern
 * like (a+)+ can take minutes on one value. So it runs on a worker thread of its own, against the
 * store file, within limits: it stops between calls once it has read enough calls or bytes or used
 * its time (the preview then says how far it got), and the thread is ended where it is when one
 * call takes too long, or when the page stops waiting for it.
 */

export interface PreviewLimitsConfig {
  /** Calls read at most. */
  maxCalls: number;
  /** Bytes of stored requests and responses read at most. */
  maxBytes: number;
  /** After this long reading, no further call is read: the preview says how far it got. */
  softMs: number;
  /** After this long reading, the thread is ended where it is, inside one call: a rule took too long on it. */
  hardMs: number;
  /** How long opening the store may take (another command holding it): past that, the page asks again. */
  openMs: number;
  /** Previews read at once; past that, one is refused until another ends. */
  workers: number;
}

/** What a preview may read and how long it may take. The server reads these for every preview; tests lower them. */
export const PREVIEW_LIMITS: PreviewLimitsConfig = { maxCalls: 2000, maxBytes: 64 * 1024 * 1024, softMs: 5000, hardMs: 10_000, openMs: 15_000, workers: 2 };

/** What the worker is given: the store's file, the run, the rules as the config has them, the limits. */
export interface PreviewWork {
  dbPath: string;
  runId: string;
  rules: Normalizer[];
  limits: Pick<PreviewLimitsConfig, 'maxCalls' | 'maxBytes' | 'softMs'>;
}

/** What it posts back: that the store is open (its reading starts), then the preview or why there is none. */
export type PreviewAnswer = { type: 'open' } | { type: 'answer'; ok: true; preview: RedactionPreview } | { type: 'answer'; ok: false; error: string; busy: boolean };

/** The store is busy, as SQLite says when another command held it past its wait. */
export const BUSY = /database is locked|SQLITE_BUSY/i;

/** Why a preview has no answer, with the HTTP status the route answers with. */
export class PreviewError extends Error {
  override readonly name = 'PreviewError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The worker's script: beside this module once built (dist/). Run from its TypeScript source (the
 * tests), this module starts the built script, since Node starts a worker from JavaScript.
 */
function workerScript(): URL {
  const here = new URL(import.meta.url);
  return here.pathname.endsWith('.ts') ? new URL('../dist/redaction-preview-worker.js', here) : new URL('./redaction-preview-worker.js', here);
}

let reading = 0;
/** Threads asked to end and not yet gone: each holds the store's file open until it is. */
const ending = new Set<Promise<unknown>>();

/**
 * Resolves once every preview thread asked to end has ended and let go of the store's file. The
 * dashboard waits for it when it closes: Windows can't delete or move a file another thread holds.
 */
export async function previewsEnded(): Promise<void> {
  await Promise.allSettled([...ending]);
}

/**
 * The preview of one run, read on a worker thread against the store at `dbPath`. Resolves with the
 * preview (partial when a limit stopped it between calls); rejects with a PreviewError when every
 * thread is busy or another command holds the store (503), when one call took longer than `hardMs`
 * (422, naming a rule whose pattern repeats a repeated group), when the page stopped waiting
 * (`signal`), or with what the worker said.
 */
export function previewApart(work: { dbPath: string; runId: string; rules: Normalizer[] }, o: { signal?: AbortSignal; limits?: PreviewLimitsConfig } = {}): Promise<RedactionPreview> {
  const limits = o.limits ?? PREVIEW_LIMITS;
  if (o.signal?.aborted) return Promise.reject(new PreviewError(499, 'the page stopped waiting for the preview'));
  if (reading >= limits.workers) return Promise.reject(new PreviewError(503, 'Other previews are still being read: pick the run again in a moment.'));
  reading++;
  return new Promise<RedactionPreview>((resolve, reject) => {
    const data: PreviewWork = { ...work, limits: { maxCalls: limits.maxCalls, maxBytes: limits.maxBytes, softMs: limits.softMs } };
    // A heap of its own, capped: a preview never takes the server's memory with it.
    const worker = new Worker(workerScript(), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      reading--;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', stop);
      const ended = worker.terminate().catch(() => undefined);
      ending.add(ended);
      void ended.finally(() => ending.delete(ended));
      done();
    };
    const busy = () => new PreviewError(503, 'The store is busy with another command: pick the run again in a moment.');
    // Until the store is open, another command may be holding it; from then on, the reading's own time.
    let timer = setTimeout(() => settle(() => reject(busy())), limits.openMs);
    const stop = () => settle(() => reject(new PreviewError(499, 'the page stopped waiting for the preview')));
    o.signal?.addEventListener('abort', stop, { once: true });
    worker.on('message', (m: PreviewAnswer) => {
      if (m.type === 'open') {
        clearTimeout(timer);
        timer = setTimeout(() => settle(() => reject(new PreviewError(422, tookTooLong(work.rules, limits.hardMs)))), limits.hardMs);
        return;
      }
      settle(() => (m.ok ? resolve(m.preview) : reject(m.busy ? busy() : new PreviewError(500, m.error))));
    });
    worker.once('error', (err) => settle(() => reject(new PreviewError(500, `the preview stopped: ${err.message}`))));
    worker.once('exit', (code) => settle(() => reject(new PreviewError(500, `the preview stopped before it answered (exit code ${code})`))));
  });
}

/**
 * The preview in this thread, within the same limits but for the one that ends a call taking too
 * long: for a store with no file of its own, which a worker can't open (a store in memory).
 */
export function previewHere(store: Store, runId: string, rules: Normalizer[], limits: PreviewLimitsConfig = PREVIEW_LIMITS): RedactionPreview {
  return previewRedaction(store, runId, rules, { maxCalls: limits.maxCalls, maxBytes: limits.maxBytes, deadline: Date.now() + limits.softMs });
}

/**
 * The first rule whose regex the engine's pattern check refuses (safe-regex.ts), with its reason;
 * null when it takes them all. A pattern it takes is never blamed for taking too long: what it
 * refuses is what can take time that grows exponentially with the text.
 */
export function refusedRule(rules: readonly Normalizer[]): { n: number; pattern: string; why: string } | null {
  for (const [i, r] of rules.entries()) {
    const m = r.pattern === undefined ? null : /^\/(.*)\/([a-z]*)$/s.exec(r.pattern);
    const why = m ? regexProblem(m[1]!, m[2]!) : null;
    if (why) return { n: i + 1, pattern: r.pattern!, why };
  }
  return null;
}

/** What the page says when one call took longer than the preview may: a rule the engine refuses, when one is among them. */
export function tookTooLong(rules: readonly Normalizer[], ms: number): string {
  const seconds = `${Math.round(ms / 1000)} s`;
  const refused = refusedRule(rules);
  if (!refused) return `The preview stopped after ${seconds} on one call: a rule takes that long on this run’s text, and would in a pack too.`;
  return `The preview stopped after ${seconds} on one call. Rule #${refused.n}, ${refused.pattern}: ${refused.why}.`;
}
