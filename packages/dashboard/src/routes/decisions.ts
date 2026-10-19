import { describeEvent } from '../activity.js';
import type { RouteContext } from '../context.js';
import { decisionSession, decisionSessions, decisionsJob, migrateJob, retirementsView, runDecisions, verifyFlaggedJob } from '../decisions.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import type { GoldenSource } from '../tests.js';

/**
 * The decision diff (`shadowlap decisions`, `migrate`), for the Changes page and a run's Decisions view:
 *
 *   GET /api/decisions[?kind=decisions|migrate]   the sessions kept, newest first, and the goldens' models that retire
 *   GET /api/decisions/:id                       one session whole (`dc-…` or `mg-…`): its report, and its matrix
 *   GET /api/runs/:id/decisions                  a run's decisions under each session that asked it again
 *   GET /api/retirements                         the models the goldens use that retire, by the table that ships
 *   POST /api/jobs { kind: "decisions", runs?, goldens?, model?, set?, from?, scope?, fromCode?, samples?, thenVerify?, yes? }
 *   POST /api/jobs { kind: "migrate", to, goldens?, runs?, from?, scope?, set?, yes? }   every golden when none are named
 *   POST /api/jobs { kind: "decisions-verify", sessionId, runId?, yes? }   decisions --verify: the runs a session flagged, each under its checks
 *
 * The goldens a job may name are the project's (`DashboardOptions.goldens`); runs are ids in the store.
 */

const KINDS = new Set(['decisions', 'migrate']);

// How the activity feed words a session (the Changes page that opens one comes with its own route).
describeEvent('decisions.done', (_e, d) => ({
  kind: 'fork',
  text: `Previewed ${typeof d.change === 'string' ? d.change : 'a change'} on ${Number(d.runs) || 0} run${Number(d.runs) === 1 ? '' : 's'}${Number(d.flagged) ? ` · ${Number(d.flagged)} with a write or stop change` : ''}`,
}));
describeEvent('migrate.done', (_e, d) => ({
  kind: 'fork',
  text: `Migration previewed: ${typeof d.change === 'string' ? d.change : 'another model'} on ${Number(d.runs) || 0} run${Number(d.runs) === 1 ? '' : 's'}${Number(d.flagged) ? ` · ${Number(d.flagged)} with a write or stop change` : ''}`,
}));

export function register(router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];

  router.get('/decisions', (r) => {
    const kind = r.query.get('kind');
    if (kind !== null && !KINDS.has(kind)) throw new HttpError(400, 'kind is decisions or migrate');
    const limit = Math.max(1, Math.min(200, Number(r.query.get('limit') ?? 50) || 50));
    r.tagged({ sessions: decisionSessions(ctx.store, { limit, ...(kind ? { kind: kind as 'decisions' | 'migrate' } : {}) }), retirements: retirementsView(ctx.store, goldens()) });
  });

  router.get('/decisions/:id', (r) => {
    const session = decisionSession(ctx.store, r.params.id!);
    if (!session) throw new HttpError(404, `no session ${r.params.id!.slice(0, 40)}`);
    r.tagged(session);
  });

  router.get('/runs/:id/decisions', (r) => {
    if (!ctx.store.getRun(r.params.id!)) throw new HttpError(404, `no run ${r.params.id!.slice(0, 40)}`);
    r.tagged(runDecisions(ctx.store, r.params.id!));
  });

  router.get('/retirements', (r) => r.tagged(retirementsView(ctx.store, goldens())));

  ctx.jobs.registerJobKind('decisions', { title: () => 'Previewing a change', build: (req, b) => decisionsJob(req, b.store, goldens()) });
  ctx.jobs.registerJobKind('migrate', { title: () => 'Migrating', build: (req, b) => migrateJob(req, b.store, goldens()) });
  ctx.jobs.registerJobKind('decisions-verify', { title: () => 'Verifying the changed runs', build: (req, b) => verifyFlaggedJob(req, b.store) });
}
