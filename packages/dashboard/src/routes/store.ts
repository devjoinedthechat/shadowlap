import { resolveAuthor, type Store } from '@shadowlap/engine';
import { CI_PROVIDERS, formatStoreUrl, parseStoreUrl, storeKey, type CiProvider } from '@shadowlap/remote';
import { lookupRun } from '../api.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { loadRunIndex } from '../run-index.js';
import { checkSetupUrl, isProvider, recordSetup, storeSetupView } from '../store-setup.js';
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
 * Which of these runs are only on this machine: not pulled from a pull request's folder, and not
 * listed in the store's index. The Runs page's `local` tag. A recording in progress is one of them
 * until it is pushed, as the design tags it. How many runs are only here is the store status's
 * `onlyLocal` (Needs a look, Settings → Store and the CLI's `store show` all say that one), counted
 * the way these tags are: by run, a run whose attempts are only here counted once with them.
 */
export function localRunIds(store: Store, remote: string, runIds: readonly string[]): Set<string> {
  if (!runIds.length) return new Set();
  const rows = store.query(
    `SELECT r.run_id AS id FROM runs r WHERE r.run_id IN (SELECT value FROM json_each(?))
       AND json_extract(r.meta, '$.imported.pr') IS NULL
       AND NOT EXISTS (SELECT 1 FROM team_runs t WHERE t.remote = ? AND t.run_id = r.run_id AND t.state != 'queued' AND t.remote_hash IS NOT NULL)`,
    JSON.stringify(runIds),
    remote,
  );
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * The attempts bundled under these runs (`--repeat`, blame's probes, verify's attempts) that are only
 * on this machine, at most `room` of them: pushing a run sends them too, as the Runs page shows them
 * under it, so a run pushed leaves nothing of its own behind.
 */
export function localAttempts(store: Store, remote: string, runIds: readonly string[], room: number): string[] {
  if (room <= 0) return [];
  const index = loadRunIndex(store);
  const attempts = [...new Set(runIds.flatMap((id) => (index.attempts.get(id) ?? []).map((a) => a.runId)))];
  const local = new Set<string>();
  for (let i = 0; i < attempts.length; i += 5000) for (const id of localRunIds(store, remote, attempts.slice(i, i + 5000))) local.add(id);
  return attempts.filter((id) => local.has(id)).slice(0, room);
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

  // The setup page (#/setup/store): where it stands, each provider with the credentials this machine
  // would use, the CI steps and the commit that brings the team in. Read from the config and this
  // machine; nothing is asked of a bucket.
  router.get('/store/setup', (r) => {
    if (!ctx.project) throw new HttpError(501, 'the team store needs a project folder: start the dashboard in your project with shadowlap dashboard');
    r.tagged(storeSetupView(ctx.store, readTeamStoreInput({ cwd: ctx.project.path })));
  });

  // A URL typed in Connect your bucket, checked against the provider picked as store set checks
  // it, with the access to ask the cloud admin for and whose credentials would open it.
  router.get('/store/setup/url', (r) => {
    const provider = r.query.get('provider');
    if (!isProvider(provider)) throw new HttpError(400, 'provider is s3, gcs, azure or r2');
    const url = r.query.get('url') ?? '';
    if (url.length > 2048) throw new HttpError(400, 'url: at most 2,048 characters');
    r.json(checkSetupUrl(provider, url));
  });

  // The steps the CLI leaves no trace of: Push from CI added or skipped (and for which CI), and the
  // setup finished. Kept with what this machine knows of the store the config names.
  router.post('/store/setup', async (r) => {
    const body = await r.body();
    const team = teamStoreFor(ctx);
    if (!team) throw new HttpError(409, 'no team store yet: connect a bucket first');
    const patch: Parameters<typeof recordSetup>[2] = {};
    if (body.ci !== undefined) {
      if (body.ci !== 'added' && body.ci !== 'skipped') throw new HttpError(400, 'ci is added or skipped');
      patch.ci = body.ci;
    }
    if (body.ciProvider !== undefined) {
      if (typeof body.ciProvider !== 'string' || !(CI_PROVIDERS as readonly string[]).includes(body.ciProvider)) throw new HttpError(400, 'ciProvider is github, gitlab or other');
      patch.ciProvider = body.ciProvider as CiProvider;
    }
    if (body.finished !== undefined) {
      if (body.finished !== true) throw new HttpError(400, 'finished is true');
      patch.finishedAt = Date.now();
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'say what was done: ci, ciProvider or finished');
    r.json({ setup: recordSetup(ctx.store, team.key, patch) });
  });

  // Check access and connect: `store set <url> --provider <p> --check`, which checks the bucket with
  // this machine's credentials and writes the store to the config only when that works.
  ctx.jobs.registerJobKind('store-set', {
    title: () => 'Connecting the store',
    build: (req) => {
      if (!ctx.project) return { error: 'the team store needs a project folder: start the dashboard in your project with shadowlap dashboard', status: 501 };
      if (!isProvider(req.provider)) return { error: 'provider is s3, gcs, azure or r2' };
      if (typeof req.url !== 'string' || !req.url.trim() || req.url.length > 2048) return { error: 'url: the bucket and folder, such as s3://my-bucket/agent-runs' };
      let configured: string;
      try {
        configured = formatStoreUrl(parseStoreUrl(req.url, req.provider));
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      return { args: ['store', 'set', configured, '--provider', req.provider, '--check'] };
    },
  });
  // Once it has connected the store (the check passed, the config names it), the setup of that store
  // is under way, and Settings → Store goes on to the next steps. One that failed starts nothing.
  ctx.jobs.onJob((n) => {
    if (n.type !== 'end' || n.job.kind !== 'store-set' || n.job.code !== 0) return;
    try {
      recordSetup(ctx.store, storeKey(parseStoreUrl(n.job.args[2] ?? '')), { startedAt: n.job.startedAt, finishedAt: null });
    } catch {
      // not a store URL: not a job this module built
    }
  });

  // Push: the runs picked with the attempts bundled under them (their ancestors go too, as the CLI
  // does), or with `all` every run only on this machine. A run still recording is queued by the CLI
  // and goes when it ends; one its recorder left is ended as interrupted by the CLI's push, as gc
  // would, so it goes now. Building the job only names them: nothing changes before it runs.
  ctx.jobs.registerJobKind('push', {
    title: (req) => (req.all === true ? 'Pushing local runs' : 'Pushing'),
    build: (req, { store }) => {
      if (!ctx.project) return { error: 'the team store needs a project folder: start the dashboard in your project with shadowlap dashboard', status: 501 };
      const team = teamStoreFor(ctx);
      if (!team) return { error: 'no team store yet: set one with shadowlap store set s3://<bucket>/<folder>', status: 409 };
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
      // At most PUSH_MAX ids on the command line, the runs picked first.
      const attempts = localAttempts(store, team.key, ids, PUSH_MAX - ids.length);
      return { args: ['push', ...ids, ...attempts], ...(ids.length === 1 ? { runId: ids[0]! } : {}) };
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
