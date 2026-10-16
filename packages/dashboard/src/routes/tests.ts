import type { Normalizer } from '@shadowlap/engine';
import { ciWorkflows, fixPreview, gitFacts, parseCiOptions } from '../ci-workflows.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { JobBuildResult } from '../jobs.js';
import type { Router } from '../router.js';
import { bisectChoices, bisectJob, normalizeAndTestJob, runTestsJob, testPatterns, testRunBanner, testsSummary, testsView, updateGoldensJob, type GoldenSource, type TestsJob } from '../tests.js';

/**
 * Tests: the goldens and how they did (`GET /api/tests`), what a run's page offers about a test
 * replay and Find the commit (`GET /api/tests/runs/:id`), the workflow steps Settings → CI shows
 * (`GET /api/ci/workflows`), and the jobs the Tests screen starts:
 *
 *   test                 { golden? }                    every golden on disk (the goldens folder's pattern, which the CLI
 *                                                       expands without a shell, and each pack named elsewhere), or one
 *   test-update          { goldens: [...] } | { golden } re-record each live with writes stubbed; replaced when its checks pass
 *   bisect               { golden | runId, good, bad? }  Find the commit: replays at each commit, halving the range;
 *                                                       for a run, as `GET /api/tests/runs/:id` offers it
 *   normalize-and-test   { golden | runId, path? }       `normalize add` for each value made anew on every run, then `test` on the golden
 *
 * The goldens are the packs on disk, as the CLI lists them (`DashboardOptions.goldens`); a request
 * naming any other is refused.
 */

/** The folder the project keeps its goldens in. */
const FOLDER = 'goldens';

/** The job kinds this module registers, by what they do. */
export const TEST_JOB_KINDS = { test: 'test', update: 'test-update', bisect: 'bisect', normalize: 'normalize-and-test' } as const;

/** A tests job as the job runner takes it: `steps` become the first command and the ones `then` runs. */
export function testsBuild(job: TestsJob): JobBuildResult {
  if ('error' in job) return { error: job.error };
  const runId = job.runId ? { runId: job.runId } : {};
  if ('args' in job) return { title: job.title, args: job.args, ...runId };
  const [first, ...then] = job.steps;
  if (!first) return { error: 'nothing to run' };
  return { title: job.title, args: first, ...(then.length ? { then } : {}), ...runId };
}

export function register(router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];

  router.get('/tests', (r) => {
    // The rules in the config now: a divergence they already mask needs only a re-run. A config that
    // can't be read leaves that out rather than the whole screen.
    let normalizers: Normalizer[] = [];
    try {
      normalizers = ctx.config().normalize;
    } catch {
      // the screen still shows the goldens
    }
    r.tagged(testsView(ctx.store, goldens(), { folder: FOLDER, normalizers }));
  });

  // A run's page: the diverged-test banner of a replay `shadowlap test` made, and Find the commit's
  // choices for any run (`before`: the calendar's first day picked, in milliseconds).
  router.get('/tests/runs/:id', (r) => {
    const run = ctx.store.getRun(r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id}`);
    const raw = r.query.get('before');
    const before = raw === null || raw === '' ? undefined : Number(raw);
    if (before !== undefined && !Number.isFinite(before)) throw new HttpError(400, 'before is a time in milliseconds');
    r.tagged({ banner: testRunBanner(ctx.store, run.runId), bisect: bisectChoices(ctx.store, run.runId, { goldens: goldens(), ...(before !== undefined ? { before } : {}) }) });
  });

  router.get('/ci/workflows', (r) => {
    const options = parseCiOptions(r.query);
    if ('error' in options) throw new HttpError(400, options.error);
    const list = goldens();
    const summary = testsSummary(ctx.store, { goldens: list });
    const git = gitFacts(ctx.project?.path ?? null);
    r.tagged(
      ciWorkflows(options, {
        preview: fixPreview(ctx.store, options.budget),
        failing: summary.failing,
        at: summary.lastRunAt,
        repository: git.repository,
        branch: git.branch,
        recordings: list.length ? testPatterns(list, FOLDER).join(' ') : `${FOLDER}/*`,
      }),
    );
  });

  // `shadowlap test` on one golden links to its replay itself: the one that passed, or the one that failed.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.test, {
    title: () => 'Running the tests',
    build: (req) => testsBuild(runTestsJob(goldens(), req, { folder: FOLDER })),
  });
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.update, {
    title: () => 'Updating goldens',
    build: (req) => testsBuild(updateGoldensJob(goldens(), req)),
  });
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.bisect, {
    title: () => 'Finding the commit',
    build: (req, { store }) => testsBuild(bisectJob(store, goldens(), req)),
  });
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.normalize, {
    title: () => 'Adding a normalizer',
    build: (req, { store }) => testsBuild(normalizeAndTestJob(store, goldens(), req)),
  });
}
