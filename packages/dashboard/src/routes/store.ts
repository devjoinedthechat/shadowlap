import { resolveAuthor, type Store } from '@shadowlap/engine';
import { lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';
import { readTeamStoreInput, teamStoreStatus, type TeamStoreStatus } from '../team-store.js';

/**
 * The team store, free: a bucket of your own that `push` copies runs to and `pull` brings the
 * team's from. `GET /api/store` says what this machine knows of it (nothing is asked of the
 * bucket) and who it records as; the `push`, `pull` and `share` job kinds run the CLI, which talks
 * to the bucket with this machine's own credentials. The Runs page (the `local` tag, Pull, Push in
 * the bulk bar), a run's page (Push, Share link) and Settings → Store use them.
 */

/** The store the project's config names, as `teamStoreStatus` reports it, or null without one. Read fresh: Settings and `store set` change it. */
export function teamStoreFor(ctx: RouteContext): TeamStoreStatus | null {
  if (!ctx.project) return null;
  return teamStoreStatus(ctx.store, readTeamStoreInput({ cwd: ctx.project.path }));
}

/**
 * Which of these runs are only on this machine: finished, not pulled from a pull request's folder,
 * and not listed in the store's index (as `teamLocalOnly` counts them). The Runs page's `local` tag.
 */
export function localRunIds(store: Store, remote: string, runIds: readonly string[]): Set<string> {
  if (!runIds.length) return new Set();
  const rows = store.query(
    `SELECT r.run_id AS id FROM runs r WHERE r.run_id IN (SELECT value FROM json_each(?))
       AND r.status != 'running' AND json_extract(r.meta, '$.imported.pr') IS NULL
       AND NOT EXISTS (SELECT 1 FROM team_runs t WHERE t.remote = ? AND t.run_id = r.run_id AND t.state != 'queued' AND t.remote_hash IS NOT NULL)`,
    JSON.stringify(runIds),
    remote,
  );
  return new Set(rows.map((r) => String(r.id)));
}

/** At most this many runs in one push from the dashboard (the bulk bar's selection). */
const PUSH_MAX = 1000;
const RUN_ID = /^[0-9A-Z]{26}$/;

export function register(router: Router, ctx: RouteContext): void {
  // Who this machine records as (what `shadowlap run` stamps on a run made here), for the By
  // column's "you": worked out once, and only once a store is set.
  let you: string | null | undefined;
  const whoAmI = (): string | null => {
    if (you === undefined) you = ctx.project ? resolveAuthor({ cwd: ctx.project.path }) : null;
    return you;
  };

  // Asked whenever runs change (the status bar, Runs, the Overview): an unchanged answer is a 304.
  router.get('/store', (r) => {
    const store = teamStoreFor(ctx);
    r.tagged({ store, you: store ? whoAmI() : null });
  });

  // Push: the runs picked (their ancestors go too, as the CLI does), or with `all` every run only on
  // this machine. A run still recording is queued by the CLI and goes when it ends.
  ctx.jobs.registerJobKind('push', {
    title: (req) => (req.all === true ? 'Pushing local runs' : 'Pushing'),
    build: (req, { store }) => {
      if (!ctx.project) return { error: 'the team store needs a project folder: start the dashboard in your project with shadowlap dashboard', status: 501 };
      if (!teamStoreFor(ctx)) return { error: 'no team store yet: set one with shadowlap store set s3://<bucket>/<folder>', status: 409 };
      if (req.all === true) return { args: ['push', '--all'] };
      if (!Array.isArray(req.runIds) || !req.runIds.length) return { error: 'runIds: pick the runs to push, or push them all' };
      if (req.runIds.length > PUSH_MAX) return { error: `runIds: at most ${PUSH_MAX} runs at once` };
      const ids: string[] = [];
      for (const raw of req.runIds) {
        // Full ids only, as the table hands them out: a prefix could name another run.
        const run = typeof raw === 'string' && RUN_ID.test(raw) ? store.getRun(raw) : null;
        if (!run) return { error: `no run ${typeof raw === 'string' ? raw.slice(0, 26) : ''}`.trim(), status: 404 };
        if (!ids.includes(run.runId)) ids.push(run.runId);
      }
      return { args: ['push', ...ids], ...(ids.length === 1 ? { runId: ids[0]! } : {}) };
    },
  });

  // Pull: the team's runs and the labels and notes they changed. Runs pulled open from the drawer.
  ctx.jobs.registerJobKind('pull', {
    title: () => 'Pulling',
    build: () => {
      if (!ctx.project) return { error: 'the team store needs a project folder: start the dashboard in your project with shadowlap dashboard', status: 501 };
      if (!teamStoreFor(ctx)) return { error: 'no team store yet: set one with shadowlap store set s3://<bucket>/<folder>', status: 409 };
      return { args: ['pull'] };
    },
  });

  // Share link: a redacted HTML report in the bucket behind a link that expires after 7 days. The
  // run's ancestors come along unless asked not to, as the dashboard's HTML download does, so a fork
  // still shows what it parted from.
  ctx.jobs.registerJobKind('share', {
    title: () => 'Sharing',
    build: (req, { store }) => {
      if (!ctx.project) return { error: 'the team store needs a project folder: start the dashboard in your project with shadowlap dashboard', status: 501 };
      if (!teamStoreFor(ctx)) return { error: 'no team store yet: set one with shadowlap store set s3://<bucket>/<folder>', status: 409 };
      const run = typeof req.runId === 'string' && req.runId ? lookupRun(store, req.runId) : null;
      if (!run) return { error: 'name the run to share', status: typeof req.runId === 'string' ? 404 : 400 };
      return { args: ['share', run.runId, ...(req.lineage === false ? [] : ['--lineage'])], runId: run.runId };
    },
  });
}
