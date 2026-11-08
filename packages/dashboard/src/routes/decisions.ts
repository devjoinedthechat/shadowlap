import { DECISIONS_ID } from '@shadowlap/engine';
import { describeEvent } from '../activity.js';
import type { RouteContext } from '../context.js';
import { decisionSessions, decisionsJob, migrateJob, retirementsView, verifyFlaggedJob } from '../decisions.js';
import { HttpError } from '../http.js';
import { links } from '../links.js';
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
 *   GET /api/decisions/:id/estimates[?runId=…]   what its Verify bills (estimates.ts), on every run it could not clear or those the runIds name
 *   GET /api/runs/:id/decisions                  a run's decisions under each session that asked it again, beside the server
 *   GET /api/retirements                         the models the goldens use that retire, by the table that ships
 *   POST /api/jobs { kind: "decisions", runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?, thenVerify?, yes? }
 *   POST /api/jobs { kind: "migrate", to, goldens?, runs?, from?, scope?, set?, yes? }   every golden when none are named
 *   POST /api/jobs { kind: "decisions-verify", sessionId, runId?, runIds?, yes? }   decisions --verify: the runs a session could not clear (or those named), each under its checks
 *
 * The goldens a job may name are the project's (`DashboardOptions.goldens`); runs are ids in the store.
 */

const KINDS = new Set(['decisions', 'migrate']);

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

// How the activity feed words a session: a preview opens on its tab under Changes (a migration's tab comes with port/migrate).
describeEvent('decisions.done', (e, d) => ({
  kind: 'fork',
  text: `Previewed ${typeof d.change === 'string' ? d.change : 'a change'} on ${Number(d.runs) || 0} run${Number(d.runs) === 1 ? '' : 's'}${Number(d.flagged) ? ` · ${Number(d.flagged)} with a write, stop or judged change` : ''}`,
  ...(e.ref && DECISIONS_ID.test(e.ref) ? { href: links.changeSession('decisions', e.ref) } : {}),
}));
describeEvent('migrate.done', (_e, d) => ({
  kind: 'fork',
  text: `Migration previewed: ${typeof d.change === 'string' ? d.change : 'another model'} on ${Number(d.runs) || 0} run${Number(d.runs) === 1 ? '' : 's'}${Number(d.flagged) ? ` · ${Number(d.flagged)} with a write, stop or judged change` : ''}`,
}));

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
    sendAnswer(r, await ctx.reads.run({ kind: 'decision-session', sessionId: r.params.id!, ...comparedBy(ctx) }, { calls }));
  });

  // What Verify would bill on a kept session, or on the one run `runId` names, beside the server: it
  // judges each run's recording by its checks, which reads its calls. Asked apart from the session.
  router.get('/decisions/:id/estimates', async (r) => {
    const { byId } = loadRunIndex(ctx.store);
    const calls = ctx.store.decisionRunIds(r.params.id!).reduce((n, id) => n + (byId.get(id)?.calls ?? 0), 0);
    const runIds = r.query.getAll('runId').map((id) => id.trim()).filter(Boolean).slice(0, 500);
    const job = { kind: 'decision-estimates' as const, sessionId: r.params.id!, runIds, work: outcomeWork(ctx), rule: verifyRule(ctx), ...(ctx.read.prices ? { prices: ctx.read.prices } : {}) };
    sendAnswer(r, await ctx.reads.run(job, { calls }));
  });

  // Each session that asked the run again words its row and its steps from every decision it kept: beside the server, by the run's calls.
  router.get('/runs/:id/decisions', async (r) => {
    const run = ctx.store.getRun(r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id!.slice(0, 40)}`);
    sendAnswer(r, await ctx.reads.run({ kind: 'run-decisions', runId: run.runId }, runAffinity(ctx.store, run.runId)));
  });

  router.get('/retirements', (r) => r.tagged(retirementsView(ctx.store, goldens())));

  // A golden's pack is read from the project's folder, which is where a job runs the CLI.
  const folder = (b: { project: { path: string } | null }) => b.project?.path ?? process.cwd();
  ctx.jobs.registerJobKind('decisions', { title: () => 'Previewing a change', build: (req, b) => decisionsJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('migrate', { title: () => 'Migrating', build: (req, b) => migrateJob(req, b.store, goldens(), folder(b)) });
  ctx.jobs.registerJobKind('decisions-verify', { title: () => 'Verifying the changed runs', build: (req, b) => verifyFlaggedJob(req, b.store, folder(b)) });
}
