import { actionArgs, lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/**
 * Jobs: `POST /api/jobs { kind, ... }` starts one (each kind's builder turns the fields into CLI
 * arguments), `GET /api/jobs/:id?after=n` follows its output and what it made, `GET /api/jobs`
 * lists recent ones. This module registers the `action` kind: the run actions the terminal UI
 * shares (replay, the fork menu, repeat, pack, add the suggested normalizer), also reachable as
 * `POST /api/runs/:id/actions`.
 */

/** The drawer's title for each run action, as the mock words them. */
const ACTION_TITLES: Record<string, string> = { r: 'Replaying', s: 'Replaying', e: 'Repeating', p: 'Packing', n: 'Adding a normalizer' };

export function register(router: Router, ctx: RouteContext): void {
  const { jobs } = ctx;

  jobs.registerJobKind('action', {
    title: (req) => ACTION_TITLES[typeof req.key === 'string' ? req.key : ''] ?? 'Forking',
    build: (req, { store }) => {
      if (typeof req.runId !== 'string' || !req.runId) return { error: 'runId is required' };
      if (typeof req.key !== 'string' || !req.key) return { error: 'key is required' };
      const callNo = typeof req.callNo === 'number' ? req.callNo : null;
      const built = actionArgs(store, req.runId, callNo, req.key, typeof req.value === 'string' ? req.value : undefined);
      if ('error' in built) return built;
      return { args: built.args, runId: lookupRun(store, req.runId)?.runId ?? req.runId, opensRun: built.opensRun };
    },
  });

  router.post('/jobs', async (r) => {
    const body = await r.body();
    r.json(await jobs.start(body.kind, body), 202);
  });

  router.get('/jobs', (r) => r.json({ jobs: jobs.list() }));

  router.get('/jobs/:id', (r) => r.json(jobs.view(r.params.id!, Math.max(0, Number(r.query.get('after') ?? 0) || 0))));

  // By its id: a job keeps to the project it started in, so a page showing that one may stop it after a switch.
  router.post(
    '/jobs/:id/stop',
    (r) => {
      jobs.view(r.params.id!); // a 404 for a job it never had
      r.json({ stopped: jobs.stop(r.params.id!) });
    },
    { anyProject: true },
  );

  // The run actions as they were posted before jobs had kinds.
  router.post('/runs/:id/actions', async (r) => {
    const body = await r.body();
    r.json(await jobs.start('action', { ...body, kind: 'action', runId: r.params.id }), 202);
  });
}
