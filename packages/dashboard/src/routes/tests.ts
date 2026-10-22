import type { Normalizer, Store } from '@shadowlap/engine';
import { describeEvent } from '../activity.js';
import { liveChaosSession } from '../chaos.js';
import { ciWorkflows, fixPreview, gitFacts, goldenProviders, parseCiOptions } from '../ci-workflows.js';
import { choicesInCheckout, commitsHere, commitSubjects, rangeHere, revisionsHere } from '../commits-here.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { JobBuildResult } from '../jobs.js';
import type { Router } from '../router.js';
import { configFileError } from '../settings.js';
import { readTeamStoreInput } from '../team-store.js';
import { bisectChoices, bisectJob, gatePreview, liveTestSession, normalizeAndTestJob, runTestsJob, testPatterns, testRunBanner, testsSummary, testsView, updateGoldensJob, type BisectRange, type GoldenSource, type TestsJob, type TestsView } from '../tests.js';

/**
 * Tests: the goldens and how they did (`GET /api/tests`), what a run's page offers about a test
 * replay and Find the commit (`GET /api/tests/runs/:id`), what a gate's figures would do
 * (`GET /api/tests/gate?good=&bad=&risk=&max=`, or `?baseline=history&drop=&window=&min=&max=`
 * figured against `&history=47/50`), the
 * workflow steps Settings → CI shows (`GET /api/ci/workflows`), and the jobs the Tests screen starts:
 *
 *   test                 { golden?, maxAttempts?,       every golden on disk (the goldens folder's pattern, which the CLI
 *                          continue? }                  expands without a shell, and each pack named elsewhere), or one;
 *                                                       `maxAttempts` raises each gate's limit for that session, and
 *                                                       `continue` carries an inconclusive gate's attempts over (Run more attempts)
 *   test-update          { goldens: [...] } | { golden } re-record each live with writes stubbed; replaced when its checks pass
 *   bisect               { golden | runId, good, bad? }  Find the commit: replays at each commit, halving the range;
 *                                                       for a run, as `GET /api/tests/runs/:id` offers it
 *   normalize-and-test   { golden | runId, path? }       `normalize add` for each value made anew on every run, then `test` on the golden
 *
 * The goldens are the packs on disk, as the CLI lists them (`DashboardOptions.goldens`); a request
 * naming any other is refused. Jobs that replay or rewrite those packs (Find the commit on a golden
 * among them) run one at a time in a project (`testsBusy`), and none starts while a test session, or
 * a session of error-path presets on goldens, runs, wherever it was started (`sessionBusy`): a second
 * is refused with a 409 that names the one running.
 */

/** The folder the project keeps its goldens in. */
const FOLDER = 'goldens';

/** The job kinds this module registers, by what they do. */
export const TEST_JOB_KINDS = { test: 'test', update: 'test-update', bisect: 'bisect', normalize: 'normalize-and-test' } as const;

/**
 * Jobs that replay the goldens on disk or rewrite them, by what each is doing: a second one at once
 * would replay a pack the other is rewriting, or report a session the other's results land in. A
 * setup's Keep it as a test packs a new golden and tests it. Find the commit on a golden reads its
 * pack and answers the failure it started from, so it runs alone too; on a run, it touches none.
 * The error-path presets replay a golden's pack (on a run, they touch none), and packing goldens
 * of production writes new ones into the goldens folder.
 */
const TEST_FAMILY = new Map<string, string>([
  ['test', 'a test session'],
  ['test-update', 'an update of goldens'],
  ['normalize-and-test', 'a normalizer and its re-run'],
  ['pack-test', 'a new golden being packed and tested'],
  ['bisect', 'find the commit'],
  ['chaos', 'a session of error-path presets'],
  ['coverage-pack', 'a coverage pack'],
]);

/** Whether a job is one of those: a bisect counts when it searches a golden rather than a run (by its id), the presets when they run on a golden. */
export function inTestFamily(job: { kind: string; args?: readonly string[] }): boolean {
  if (job.kind === 'bisect') return !!job.args?.[1] && !/^[0-9A-Z]{26}$/.test(job.args[1]);
  if (job.kind === 'chaos') return job.args?.[0] === 'test';
  return TEST_FAMILY.has(job.kind);
}

/**
 * Why a job that replays or rewrites the goldens can't start now in this project (`projectId`, null
 * on a dashboard that serves one store): another such job is running there. `verb` is what to do
 * once it is done. Null when it can start.
 */
export function testsBusy(jobs: ReadonlyArray<{ kind: string; args?: readonly string[]; done: boolean; project?: { id: string } }>, projectId: string | null, verb: string): string | null {
  const j = jobs.find((x) => !x.done && inTestFamily(x) && (x.project?.id ?? null) === projectId);
  const doing = j ? TEST_FAMILY.get(j.kind)! : null;
  return doing ? `${doing.charAt(0).toUpperCase()}${doing.slice(1)} is running: ${verb} once it is done` : null;
}

/**
 * Why such a job waits for a session running now, wherever it was started (a terminal, another
 * dashboard, a job of this one, which `testsBusy` names first), named by its command; null when none
 * runs. A test session counts, and so do the error-path presets on goldens (`test --chaos`), which
 * replay their packs too. The store keeps each session's process, so one whose process was killed
 * holds nothing up.
 */
export function sessionBusy(store: Store, verb: string): string | null {
  const live = liveTestSession(store) ?? liveChaosSession(store);
  if (!live) return null;
  const command = live.command.join(' ');
  return `${command.length > 60 ? `${command.slice(0, 59)}…` : command} is running: ${verb} once it is done`;
}

/** A tests job as the job runner takes it: `steps` become the first command and the ones `then` runs. */
export function testsBuild(job: TestsJob, busy: string | null = null): JobBuildResult {
  if ('error' in job) return { error: job.error };
  if (busy) return { error: busy, status: 409 };
  const runId = job.runId ? { runId: job.runId } : {};
  if ('args' in job) return { title: job.title, args: job.args, ...runId };
  const [first, ...then] = job.steps;
  if (!first) return { error: 'nothing to run' };
  return { title: job.title, args: first, ...(then.length ? { then } : {}), ...runId };
}

/**
 * Tests' Find the commit as the project's checkout can run it: a golden whose last pass was at a
 * commit this checkout lacks (a CI test session's merge commit, a teammate's) asks for a good one,
 * and one that failed at such a commit is searched up to HEAD. The commits its dialog offers are
 * those this checkout has, each with its subject. As it is without a project folder or when git
 * can't say.
 */
function rangesInCheckout(view: TestsView, root: string | null | undefined): TestsView {
  const all = [...view.divergences, ...view.failures];
  const revs = all.flatMap((d) => [d.bisect?.good ?? null, d.bisect?.bad ?? null, ...d.revisions.map((r) => r.rev)]);
  if (!root || !revs.some(Boolean)) return view;
  const here = commitsHere(root, revs);
  if (!here) return view;
  const subjects = commitSubjects(root, revs);
  const inCheckout = <T extends { golden: string; bisect: BisectRange | null; revisions: TestsView['divergences'][number]['revisions'] }>(d: T): T => ({ ...d, bisect: d.bisect ? rangeHere(d.golden, d.bisect, here) : null, revisions: revisionsHere(d.revisions, here, subjects) });
  return { ...view, divergences: view.divergences.map(inCheckout), failures: view.failures.map(inCheckout) };
}

// Find the commit that named no first bad commit, in the activity feed: why, so the next search
// starts elsewhere. A golden's answer opens Tests, which shows it; a run's, the run.
describeEvent('bisect.none', (e, d) => ({ kind: 'test', text: `No first bad commit · ${e.ref ?? 'Find the commit'}${typeof d.why === 'string' && d.why ? `: ${d.why}` : ''}`, href: e.runId ? `#/run/${e.runId}` : '#/tests' }));

export function register(router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];
  // The rules in the config now: a divergence they already mask needs only a re-run. A config that
  // can't be read leaves that out rather than the whole screen.
  const normalizers = (): Normalizer[] => {
    try {
      return ctx.config().normalize;
    } catch {
      return [];
    }
  };
  // Another job replaying or rewriting the goldens, then a session from a terminal: the job is named first.
  const busy = (store: Store, projectId: string | null, verb: string) => testsBusy(ctx.jobs.list(), projectId, verb) ?? sessionBusy(store, verb);

  router.get('/tests', (r) => {
    r.tagged(rangesInCheckout(testsView(ctx.store, goldens(), { folder: FOLDER, normalizers: normalizers() }), ctx.project?.path));
  });

  // A run's page: the diverged-test banner of a replay `shadowlap test` made, and Find the commit's
  // choices for any run (`before`: the calendar's first day picked, in milliseconds).
  router.get('/tests/runs/:id', (r) => {
    const run = ctx.store.getRun(r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id}`);
    const raw = r.query.get('before');
    const before = raw === null || raw === '' ? undefined : Number(raw);
    if (before !== undefined && !Number.isFinite(before)) throw new HttpError(400, 'before is a time in milliseconds');
    const bisect = bisectChoices(ctx.store, run.runId, { goldens: goldens(), ...(before !== undefined ? { before } : {}) });
    r.tagged({ banner: testRunBanner(ctx.store, run.runId, { normalizers: normalizers() }), bisect: bisect && choicesInCheckout(ctx.project?.path, bisect) });
  });

  // A gate's figures, previewed before they are saved: what it means, what it costs, and its odds.
  router.get('/tests/gate', (r) => {
    let preview;
    try {
      preview = gatePreview(r.query);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    r.tagged(preview);
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
        defaultBranch: git.defaultBranch,
        recordings: list.length ? testPatterns(list, FOLDER).join(' ') : `${FOLDER}/*`,
        // Push from CI, read as Settings → Store reads it: the Fix on failure step pushes when it is on.
        teamStore: ctx.project ? readTeamStoreInput({ cwd: ctx.project.path }) : null,
        // Which goldens run live in CI, and the providers' keys each step's env needs.
        goldens: ctx.project ? goldenProviders(ctx.project.path, list) : null,
        // A config that can't be read hides both: the steps say what they leave out.
        configError: ctx.project ? configFileError(ctx.project.path) : null,
      }),
    );
  });

  // `shadowlap test` on one golden links to its replay itself: the one that passed, or the one that failed.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.test, {
    title: () => 'Running the tests',
    build: (req, { store, projectId }) => testsBuild(runTestsJob(goldens(), req, { folder: FOLDER }), busy(store, projectId, req.golden === undefined ? 'run the tests' : 'run it again')),
  });
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.update, {
    title: () => 'Updating goldens',
    build: (req, { store, projectId }) => testsBuild(updateGoldensJob(goldens(), req), busy(store, projectId, 'update it')),
  });
  // A golden's search waits for the tests, and they for it; a run's searches nothing on disk.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.bisect, {
    title: () => 'Finding the commit',
    build: (req, { store, project, projectId }) => {
      const job = bisectJob(store, goldens(), req, project ? { here: (revs) => commitsHere(project.path, revs) } : {});
      return testsBuild(job, 'args' in job && inTestFamily({ kind: TEST_JOB_KINDS.bisect, args: job.args }) ? busy(store, projectId, 'find the commit') : null);
    },
  });
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.normalize, {
    title: () => 'Adding a normalizer',
    build: (req, { store, projectId }) => testsBuild(normalizeAndTestJob(store, goldens(), req), busy(store, projectId, 'add the normalizer')),
  });
}
