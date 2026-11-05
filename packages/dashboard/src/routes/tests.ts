import { ACTIONS, confirmWords, messageOf, noEstimate, type Normalizer, type StoreOf } from '@shadowlap/engine';
import { describeEvent } from '../activity.js';
import { lookupRun, noSuchRun } from '../api.js';
import { liveChaosSession } from '../chaos.js';
import { ciWorkflows, fixPreview, gitFacts, goldenProviders, parseCiOptions } from '../ci-workflows.js';
import { choicesInCheckout, commitsHere, commitSubjects, rangeHere, revisionsHere } from '../commits-here.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { JobBuildResult } from '../jobs.js';
import { links } from '../links.js';
import { searchedCommits } from '../next-step.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { loadRunIndex, runAffinity } from '../run-index.js';
import { configFileError } from '../settings.js';
import { readTeamStoreInput } from '../team-store.js';
import { liveAsk } from '../tests-live.js';
import { bisectChoices, bisectJob, checkedRevision, gatePreview, liveTestSession, normalizeAndTestJob, runTestsJob, testPatterns, testRunBanner, testsSummary, testsView, updateGoldensJob, type BisectRange, type GoldenSource, type TestsJob, type TestsView } from '../tests.js';

/**
 * Tests: the goldens and how they did (`GET /api/tests`), what a run's page offers about a test
 * replay and Find breaking commit (`GET /api/tests/runs/:id`), what a gate's figures would do
 * (`GET /api/tests/gate?good=&bad=&risk=&max=`, or `?baseline=history&drop=&window=&min=&max=`
 * figured against `&history=47/50`), the
 * workflow steps Settings → CI shows (`GET /api/ci/workflows`), what Tests' buttons and Find breaking
 * commit would bill (`GET /api/tests/estimates`, `GET /api/estimates/bisect`, worked out beside the
 * server: estimates.ts), and the jobs the Tests screen starts:
 *
 *   test                 { golden?, maxAttempts?,       every golden on disk (the goldens folder's pattern, which the CLI
 *                          continue?, yes? }            expands without a shell, and each pack named elsewhere), or one;
 *                                                       `maxAttempts` raises each gate's limit for that session, and
 *                                                       `continue` carries an inconclusive gate's attempts over (Run more attempts)
 *   test-update          { goldens: [...] } | { golden } re-record each live with writes stubbed; replaced when its checks pass
 *   bisect               { golden | runId, good, bad? }  Find breaking commit: replays at each commit, halving the range;
 *                                                       for a run, as `GET /api/tests/runs/:id` offers it
 *   normalize-and-test   { golden | runId, path?, yes? } `normalize add` for each value made anew on every run, then `test` on the golden
 *
 * The goldens are the packs on disk, as the CLI lists them (`DashboardOptions.goldens`); a request
 * naming any other is refused. Jobs that replay or rewrite those packs (Find breaking commit on a golden
 * among them) run one at a time in a project (`testsBusy`), and none starts while a test session, or
 * a session of error-path presets on goldens, runs, wherever it was started (`sessionBusy`): a second
 * is refused with a 409 that names the one running. A `test` or `normalize-and-test` that would run a
 * golden live (marked fork, an injection gate) asks first: a 409 naming the goldens and why, whose
 * `confirm`, sent back as `yes`, starts it (tests-live.ts). One that only replays starts at once.
 */

/** The folder the project keeps its goldens in. */
const FOLDER = 'goldens';

/** The job kinds this module registers, by what they do. */
export const TEST_JOB_KINDS = { test: 'test', update: 'test-update', bisect: 'bisect', normalize: 'normalize-and-test' } as const;

/**
 * Jobs that replay the goldens on disk or rewrite them, by what each is doing: a second one at once
 * would replay a pack the other is rewriting, or report a session the other's results land in. A
 * setup's Keep it as a test packs a new golden and tests it. Find breaking commit on a golden reads its
 * pack and answers the failure it started from, so it runs alone too; on a run, it touches none.
 * The error-path presets replay a golden's pack (on a run, they touch none), and packing goldens
 * of production writes new ones into the goldens folder.
 */
const TEST_FAMILY = new Map<string, string>([
  ['test', 'a test session'],
  ['test-update', 'an update of goldens'],
  ['normalize-and-test', 'a normalizer and its re-run'],
  ['pack-test', 'a new golden being packed and tested'],
  ['bisect', confirmWords(ACTIONS.findBreakingCommit.label).toLowerCase()],
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
export function sessionBusy(store: StoreOf<'tests' | 'chaos'>, verb: string): string | null {
  const live = liveTestSession(store) ?? liveChaosSession(store);
  if (!live) return null;
  const command = live.command.join(' ');
  return `${command.length > 60 ? `${command.slice(0, 59)}…` : command} is running: ${verb} once it is done`;
}

/**
 * A tests job as the job runner takes it: `steps` become the first command and the ones `then` runs.
 * Refused for what the request got wrong first, then while another job or session holds the goldens
 * (`busy`), and only then does it ask what it waits on (`ask`, a 409 with its `confirm`: liveAsk), so
 * the question is never asked for a bad request, or for goldens another job or session holds. The
 * job runner checks the working tree only once the job is built, after the yes: the pages that ask
 * it wait while a job holds the tree instead, as the palette does (ui/tests-ask.ts).
 */
export function testsBuild(job: TestsJob, busy: string | null = null, ask: { error: string; status: 409; confirm: string } | null = null): JobBuildResult {
  if ('error' in job) return { error: job.error };
  if (busy) return { error: busy, status: 409 };
  if (ask) return ask;
  const runId = job.runId ? { runId: job.runId } : {};
  if ('args' in job) return { title: job.title, args: job.args, ...runId };
  const [first, ...then] = job.steps;
  if (!first) return { error: 'nothing to run' };
  return { title: job.title, args: first, ...(then.length ? { then } : {}), ...runId };
}

/**
 * Tests' Find breaking commit as the project's checkout can run it: a golden whose last pass was at a
 * commit this checkout lacks (a CI test session's merge commit, a teammate's) asks for a good one,
 * and one that failed at such a commit is searched up to HEAD. The commits its dialog offers are
 * those this checkout has, each with its subject. As it is without a project folder or when git
 * can't say.
 */
async function rangesInCheckout(view: TestsView, root: string | null | undefined): Promise<TestsView> {
  const all = [...view.divergences, ...view.failures];
  const revs = all.flatMap((d) => [d.bisect?.good ?? null, d.bisect?.bad ?? null, ...d.revisions.map((r) => r.rev)]);
  if (!root || !revs.some(Boolean)) return view;
  const here = await commitsHere(root, revs);
  if (!here) return view;
  const subjects = await commitSubjects(root, revs);
  const inCheckout = <T extends { golden: string; bisect: BisectRange | null; revisions: TestsView['divergences'][number]['revisions'] }>(d: T): T => ({ ...d, bisect: d.bisect ? rangeHere(d.golden, d.bisect, here) : null, revisions: revisionsHere(d.revisions, here, subjects) });
  return { ...view, divergences: view.divergences.map(inCheckout), failures: view.failures.map(inCheckout) };
}

// Find breaking commit that named no first bad commit, in the activity feed: why, so the next search
// starts elsewhere. A golden's answer opens Tests, which shows it; a run's, the run.
describeEvent('bisect.none', (e, d) => ({ kind: 'test', text: `No first bad commit · ${e.ref ?? confirmWords(ACTIONS.findBreakingCommit.label)}${typeof d.why === 'string' && d.why ? `: ${d.why}` : ''}`, href: e.runId ? links.run(e.runId) : links.tests() }));

/**
 * Find breaking commit's job as `req` asks it: whether this checkout has the commit a run's search
 * would end at is asked of git in `project` first, beside the server, as bisectJob looks it up.
 */
async function bisectHere(store: StoreOf<'recording' | 'fixes' | 'tests'>, goldens: readonly GoldenSource[], req: Record<string, unknown>, project: string | null): Promise<TestsJob> {
  let here: ((revs: string[]) => ReadonlySet<string> | null) | undefined;
  if (project && typeof req.runId === 'string' && /^[0-9A-Z]{26}$/.test(req.runId)) {
    const end = bisectChoices(store, req.runId, { goldens })?.bad ?? null;
    const known = await commitsHere(project, [end]);
    here = (revs) => (known ? new Set(revs.filter((rev) => known.has(rev))) : null);
  }
  return bisectJob(store, goldens, req, here ? { here } : {});
}

/** What a Find breaking commit job searches, as its arguments say (tests.ts `bisectArgs`): what it replays, from and up to which revision, and whether live. */
function searched(args: readonly string[]): { ref: string; good: string | null; bad: string | null; fork: boolean } {
  const after = (flag: string): string | null => {
    const at = args.indexOf(flag);
    return at > 1 ? (args[at + 1] ?? null) : null;
  };
  return { ref: args[1] ?? '', good: after('--good'), bad: after('--bad'), fork: args.includes('--fork') };
}

export function register(router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];
  const prices = () => (ctx.read.prices ? { prices: ctx.read.prices } : {});
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
  const busy = (store: StoreOf<'tests' | 'chaos'>, projectId: string | null, verb: string) => testsBusy(ctx.jobs.list(), projectId, verb) ?? sessionBusy(store, verb);

  router.get('/tests', async (r) => {
    r.tagged(await rangesInCheckout(testsView(ctx.store, goldens(), { folder: FOLDER, normalizers: normalizers() }), ctx.project?.path));
  });

  // A run's page: the diverged-test banner of a replay `shadowlap test` made, and Find breaking commit's
  // choices for any run (`before`: the calendar's first day picked, in milliseconds).
  router.get('/tests/runs/:id', async (r) => {
    const run = ctx.store.getRun(r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id!}`);
    const raw = r.query.get('before');
    const before = raw === null || raw === '' ? undefined : Number(raw);
    if (before !== undefined && !Number.isFinite(before)) throw new HttpError(400, 'before is a time in milliseconds');
    const bisect = bisectChoices(ctx.store, run.runId, { goldens: goldens(), ...(before !== undefined ? { before } : {}) });
    r.tagged({ banner: testRunBanner(ctx.store, run.runId, { normalizers: normalizers() }), bisect: bisect && (await choicesInCheckout(ctx.project?.path, bisect)) });
  });

  // What Run tests and each golden's buttons would bill, worked out beside the server: they read the
  // goldens' recordings, and the attempts of their last sessions.
  router.get('/tests/estimates', async (r) => {
    const list = goldens();
    const { byId } = loadRunIndex(ctx.store);
    const calls = list.reduce((n, g) => n + (g.runId ? (byId.get(g.runId)?.calls ?? 0) : 0), 0);
    sendAnswer(r, await ctx.reads.run({ kind: 'tests-estimates', goldens: list, folder: FOLDER, ...prices() }, { calls }));
  });

  // Find breaking commit's, as its dialog's revisions are typed: the job its build would start, the
  // commits between counted by git here, then priced beside the server. None until it has a commit
  // to start from; a job it would refuse, priced as nothing with why.
  router.get('/estimates/bisect', async (r) => {
    const param = (key: string) => r.query.get(key)?.trim() || null;
    const [runId, golden, good, bad] = [param('runId'), param('golden'), param('good'), param('bad')];
    if ((runId === null) === (golden === null)) throw new HttpError(400, 'name a run (runId) or a golden (golden)');
    if ((good !== null && !checkedRevision(good)) || (bad !== null && !checkedRevision(bad))) throw new HttpError(400, 'good and bad are commits: a sha, a tag or a branch');
    const list = goldens();
    const run = runId === null ? null : lookupRun(ctx.store, runId);
    if (runId !== null && !run) {
      const no = noSuchRun(ctx.store, runId);
      throw new HttpError(no.status, no.message);
    }
    if (golden !== null && !list.some((g) => g.path === golden)) throw new HttpError(404, `no golden ${golden.slice(0, 80)}`);
    const job = good === null ? null : await bisectHere(ctx.store, list, { ...(run ? { runId: run.runId } : { golden }), good, bad }, ctx.project?.path ?? null);
    if (job && !('args' in job)) return r.json({ estimate: noEstimate('bisect', 'error' in job ? job.error : 'it runs nothing') });
    const plan = job ? searched(job.args) : null;
    const commits = await searchedCommits(ctx.project?.path, plan?.good ?? null, plan?.bad ?? 'HEAD');
    if (!plan || typeof commits !== 'number') return r.json({ estimate: commits });
    const source = list.find((g) => g.path === plan.ref);
    const target = source ? { golden: source } : { runId: plan.ref, fork: plan.fork };
    sendAnswer(r, await ctx.reads.run({ kind: 'bisect-estimate', commits, target, ...prices() }, source ? {} : runAffinity(ctx.store, plan.ref)));
  });

  // A gate's figures, previewed before they are saved: what it means, what it costs, and its odds.
  router.get('/tests/gate', (r) => {
    let preview;
    try {
      preview = gatePreview(r.query);
    } catch (err) {
      throw new HttpError(400, messageOf(err));
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

  // `shadowlap test` on one golden links to its replay itself: the one that passed, or the one that
  // failed. A session that runs a golden live asks first; one that only replays starts at once.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.test, {
    title: () => ACTIONS.runTests.doing,
    build: (req, { store, projectId }) => {
      const list = goldens();
      const job = runTestsJob(list, req, { folder: FOLDER });
      return testsBuild(job, busy(store, projectId, req.golden === undefined ? 'run the tests' : 'run it again'), liveAsk(list, job, req.yes));
    },
  });
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.update, {
    title: () => ACTIONS.updateGoldens.doing,
    build: (req, { store, projectId }) => testsBuild(updateGoldensJob(goldens(), req), busy(store, projectId, 'update it')),
  });
  // A golden's search waits for the tests, and they for it; a run's searches nothing on disk.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.bisect, {
    title: () => ACTIONS.findBreakingCommit.doing,
    build: async (req, { store, project, projectId }) => {
      const job = await bisectHere(store, goldens(), req, project?.path ?? null);
      return testsBuild(job, 'args' in job && inTestFamily({ kind: TEST_JOB_KINDS.bisect, args: job.args }) ? busy(store, projectId, 'find the breaking commit') : null);
    },
  });
  // The golden's test after the rule asks first as Run tests does, when it runs live.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.normalize, {
    title: () => ACTIONS.addNormalizerAndRerun.doing,
    build: (req, { store, projectId }) => {
      const list = goldens();
      const job = normalizeAndTestJob(store, list, req);
      return testsBuild(job, busy(store, projectId, 'add the normalizer'), liveAsk(list, job, req.yes));
    },
  });
}
