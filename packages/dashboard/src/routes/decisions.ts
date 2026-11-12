import type { RouteContext } from '../context.js';
import { decisionSessions, decisionsJob, decisionsReadJob, limitsRefused, READING_TREE, migrateJob, previewRequest, retirementsView, verifyFlaggedJob } from '../decisions.js';
import { HttpError } from '../http.js';
import { modelChoices } from '../model-listing.js';
import { outcomeWork } from '../outcome-work.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { loadRunIndex, runAffinity } from '../run-index.js';
import type { GoldenSource } from '../tests.js';
import { verifyRule } from './estimates.js';

/**
 * The decision diff (`shadowlap decisions`, `migrate`), for the Changes page and a run's Decisions view:
 *
 *   GET /api/decisions[?kind=decisions|migrate][&limit=]   the sessions kept, newest first (50, at most 200), the project's goldens, and their models that retire
 *   GET /api/decisions/:id                       one session whole (`dc-…` or `mg-…`): its report, its matrix, and its `view` (decision-view.ts), beside the server
 *   GET /api/decisions/:id/estimates[?runId=…][&max=&keptMax=]   what its Verify bills (estimates.ts), on every run it could not clear or those the runIds name, at Run more attempts' limits where given
 *   GET /api/decisions/estimates?runId=…|golden=…|goldens=all[&model=&set=k=v&from=&scope=&samples=&fromCode=1]   what a new preview asks and bills (preview-estimate.ts), each way's card while no change is named
 *   GET /api/model-choices                       the models a preview's field offers beside the runs' own: each provider's own listing, and why one couldn't be listed (model-listing.ts)
 *   GET /api/runs/:id/decisions                  a run's decisions under each session that asked it again, beside the server
 *   GET /api/retirements                         the models the goldens use that retire, by the table that ships
 *   POST /api/jobs { kind: "decisions", runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?, thenVerify?, yes? }
 *   POST /api/jobs { kind: "migrate", to, goldens?, runs?, from?, scope?, set?, yes? }   every golden when none are named
 *   POST /api/jobs { kind: "decisions-verify", sessionId, runId?, runIds?, max?, keptMax?, yes? }   decisions --verify: the runs a session could not clear (or those named), each under its checks; Run more attempts' limits, a failing run's attempts and a good run's pairs
 *
 * The goldens a job may name are the project's (`DashboardOptions.goldens`); runs are ids in the store.
 */

const KINDS = new Set(['decisions', 'migrate']);

/** Run more attempts' raised limits from the query (`?max=&keptMax=`), refused in its job's words. */
function limitsParam(q: URLSearchParams): { max?: number; keptMax?: number } {
  const read = (name: string) => (q.has(name) ? Number(q.get(name)) : undefined);
  const max = read('max');
  const keptMax = read('keptMax');
  const refused = limitsRefused(max, keptMax);
  if (refused) throw new HttpError(400, refused);
  return { ...(max !== undefined ? { max } : {}), ...(keptMax !== undefined ? { keptMax } : {}) };
}

/** A value a query's `set=field=value` gives: JSON where it parses, as a dialog sends a typed value, else the text. */
function setParam(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * How the project compares a step's two decisions, for an opened cell's cost line: whether it redacts,
 * and its clock (`exact`, or dates near the run's start masked). A config that can't be read doesn't
 * stop Preview: the line then leaves out what it would have said of it.
 */
function comparedBy(ctx: RouteContext): { redacted: boolean; clock: 'auto' | 'exact' | null } {
  try {
    const config = ctx.config();
    return { redacted: config.redact.length > 0, clock: config.clock === 'exact' ? 'exact' : 'auto' };
  } catch {
    return { redacted: false, clock: null };
  }
}

export function register(router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];

  router.get('/decisions', (r) => {
    const kind = r.query.get('kind');
    if (kind !== null && !KINDS.has(kind)) throw new HttpError(400, 'kind is decisions or migrate');
    const limit = Math.max(1, Math.min(200, Number(r.query.get('limit') ?? 50) || 50));
    r.tagged({ sessions: decisionSessions(ctx.store, { limit, ...(kind ? { kind: kind as 'decisions' | 'migrate' } : {}) }), goldens: goldens().length, retirements: retirementsView(ctx.store, goldens()) });
  });

  // A session's runs hold every step's two decisions, and their about lines read requests: worked out beside the server.
  router.get('/decisions/:id', async (r) => {
    const { byId } = loadRunIndex(ctx.store);
    const calls = ctx.store.decisionRunIds(r.params.id!).reduce((n, id) => n + (byId.get(id)?.calls ?? 0), 0);
    sendAnswer(r, await ctx.reads.run({ kind: 'decision-session', sessionId: r.params.id!, ...comparedBy(ctx), keptMax: verifyRule(ctx).keptMax }, { calls }));
  });

  // What a new preview would ask and bill, beside the server, by the runs' calls: the change as its
  // job takes it (previewRequest), or none, for each way's card. A switch's card is priced at the
  // model its field starts on, from the providers' listing (asked here, off the read pool).
  router.get('/decisions/estimates', async (r) => {
    const q = r.query;
    const goldenNames = q.get('goldens') === 'all' ? 'all' : q.getAll('golden');
    const set: Record<string, unknown> = {};
    for (const pair of q.getAll('set')) {
      const at = pair.indexOf('=');
      if (at < 1) throw new HttpError(400, 'set is field=value, such as max_tokens=512');
      const text = pair.slice(at + 1);
      set[pair.slice(0, at)] = setParam(text);
    }
    const req = {
      ...(q.has('runId') ? { runs: q.getAll('runId') } : {}),
      ...(goldenNames === 'all' || goldenNames.length ? { goldens: goldenNames } : {}),
      ...(q.has('model') ? { model: q.get('model') } : {}),
      ...(Object.keys(set).length ? { set } : {}),
      ...(q.has('from') ? { from: q.getAll('from') } : {}),
      ...(q.has('scope') ? { scope: q.get('scope') } : {}),
      ...(q.has('samples') ? { samples: Number(q.get('samples')) } : {}),
      ...(q.get('fromCode') === '1' ? { fromCode: true } : {}),
    };
    const p = previewRequest(req, ctx.store, goldens());
    if ('error' in p) throw new HttpError(p.status ?? 400, p.error);
    const runIds = [...new Set(p.targets.runIds)].filter((id) => ctx.store.getRun(id));
    const unrecorded = p.targets.packs.filter((path) => {
      const id = goldens().find((g) => g.path === path)?.runId;
      return !id || !runIds.includes(id);
    }).length;
    const named = p.model !== null || p.set.length > 0 || p.fromCode;
    const offered = named ? null : await modelChoices(ctx);
    const listed = offered ? [...offered.choices, ...offered.priced] : [];
    const { byId } = loadRunIndex(ctx.store);
    const calls = runIds.reduce((n, id) => n + (byId.get(id)?.calls ?? 0), 0);
    const job = { kind: 'preview-estimate' as const, runIds, unrecorded, targets: p.targets.args, model: p.model, set: p.set, from: p.from, scope: p.scope, samples: p.samples, fromCode: p.fromCode, listed, ...(ctx.read.prices ? { prices: ctx.read.prices } : {}) };
    sendAnswer(r, await ctx.reads.run(job, { calls }));
  });

  // The models a preview's field offers beside the runs' own: the providers' own listings, kept a few seconds.
  router.get('/model-choices', async (r) => r.tagged(await modelChoices(ctx)));

  // What Verify would bill on a kept session, or on the one run `runId` names, beside the server: it
  // judges each run's recording by its checks, which reads its calls. Asked apart from the session.
  router.get('/decisions/:id/estimates', async (r) => {
    const { byId } = loadRunIndex(ctx.store);
    const calls = ctx.store.decisionRunIds(r.params.id!).reduce((n, id) => n + (byId.get(id)?.calls ?? 0), 0);
    const runIds = r.query.getAll('runId').map((id) => id.trim()).filter(Boolean).slice(0, 500);
    const job = { kind: 'decision-estimates' as const, sessionId: r.params.id!, runIds, work: outcomeWork(ctx), rule: verifyRule(ctx), ...limitsParam(r.query), ...(ctx.read.prices ? { prices: ctx.read.prices } : {}) };
    sendAnswer(r, await ctx.reads.run(job, { calls }));
  });

  // Each session that asked the run again words its row and its steps from every decision it kept: beside the server, by the run's calls.
  router.get('/runs/:id/decisions', async (r) => {
    const run = ctx.store.getRun(r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id!.slice(0, 40)}`);
    sendAnswer(r, await ctx.reads.run({ kind: 'run-decisions', runId: run.runId, keptMax: verifyRule(ctx).keptMax }, runAffinity(ctx.store, run.runId)));
  });

  router.get('/retirements', (r) => r.tagged(retirementsView(ctx.store, goldens())));

  // A golden's pack is read from the project's folder, which is where a job runs the CLI.
  const folder = (b: { project: { path: string } | null }) => b.project?.path ?? process.cwd();
  ctx.jobs.registerJobKind('decisions', { title: () => 'Previewing a change', build: (req, b) => decisionsJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('decisions-read', { title: () => READING_TREE, build: (req, b) => decisionsReadJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('migrate', { title: () => 'Migrating', build: (req, b) => migrateJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('decisions-verify', { title: () => 'Verifying the changed runs', build: (req, b) => verifyFlaggedJob(req, b.store, folder(b)) });
}
