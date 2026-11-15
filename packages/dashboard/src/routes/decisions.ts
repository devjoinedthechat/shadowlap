import { ACTIONS } from '@shadowlap/engine';
import { lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import { MODEL_NAME, tooManyToPreview } from '../decisions-argv.js';
import { budgetArg, decisionSessions, decisionsJob, decisionsReadJob, limitsRefused, READING_TREE, migrateApplyJob, migrateJob, previewRequest, scopeArgs, verifyFlaggedJob } from '../decisions.js';
import { HttpError } from '../http.js';
import { modelChoices } from '../model-listing.js';
import { outcomeWork } from '../outcome-work.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { loadRunIndex, runAffinity } from '../run-index.js';
import type { GoldenSource } from '../tests.js';
import { verifyRule } from './estimates.js';
import { namesTeamStore } from './verdicts.js';

/**
 * The decision diff (`shadowlap decisions`, `migrate`), for the Changes page and a run's Decisions view:
 *
 *   GET /api/decisions[?kind=decisions|migrate][&limit=]   the sessions kept, newest first (50, at most 200), `more` where older ones are left out, and how many goldens the project has
 *   GET /api/decisions/:id                       one session whole (`dc-…` or `mg-…`): its report, its matrix, its `view` (decision-view.ts), and a migration's `migration` (migrate-view.ts) with its applied state, beside the server
 *   GET /api/decisions/:id/estimates[?runId=…][&max=&keptMax=]   what its Verify bills (estimates.ts), on every run it could not clear or those the runIds name, at Run more attempts' limits where given
 *   POST /api/decisions/estimates { runs?, goldens?, model?, set?, from?, scope?, samples?, fromCode?, changed?, budget?, thenVerify? }   what a new preview asks and bills (preview-estimate.ts), each way's card while no change is named, and the scopes its runs' calls were made in; changes nothing
 *   GET /api/model-choices                       the models a preview's field offers beside the runs' own: each provider's own listing, and why one couldn't be listed (model-listing.ts)
 *   GET /api/runs/:id/decisions                  a run's decisions under each session that asked it again, beside the server
 *   GET /api/migrate/estimate?to=&from=&golden=&run=&scope=&budget=   what Migrate to <model> bills (migrate-estimate.ts), on the goldens and runs named or every golden, as its job asks them, held to its Stop at $, and the newest preview of the same switch
 *   GET /api/migrate/start                       what Migrate opens on (migrate-start.ts): the goldens' retiring models with their goldens, scopes and the migration that checked each, and the models in use
 *   POST /api/jobs { kind: "decisions", runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?, thenVerify?, yes? }
 *   POST /api/jobs { kind: "migrate", to, goldens?, runs?, from?, scope?, set?, yes? }   every golden when none are named
 *   POST /api/jobs { kind: "migrate-apply", migrationId }   migrate apply: a kept migration's config change into the working tree, its goldens replayed offline
 *   POST /api/jobs { kind: "decisions-verify", sessionId, runId?, runIds?, max?, keptMax?, yes? }   decisions --verify: the runs a session could not clear (or those named), each under its checks; Run more attempts' limits, a failing run's attempts and a good run's pairs
 *
 * The goldens a job may name are the project's (`DashboardOptions.goldens`); runs are ids in the store.
 */

const KINDS = new Set(['decisions', 'migrate']);

/** The runs Migrate to's price names by id (`?run=`), as its job takes them: each of the store's, at most as many as one preview takes. */
function migrateRuns(ctx: RouteContext, ids: readonly string[]): string[] {
  const many = tooManyToPreview(ids.length);
  if (many) throw new HttpError(400, many);
  return ids.map((id) => {
    const run = lookupRun(ctx.store, id);
    if (!run) throw new HttpError(404, `no run ${id.slice(0, 40)}`);
    return run.runId;
  });
}

/** Run more attempts' raised limits from the query (`?max=&keptMax=`), refused in its job's words. */
function limitsParam(q: URLSearchParams): { max?: number; keptMax?: number } {
  const read = (name: string) => (q.has(name) ? Number(q.get(name)) : undefined);
  const max = read('max');
  const keptMax = read('keptMax');
  const refused = limitsRefused(max, keptMax);
  if (refused) throw new HttpError(400, refused);
  return { ...(max !== undefined ? { max } : {}), ...(keptMax !== undefined ? { keptMax } : {}) };
}

/**
 * The calls a working tree's change asks, as Preview changed prompt's read of it named them
 * (`changed`: each run's call numbers by its id), in `runIds`' order; null where it names none, so
 * the change has no estimate yet. A run it doesn't name asks nothing.
 */
function changedCalls(raw: unknown, runIds: readonly string[]): number[][] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'changed maps each run id to the numbers of its calls the working tree changes');
  const byRun = raw as Record<string, unknown>;
  return runIds.map((id) => {
    const nos = byRun[id];
    if (nos === undefined) return [];
    if (!Array.isArray(nos) || nos.length > 100_000 || nos.some((n) => !Number.isInteger(n) || (n as number) < 1)) throw new HttpError(400, 'changed maps each run id to the numbers of its calls the working tree changes');
    return nos as number[];
  });
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
    // One past the limit, to say whether older sessions are left out.
    const sessions = decisionSessions(ctx.store, { limit: limit + 1, ...(kind ? { kind: kind as 'decisions' | 'migrate' } : {}), shared: namesTeamStore(ctx.project?.path) });
    r.tagged({ sessions: sessions.slice(0, limit), goldens: goldens().length, more: sessions.length > limit });
  });

  // A session's runs hold every step's two decisions, and their about lines read requests: worked out beside the server.
  router.get('/decisions/:id', async (r) => {
    const { byId } = loadRunIndex(ctx.store);
    const calls = ctx.store.decisionRunIds(r.params.id!).reduce((n, id) => n + (byId.get(id)?.calls ?? 0), 0);
    sendAnswer(r, await ctx.reads.run({ kind: 'decision-session', sessionId: r.params.id!, ...comparedBy(ctx), keptMax: verifyRule(ctx).keptMax, shared: namesTeamStore(ctx.project?.path) }, { calls }));
  });

  // What a new preview would ask and bill, beside the server, by the runs' calls: the change as its
  // job takes it (previewRequest), or none, for each way's card. A switch's card is priced at the
  // model its field starts on, from the providers' listing (asked here, off the read pool). A POST
  // that changes nothing, so the 500 runs one preview takes fit in its body; the project's goldens
  // are listed once, and only where it names them.
  router.post(
    '/decisions/estimates',
    async (r) => {
      const body = await r.body();
      const listed = body.goldens === undefined ? [] : goldens();
      const p = previewRequest(body, ctx.store, listed);
      if ('error' in p) throw new HttpError(p.status ?? 400, p.error);
      const runIds = [...new Set(p.targets.runIds)].filter((id) => ctx.store.getRun(id));
      const have = new Set(runIds);
      const runOf = new Map(listed.map((g) => [g.path, g.runId]));
      const unrecorded = p.targets.packs.filter((path) => {
        const id = runOf.get(path);
        return !id || !have.has(id);
      }).length;
      const changed = changedCalls(body.changed, runIds);
      const named = p.model !== null || p.set.length > 0 || p.fromCode;
      const offered = named ? null : await modelChoices(ctx);
      const listedModels = offered ? [...offered.choices, ...offered.priced] : [];
      const { byId } = loadRunIndex(ctx.store);
      const calls = runIds.reduce((n, id) => n + (byId.get(id)?.calls ?? 0), 0);
      const job = { kind: 'preview-estimate' as const, runIds, unrecorded, targets: p.targets.args, model: p.model, set: p.set, from: p.from, scope: p.scope, samples: p.samples, fromCode: p.fromCode, ...(changed ? { changed } : {}), listed: listedModels, ...(ctx.read.prices ? { prices: ctx.read.prices } : {}), budget: p.budget, thenVerify: p.thenVerify };
      sendAnswer(r, await ctx.reads.run(job, { calls }));
    },
    { write: false },
  );

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

  // What Migrate opens on: the goldens' models that retire, with their scopes and whether a migration checked each, and the models in use. It reads every golden's calls, so beside the server.
  router.get('/migrate/start', async (r) => {
    const listed = goldens();
    const { byId } = loadRunIndex(ctx.store);
    sendAnswer(r, await ctx.reads.run({ kind: 'migrate-start', goldens: listed }, { calls: listed.reduce((n, g) => n + ((g.runId && byId.get(g.runId)?.calls) || 0), 0) }));
  });

  // What Migrate to <model> bills on what its job asks, the goldens and runs named (every golden when
  // none is), and the newest preview of the same switch: beside the server.
  router.get('/migrate/estimate', async (r) => {
    const to = r.query.get('to') ?? '';
    if (!MODEL_NAME.test(to)) throw new HttpError(400, 'to is the model to switch to, such as claude-sonnet-5-5');
    const from = r.query.getAll('from').filter((m) => MODEL_NAME.test(m)).slice(0, 20);
    const scope = scopeArgs(r.query.get('scope') || undefined);
    if ('error' in scope) throw new HttpError(400, scope.error);
    const budget = budgetArg(r.query.has('budget') ? Number(r.query.get('budget')) : undefined);
    if ('error' in budget) throw new HttpError(400, budget.error);
    const named = new Set(r.query.getAll('golden'));
    const runs = migrateRuns(ctx, r.query.getAll('run'));
    const listed = goldens().filter((g) => (named.size || runs.length ? named.has(g.path) : true));
    const { byId } = loadRunIndex(ctx.store);
    const job = { kind: 'migrate-estimate' as const, to, from, scope: scope.scope, budget: budget.budget, goldens: listed, runs, work: outcomeWork(ctx), rule: verifyRule(ctx), ...(ctx.read.prices ? { prices: ctx.read.prices } : {}) };
    const calls = [...listed.map((g) => g.runId), ...runs].reduce((n, id) => n + ((id && byId.get(id)?.calls) || 0), 0);
    sendAnswer(r, await ctx.reads.run(job, { calls }));
  });

  // A golden's pack is read from the project's folder, which is where a job runs the CLI.
  const folder = (b: { project: { path: string } | null }) => b.project?.path ?? process.cwd();
  ctx.jobs.registerJobKind('decisions', { title: () => 'Previewing a change', build: (req, b) => decisionsJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('decisions-read', { title: () => READING_TREE, build: (req, b) => decisionsReadJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('migrate', { title: () => 'Migrating', build: (req, b) => migrateJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('migrate-apply', { title: () => ACTIONS.applyConfigChange.doing, build: (req, b) => migrateApplyJob(req, b.store) });
  ctx.jobs.registerJobKind('decisions-verify', { title: () => 'Verifying the changed runs', build: (req, b) => verifyFlaggedJob(req, b.store, folder(b)) });
}
