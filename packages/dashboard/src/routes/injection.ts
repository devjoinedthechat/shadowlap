import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { InjectionPlan, ToolTrust } from '@shadowlap/engine';
import { lookupRun, noSuchRun } from '../api.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { budgetFlags, injectionJob, injectionNeedsLook, injectionResult, injectionResults, injectionTemplatesView, injectionTitle, keptInjection, payloadsRead } from '../injection.js';
import { injectionReportHtml, reportFile, reportPreview } from '../injection-report.js';
import type { InjectionReadInput } from '../injection-security.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { runAffinity } from '../run-index.js';
import { runVersionTag } from '../run-version.js';
import { namesTeamStore } from './verdicts.js';

/**
 * Injection tests: what `shadowlap injection` kept, for the pages that show it, and the job that
 * runs it.
 *
 *   GET /api/injection                    { results }: newest first; ?run=<id>, ?golden=<path>, ?limit=<n>
 *   GET /api/injection/templates          the built-in templates, versioned, for the dialog
 *   GET /api/injection/payloads           ?upload=<id>: { name, count, noCanary }, a payload file sent and not yet taken by a test
 *   GET /api/injection/estimate           ?run=<id> (or ?golden=<path>)&payloads=<n>&repeat=<n>&budget=<usd>, or &gate=1: { estimate },
 *                                         a dialog's plan priced; ?run=<id>&clean=<read>: Find cause…'s on that read
 *   GET /api/injection/security           { goldens, none, unread }: each golden's recording's untrusted reads, its last test, its test's price
 *   GET /api/injection/tools              { tools }: every recorded tool with its trust, for Settings → Tools
 *   GET /api/injection/needs-look         { items }: runs and goldens whose newest test obeyed, was influenced or is inconclusive
 *   GET /api/injection/runs/:id           { untrusted, results, rule, answers, cause, attempt }: a run's untrusted reads, its tests,
 *                                         Find cause…'s gate, answers and writes to ask about, and the test it is an attempt of
 *   GET /api/injection/:id                { row, report, gone, view }: one result, as --json printed it, and a plant's panel
 *   GET /api/injection/:id/report         the security report (HTML), the project's redaction rules applied;
 *                                         ?preview=1: { at, attempts, rules, masks, canaries, file }, what its dialog says first
 *
 *   job injection  { runId | golden, repeat?, templates?, payloadsUpload?, baselines?, budget?, clean?, writes?, liveReads?, again?, yes? }
 */

export const INJECTION_JOB_KIND = 'injection';

/** The config's trust marks. The config can be mid-edit: the trust it gives is left out rather than failing the page. */
export function configTools(ctx: RouteContext): ToolTrust | undefined {
  try {
    return ctx.config().tools;
  } catch {
    return undefined;
  }
}

/** What a pooled injection read is handed besides its kind: the trust marks, the goldens, the project's folder and the prices. */
export function injectionReadInput(ctx: RouteContext): InjectionReadInput {
  const tools = configTools(ctx);
  return { goldens: ctx.options.goldens?.() ?? [], project: ctx.project?.path ?? process.cwd(), ...(ctx.read.prices ? { prices: ctx.read.prices } : {}), ...(tools ? { tools } : {}) };
}

/** The most payloads a plan prices: every template and a payload file's. */
const MAX_PAYLOADS = 10_000;

/** A whole number from the query string, between `min` and `max`; undefined when absent. */
function wholeParam(raw: string | null, key: string, min: number, max: number): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!(Number.isInteger(n) && n >= min && n <= max)) throw new HttpError(400, `${key} is a whole number from ${min} to ${max}`);
  return n;
}

/** A dialog's picks as the estimators take them: the payloads planted, attempts each, and Stop at $ (checked as the job checks it). */
function planParams(q: URLSearchParams): InjectionPlan {
  const payloads = wholeParam(q.get('payloads'), 'payloads', 0, MAX_PAYLOADS);
  if (payloads === undefined) throw new HttpError(400, 'payloads is how many payloads the test plants');
  const repeat = wholeParam(q.get('repeat'), 'repeat', 1, 100);
  const raw = q.get('budget');
  const budget = raw === null || raw === '' ? [] : budgetFlags(Number(raw));
  if (!Array.isArray(budget)) throw new HttpError(400, budget.error);
  return { payloads, ...(repeat !== undefined ? { repeat } : {}), ...(budget.length ? { budget: Number(budget[1]) } : {}) };
}

/**
 * What a dialog's price is worked out on, with the ETag that says where it stands: a run of the store
 * (`run`), or a project's golden (`golden`), its recording where the store holds it, else the pack
 * that does, which stands as it was packed.
 */
function planTarget(ctx: RouteContext, q: URLSearchParams, asked: string): { runId: string; pack?: string; etag: string } {
  const golden = q.get('golden');
  const g = golden === null ? null : (ctx.options.goldens?.() ?? []).find((x) => x.path === golden);
  if (g === undefined) throw new HttpError(404, `no golden ${golden ?? ''} in this project`);
  const run = g ? (g.runId ? ctx.store.getRun(g.runId) : null) : lookupRun(ctx.store, q.get('run') ?? '');
  if (run) return { runId: run.runId, etag: runVersionTag(ctx.store, run, asked) };
  if (g) return { runId: g.runId ?? '', pack: join(ctx.project?.path ?? process.cwd(), g.path), etag: `"g${createHash('sha1').update(JSON.stringify([g.path, g.packedAt, asked])).digest('base64url')}"` };
  const no = noSuchRun(ctx.store, q.get('run') ?? '');
  throw new HttpError(no.status, no.message);
}

export function register(router: Router, ctx: RouteContext): void {
  const { store } = ctx;
  const goldens = () => ctx.options.goldens?.() ?? [];
  const tools = () => configTools(ctx);

  router.get('/injection', (r) => {
    const limit = r.query.get('limit');
    const n = limit === null ? undefined : Number(limit);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 1000)) throw new HttpError(400, 'limit is a whole number from 1 to 1000');
    r.tagged(injectionResults(store, { ...(r.query.get('run') ? { runId: r.query.get('run')! } : {}), ...(r.query.get('golden') ? { golden: r.query.get('golden')! } : {}), ...(n !== undefined ? { limit: n } : {}) }));
  });
  router.get('/injection/templates', (r) => r.tagged(injectionTemplatesView()));
  // A payload file once the dialog sent it: read before the test takes it, so the dialog can say what it holds.
  router.get('/injection/payloads', (r) => {
    const file = ctx.uploads.peek(r.query.get('upload'), ctx.project);
    if (!file) throw new HttpError(404, 'that payload file is gone: send it again');
    const read = payloadsRead(file);
    if ('error' in read) throw new HttpError(400, read.error);
    r.json(read);
  });
  // Tests' Security: each golden's recording's untrusted reads, its last test, and its test's price.
  // Revalidated from the store's change counters (a test's runs, its calls, the event it ends on), the
  // goldens, the trust marks and the prices: the palette asks as it opens, a 304 while nothing moved.
  router.get('/injection/security', async (r) => {
    const input = injectionReadInput(ctx);
    const etag = `"s${createHash('sha1').update(JSON.stringify([store.changeCounts(), input])).digest('base64url')}"`;
    if (r.req.headers['if-none-match'] === etag) {
      r.res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      r.res.end();
      return;
    }
    sendAnswer(r, await ctx.reads.run({ kind: 'injection-security', ...input }), { etag });
  });
  // A dialog's picks priced, asked again a moment after each pick, or Find cause…'s read: revalidated,
  // as a run's estimates are, from where the run (or the golden's pack) stands, the prices and the plan.
  router.get('/injection/estimate', async (r) => {
    const clean = wholeParam(r.query.get('clean'), 'clean', 1, Number.MAX_SAFE_INTEGER);
    const plan = clean === undefined ? planParams(r.query) : { payloads: 0 };
    const gate = r.query.get('gate') === '1';
    const trust = tools();
    const on = planTarget(ctx, r.query, JSON.stringify([ctx.read, trust ?? null, plan, gate, clean ?? null]));
    if (r.req.headers['if-none-match'] === on.etag) {
      r.res.writeHead(304, { etag: on.etag, 'cache-control': 'no-cache' });
      r.res.end();
      return;
    }
    const job = { kind: 'injection-estimate' as const, runId: on.runId, ...(on.pack ? { pack: on.pack } : {}), ...(clean !== undefined ? { clean } : {}), plan, gate, ...(ctx.read.prices ? { prices: ctx.read.prices } : {}), ...(trust ? { tools: trust } : {}) };
    sendAnswer(r, await ctx.reads.run(job, on.pack ? undefined : runAffinity(store, on.runId)), { etag: on.etag });
  });
  // Both read every call they are about, of a run or of every run: worked out beside the server.
  router.get('/injection/tools', async (r) => {
    const trust = tools();
    sendAnswer(r, await ctx.reads.run({ kind: 'tool-trust', ...(trust ? { tools: trust } : {}) }));
  });
  router.get('/injection/needs-look', (r) => r.tagged({ items: injectionNeedsLook(store) }));
  router.get('/injection/runs/:id', async (r) => {
    if (!store.getRun(r.params.id!)) throw new HttpError(404, `no run ${r.params.id!}`);
    const trust = tools();
    sendAnswer(r, await ctx.reads.run({ kind: 'injection-run', runId: r.params.id!, ...(trust ? { tools: trust } : {}) }, runAffinity(ctx.store, r.params.id!)));
  });
  router.get('/injection/:id', (r) => {
    const found = injectionResult(store, r.params.id!, { shared: namesTeamStore(ctx.project?.path) });
    if (!found) throw new HttpError(404, `no injection result ${r.params.id!}`);
    r.tagged(found);
  });
  router.get('/injection/:id/report', (r) => {
    // The report reads the result alone: neither the runs it names nor the panel's view.
    const found = keptInjection(store, r.params.id!);
    if (!found) throw new HttpError(404, `no injection result ${r.params.id!}`);
    const redact = ctx.options.loadConfig ? ctx.config().redact : (ctx.options.redact ?? []);
    // ?preview=1: what the dialog says before the download, from the same masks.
    if (r.query.get('preview') === '1') return r.tagged(reportPreview(found.report, redact, found.row));
    const html = injectionReportHtml([found.report], { redact, version: ctx.options.version ?? null });
    r.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="${reportFile(found.row.runId)}"`,
      'x-shadowlap-redacted': redact.length ? 'yes' : 'no',
      'cache-control': 'no-store',
    });
    r.res.end(html);
  });

  ctx.jobs.registerJobKind(INJECTION_JOB_KIND, {
    title: injectionTitle,
    build: (req, b) => injectionJob(req, b, goldens()),
  });
}
