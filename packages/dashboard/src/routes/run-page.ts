import { execFile } from 'node:child_process';
import { readConfigFile, type Normalizer, type ToolTrust } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { EXPORT_KINDS, exportDatasetJob, exportHarJob, exportHtmlJob, exportOtelJob, packJob } from '../run-exports.js';
import { choicesInCheckout } from '../commits-here.js';
import { runOffers } from '../run-offers.js';
import type { GoldenSource } from '../tests.js';

/**
 * The run page beyond the run itself: `GET /api/runs/:id/offers` (what the page offers to do with a
 * run: Share's redaction counts, Push, Run blame's check, Find the commit, the diverged test's
 * actions), `GET /api/runs/:id/show` (`shadowlap show --json`, for Provenance's Copy), and the Share
 * menu's job kinds: export-html, pack, export-dataset, export-otel and export-har.
 */

/**
 * The goldens on disk, when the dashboard was started with them (`DashboardOptions.goldens`, which
 * the Tests screen's routes need too): Find the commit then bisects a test replay's golden.
 */
function goldensOf(ctx: RouteContext): GoldenSource[] {
  const fn = (ctx.options as { goldens?: (() => unknown) | undefined }).goldens;
  if (typeof fn !== 'function') return [];
  try {
    const out: unknown = fn();
    return Array.isArray(out) ? (out as GoldenSource[]) : [];
  } catch {
    return [];
  }
}

const heads = new Map<string, { at: number; head: Promise<string | null> }>();

/**
 * The commit the project's HEAD is at (its full sha), or null outside a git repository: Find the
 * commit on a run that passed searches after the run's own commit up to it. Asked of git at most
 * every few seconds, since the page asks for its offers as runs change.
 */
function projectHead(path: string): Promise<string | null> {
  const now = Date.now();
  const known = heads.get(path);
  if (known && now - known.at < 3000) return known.head;
  const head = new Promise<string | null>((resolve) => {
    execFile('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: path, timeout: 2000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
  heads.set(path, { at: now, head });
  return head;
}

export function register(router: Router, ctx: RouteContext): void {
  const { store } = ctx;

  router.get('/runs/:id/offers', async (r) => {
    // A config that can't be read stops the copies when they run, with its reason; it doesn't stop the page.
    let redact: readonly Normalizer[];
    try {
      redact = ctx.options.loadConfig ? ctx.config().redact : (ctx.options.redact ?? []);
    } catch {
      redact = [];
    }
    let config: { store?: unknown; tests?: unknown; normalize?: unknown } | null = null;
    if (ctx.project) {
      try {
        const file = readConfigFile(ctx.project.path);
        config = file.exists ? file.data : null;
      } catch {
        config = null;
      }
    }
    const head = ctx.project ? await projectHead(ctx.project.path) : null;
    const offers = runOffers(store, r.params.id!, { redact, config, goldens: goldensOf(ctx), head });
    if (!offers) throw new HttpError(404, `no run ${r.params.id}`);
    // Find the commit offers only commits this checkout has: a teammate's pulled run names theirs.
    r.tagged(offers.bisect ? { ...offers, bisect: await choicesInCheckout(ctx.project?.path, offers.bisect) } : offers);
  });

  // Every call of the run: worked out beside the server (read-pool.ts).
  router.get('/runs/:id/show', async (r) => {
    // The config's trust marks, as the CLI reads them; a config mid-edit leaves them out rather than failing the copy.
    let tools: ToolTrust | undefined;
    try {
      tools = ctx.config().tools;
    } catch {
      tools = undefined;
    }
    sendAnswer(r, await ctx.reads.run({ kind: 'show', runId: r.params.id!, read: ctx.read, ...(tools ? { tools } : {}) }));
  });

  const { jobs, project } = ctx;
  jobs.registerJobKind(EXPORT_KINDS.html, { title: () => 'Exporting HTML', build: (req, b) => exportHtmlJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.pack, { title: () => 'Packing', build: (req, b) => packJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.dataset, { title: () => 'Exporting a dataset', build: (req, b) => exportDatasetJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.otel, { title: () => 'Exporting a trace', build: (req, b) => exportOtelJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.har, { title: () => 'Exporting HAR', build: (req, b) => exportHarJob(b.store, project, req) });
}
