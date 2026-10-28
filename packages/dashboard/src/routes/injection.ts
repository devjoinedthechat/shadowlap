import { describeEvent } from '../activity.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { injectionJob, injectionNeedsLook, injectionResult, injectionResults, injectionTemplatesView } from '../injection.js';
import { injectionReportHtml } from '../injection-report.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { runAffinity } from '../run-index.js';

/**
 * Injection tests: what `shadowlap injection` kept, for the pages that show it, and the job that
 * runs it.
 *
 *   GET /api/injection                    { results }: newest first; ?run=<id>, ?golden=<path>, ?limit=<n>
 *   GET /api/injection/templates          the built-in templates, versioned, for the dialog
 *   GET /api/injection/tools              { tools }: every recorded tool with its trust, for Settings → Tools
 *   GET /api/injection/needs-look         { items }: runs and goldens whose newest test obeyed, was influenced or is inconclusive
 *   GET /api/injection/runs/:id           { untrusted, results, attempt }: a run's untrusted reads, its tests, and the test it is an attempt of
 *   GET /api/injection/:id                { row, report, gone }: one result, as --json printed it
 *   GET /api/injection/:id/report         the security report (HTML), the project's redaction rules applied
 *
 *   job injection  { runId | golden, repeat?, templates?, payloadsUpload?, baselines?, clean?, writes?, liveReads?, yes? }
 */

export const INJECTION_JOB_KIND = 'injection';

// The activity feed: what a test showed, opening the run it tested. One that obeyed or failed its gate
// reads as a failure, one inconclusive (or influenced) in amber, never as a test that passed.
describeEvent('injection.tested', (e, d) => {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const name = typeof e.ref === 'string' && !e.ref.startsWith('inj-') ? e.ref : e.runId ? e.runId.slice(0, 10) : 'a run';
  if (d.mode === 'clean') {
    if (d.verdict === 'inconclusive') return { kind: 'warn', text: `Injection · ${name}: inconclusive, whether #${n(d.read)} caused the writes` };
    return { kind: d.verdict === 'caused' ? 'fail' : 'test', text: `Injection · ${name}: ${typeof d.verdict === 'string' ? d.verdict : 'tested'} by #${n(d.read)}` };
  }
  const text = n(d.obeyed)
    ? `obeyed a planted instruction in ${n(d.obeyed)} of ${n(d.attempts)} attempts`
    : n(d.influenced)
      ? `influenced in ${n(d.influenced)} of ${n(d.attempts)} attempts`
      : d.gate === 'inconclusive'
        ? `inconclusive after ${n(d.attempts)} attempts`
        : n(d.inconclusive)
          ? `ignored every planted instruction in ${n(d.ignored)} of ${n(d.attempts)} attempt${n(d.attempts) === 1 ? '' : 's'}, ${n(d.inconclusive)} inconclusive`
          : `ignored every planted instruction (${n(d.attempts)} attempts)`;
  return { kind: n(d.obeyed) || d.gate === 'failed' ? 'fail' : d.gate === 'inconclusive' || n(d.influenced) ? 'warn' : 'test', text: `Injection · ${name}: ${text}` };
});

export function register(router: Router, ctx: RouteContext): void {
  const { store } = ctx;
  const goldens = () => ctx.options.goldens?.() ?? [];
  // The config can be mid-edit: the trust it gives is left out rather than failing the page.
  const tools = () => {
    try {
      return ctx.config().tools;
    } catch {
      return undefined;
    }
  };

  router.get('/injection', (r) => {
    const limit = r.query.get('limit');
    const n = limit === null ? undefined : Number(limit);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 1000)) throw new HttpError(400, 'limit is a whole number from 1 to 1000');
    r.tagged(injectionResults(store, { ...(r.query.get('run') ? { runId: r.query.get('run')! } : {}), ...(r.query.get('golden') ? { golden: r.query.get('golden')! } : {}), ...(n !== undefined ? { limit: n } : {}) }));
  });
  router.get('/injection/templates', (r) => r.tagged(injectionTemplatesView()));
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
    const found = injectionResult(store, r.params.id!);
    if (!found) throw new HttpError(404, `no injection result ${r.params.id!}`);
    r.tagged(found);
  });
  router.get('/injection/:id/report', (r) => {
    const found = injectionResult(store, r.params.id!);
    if (!found) throw new HttpError(404, `no injection result ${r.params.id!}`);
    const redact = ctx.options.loadConfig ? ctx.config().redact : (ctx.options.redact ?? []);
    const html = injectionReportHtml([found.report], { redact, version: ctx.options.version ?? null });
    r.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="shadowlap-injection-${found.row.runId.slice(0, 10).toLowerCase()}.html"`,
      'x-shadowlap-redacted': redact.length ? 'yes' : 'no',
      'cache-control': 'no-store',
    });
    r.res.end(html);
  });

  ctx.jobs.registerJobKind(INJECTION_JOB_KIND, {
    title: (req) => (req.clean !== undefined ? 'Testing whether the read caused the writes' : 'Testing for injection'),
    build: (req, b) => injectionJob(req, b, goldens()),
  });
}
