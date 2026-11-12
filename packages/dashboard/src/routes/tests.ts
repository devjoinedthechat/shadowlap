import { ACTIONS, confirmWords, messageOf, noEstimate, normalizeAddArgs, type Normalizer, type StoreOf } from '@shadowlap/engine';
import { lookupRun, noSuchRun } from '../api.js';
import { liveChaosSession } from '../chaos.js';
import { choicesInCheckout, commitAuthors, commitsBefore, commitsHere, commitSubjects, rangeHere, revisionsHere } from '../commits-here.js';
import type { RouteContext } from '../context.js';
import { foundsHere, servesFound } from '../found-here.js';
import { goldenReports, withFailedRuns, type TestsAnswer } from '../golden-report.js';
import { HttpError } from '../http.js';
import type { JobBuildResult } from '../jobs.js';
import { searchedCommits, type NextStep } from '../next-step.js';
import { nextStepWork, projectWork } from '../outcome-work.js';
import { answerData, sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { loadRunIndex, runAffinity, type RunIndex } from '../run-index.js';
import { namesTeamStore } from './verdicts.js';
import { revertJob } from '../revert-job.js';
import { olderThanTree, revisionCommits, treeNow, withRevisionFacts } from '../tests-history.js';
import { gateQuery } from '../tests-gate.js';
import { liveAsk } from '../tests-live.js';
import { bisectChoices, bisectJob, checkedRevision, knownGolden, liveTestSession, normalizeAndTestJob, runTestsJob, testRunBanner, testsView, updateGoldensJob, type GoldenSource, type TestsJob, type TestsView, type UntestedCommit } from '../tests.js';
import { divergenceOf, rulesToAdd, volatileOf } from '../tests-normalize.js';

/**
 * Tests: the goldens and how they did (`GET /api/tests`), what a run's page offers about a test
 * replay and Find breaking commit (`GET /api/tests/runs/:id`), what a gate's figures would do
 * (`GET /api/tests/gate?good=&bad=&risk=&max=`, or `?baseline=history&drop=&window=&min=&max=`
 * figured against `&history=47/50`, with `&suiteRisk=` for CI's figure, as Settings → CI's Gates
 * previews them, worked out beside the server: tests-gate.ts), what Tests' buttons and
 * Find breaking commit would bill (`GET /api/tests/estimates`, `GET /api/estimates/bisect`, worked
 * out beside the server: estimates.ts), a gated golden's attempts (`GET /api/tests/evidence?golden=`,
 * beside the server: tests-evidence.ts), and the jobs the Tests screen starts:
 *
 *   test                 { golden?, maxAttempts?,       every golden on disk (the goldens folder's pattern, which the CLI
 *                          continue?, yes? }            expands without a shell, and each pack named elsewhere), or one;
 *                                                       `maxAttempts` raises each gate's limit for that session, and
 *                                                       `continue` carries an inconclusive gate's attempts over (Run more attempts)
 *   test-update          { goldens: [...] } | { golden } re-record each live with writes stubbed; replaced when its checks pass;
 *                        { goldens, normalize: true } Add normalizer and update: first `normalize add` for each value made
 *                                                       anew on every run that they diverged on, each rule once
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
export const GOLDENS_FOLDER = 'goldens';
const FOLDER = GOLDENS_FOLDER;

/** The job kinds this module registers, by what they do. */
export const TEST_JOB_KINDS = { test: 'test', update: 'test-update', bisect: 'bisect', normalize: 'normalize-and-test', revert: 'revert' } as const;

/**
 * Jobs that replay the goldens on disk or rewrite them, by what each is doing: a second one at once
 * would replay a pack the other is rewriting, or report a session the other's results land in. A
 * setup's Pack packs a new golden and tests it. Find breaking commit on a golden reads its
 * pack and answers the failure it started from, so it runs alone too; on a run, it touches none.
 * The error-path presets replay a golden's pack (on a run, they touch none), and packing goldens
 * of production writes new ones into the goldens folder. Revert tests the golden once git has
 * reverted its first bad commit (revert-job.ts).
 */
const TEST_FAMILY = new Map<string, string>([
  ['test', 'a test session'],
  ['test-update', 'an update of goldens'],
  ['normalize-and-test', 'a normalizer and its re-run'],
  ['pack-test', 'a new golden being packed and tested'],
  ['bisect', confirmWords(ACTIONS.findBreakingCommit.label).toLowerCase()],
  ['chaos', 'a session of error-path presets'],
  ['coverage-pack', 'a coverage pack'],
  ['revert', 'a revert'],
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
export function testsBuild(job: TestsJob, busy: string | null = null, ask: { error: string; status: 409; confirm: string; live?: unknown } | null = null): JobBuildResult {
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
 * Add normalizer and update, for several goldens: each rule tests-normalize.ts finds for them (a value
 * their last replays diverged on that is made anew on every run, its rule not in the config), each
 * once, then the update of every golden named. Refused as Update goldens refuses, and when it would
 * mask nothing. No question: the update's dialog asked, and an update re-records whatever the mode.
 */
export function normalizeAndUpdateJob(store: StoreOf<'tests'>, goldens: readonly GoldenSource[], req: Record<string, unknown>, config: readonly Normalizer[]): TestsJob {
  const update = updateGoldensJob(goldens, req);
  if (!('args' in update)) return update;
  const rules: Normalizer[] = [];
  // `test <goldens…> --update`: the goldens as checked, each once.
  for (const golden of update.args.slice(1, -1)) {
    const latest = store.listTestResults({ golden, limit: 1 })[0];
    const d = latest?.failure === 'diverged' ? divergenceOf(latest) : null;
    if (latest && d) rules.push(...rulesToAdd(volatileOf(latest, d), [...config, ...rules]));
  }
  if (!rules.length) return { error: 'none of them diverged on a value that changes every run: update them' };
  return { title: ACTIONS.updateGoldens.doing, steps: [...rules.map((rule) => normalizeAddArgs(rule)), update.args] };
}

/**
 * Tests' Find breaking commit as the project's checkout can run it: a golden whose last pass was at a
 * commit this checkout lacks (a CI test session's merge commit, a teammate's) asks for a good one,
 * and one that failed at such a commit is searched up to HEAD. The commits its dialog offers are
 * those this checkout has, each with its subject, and with no range to search (it never passed), the
 * few before the one it failed at that it was never tested at. As it is without a project folder or
 * when git can't say.
 */
async function rangesInCheckout(store: StoreOf<'tests'>, view: TestsView, root: string | null | undefined): Promise<TestsView> {
  const all = [...view.divergences, ...view.failures];
  const revs = all.flatMap((d) => [d.bisect?.good ?? null, d.bisect?.bad ?? null, ...d.revisions.map((r) => r.rev)]);
  if (!root || !all.length) return view;
  const here = revs.some(Boolean) ? await commitsHere(root, revs) : new Set<string>();
  if (!here) return view;
  const subjects = await commitSubjects(root, revs);
  const inCheckout = async <T extends Pick<TestsView['divergences'][number], 'golden' | 'bisect' | 'missed' | 'revisions' | 'untested'>>(d: T): Promise<T> => {
    const bisect = d.bisect ? rangeHere(d.golden, d.bisect, here) : null;
    const revisions = revisionsHere(d.revisions, here, subjects);
    return { ...d, bisect, revisions, ...(bisect || d.missed ? {} : { untested: await untestedBefore(store, root, d.golden, revisions) }) };
  };
  return { ...view, divergences: await Promise.all(view.divergences.map(inCheckout)), failures: await Promise.all(view.failures.map(inCheckout)) };
}

/**
 * The commits before the one a golden last failed at, along this checkout's first parents, that it
 * was never tested at (none of `tested`), each with its subject: Find breaking commit offers them for
 * a golden that never passed, as `not tested there`. None for a result with no commit.
 */
async function untestedBefore(store: StoreOf<'tests'>, root: string, golden: string, tested: readonly { rev: string }[]): Promise<UntestedCommit[]> {
  const bad = store.listTestResults({ golden, limit: 1 })[0]?.revision?.replace(/\+dirty$/, '');
  if (!bad) return [];
  const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  return (await commitsBefore(root, bad)).filter((c) => !tested.some((t) => same(c.rev, t.rev)));
}

/**
 * What git says of Tests' revisions beside the server: each one's commit subject, and its author's
 * email where names show (a team store configured), and whether the working tree has moved on since
 * the session the verdict names. As it is without a project folder.
 */
async function revisionsInCheckout(view: TestsView, root: string | null | undefined): Promise<TestsView> {
  if (!root) return view;
  const commits = revisionCommits(view.revisions);
  const shared = namesTeamStore(root);
  const session = view.verdict?.session ?? null;
  const [subjects, authors, tree] = await Promise.all([commitSubjects(root, commits), shared ? commitAuthors(root, commits) : new Map<string, string>(), session?.revision && session.endedAt !== null ? treeNow(root, session.revision) : null]);
  return { ...withRevisionFacts(view, subjects, authors, shared), older: olderThanTree(session, tree) };
}

/** Each first bad commit as the dashboard serves one (found-here.ts): its author only where names show, its file's place in the project folder. */
async function foundInCheckout(view: TestsView, root: string | null | undefined): Promise<TestsView> {
  const serve = servesFound(root);
  const [divergences, failures] = await Promise.all([foundsHere(view.divergences, serve), foundsHere(view.failures, serve)]);
  return { ...view, divergences, failures };
}

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

/** The calls of the attempts of each golden's newest test, as the run index counts them: what Tests' estimates price an attempt from. */
function attemptCalls(store: StoreOf<'tests'>, byId: RunIndex['byId'], goldens: readonly GoldenSource[]): number {
  let n = 0;
  for (const g of goldens) for (const id of store.listTestResults({ golden: g.path, limit: 1 })[0]?.data?.attempts?.runs ?? []) n += byId.get(id)?.calls ?? 0;
  return n;
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

  // A pooled read's answer, or null where it fails: what it adds is left out, never the page.
  const pooled = async <T>(read: () => ReturnType<typeof ctx.reads.run>): Promise<T | null> => {
    try {
      return answerData<T>(await read());
    } catch {
      return null;
    }
  };

  // Each golden that didn't pass with the step it leads with, as its replay's page leads, worked out
  // beside the server: the light form, which reads no call. Left out when that read fails: the page
  // then leads with Run tests. And its report (golden-report.ts), from its last result read by key,
  // after the first bad commit is served as the card shows it, with its own failed replays under
  // Runs › Failed, which reads every run's row, so beside the server too.
  const withSteps = async (view: TestsView): Promise<TestsAnswer> => {
    const listed = [...view.divergences, ...view.failures, ...view.inconclusive];
    if (!listed.length) return view;
    const reports = goldenReports(view, { store: ctx.store, goldens: goldens(), normalizers: normalizers(), project: ctx.project?.path ?? null });
    const named = Object.values(reports).map((x) => x.golden);
    const [steps, runs] = await Promise.all([
      pooled<Record<string, NextStep>>(() => ctx.reads.run({ kind: 'tests-steps', goldens: listed.map((d) => d.golden), next: nextStepWork(ctx) })),
      named.length ? pooled<Record<string, { count: number; ids: string[] }>>(() => ctx.reads.run({ kind: 'tests-failed-runs', goldens: named, outcome: projectWork(ctx).outcome })) : null,
    ]);
    return { ...view, ...(steps ? { steps } : {}), reports: withFailedRuns(reports, runs, steps ?? undefined) };
  };

  router.get('/tests', async (r) => {
    const view = await rangesInCheckout(ctx.store, testsView(ctx.store, goldens(), { folder: FOLDER, normalizers: normalizers() }), ctx.project?.path);
    r.tagged(await withSteps(await revisionsInCheckout(await foundInCheckout(view, ctx.project?.path), ctx.project?.path)));
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

  // A gated golden's attempts, each judged from its run, asked when the row under it opens: read in
  // the pool, by key. A golden not on disk is refused here, before the pool is asked.
  router.get('/tests/evidence', async (r) => {
    const golden = knownGolden(goldens(), r.query.get('golden'));
    if (!golden) throw new HttpError(400, 'golden: name a golden on disk');
    sendAnswer(r, await ctx.reads.run({ kind: 'tests-evidence', golden }));
  });

  // What Run tests and each golden's buttons would bill, worked out beside the server: they read the
  // goldens' recordings, and the attempts of their last sessions. `update`, given once for each golden,
  // prices Update goldens… for those together.
  router.get('/tests/estimates', async (r) => {
    const list = goldens();
    const update = r.query.getAll('update').filter((path) => list.some((g) => g.path === path));
    const { byId } = loadRunIndex(ctx.store);
    const calls = list.reduce((n, g) => n + (g.runId ? (byId.get(g.runId)?.calls ?? 0) : 0), 0) + attemptCalls(ctx.store, byId, list);
    sendAnswer(r, await ctx.reads.run({ kind: 'tests-estimates', goldens: list, folder: FOLDER, ...(update.length ? { update } : {}), ...prices() }, { calls }));
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
    // A golden's search is priced from its newest test's attempts, each as dear as the costliest.
    const reads = source ? { calls: attemptCalls(ctx.store, loadRunIndex(ctx.store).byId, [source]) } : runAffinity(ctx.store, plan.ref);
    sendAnswer(r, await ctx.reads.run({ kind: 'bisect-estimate', commits, target, ...prices() }, reads));
  });

  // A gate's figures, previewed before they are saved: what it means, what it costs, and its odds,
  // worked out beside the server, since CI's figure plans a session.
  router.get('/tests/gate', async (r) => {
    let figures;
    try {
      figures = gateQuery(r.query);
    } catch (err) {
      throw new HttpError(400, messageOf(err));
    }
    sendAnswer(r, await ctx.reads.run({ kind: 'gate-preview', ...figures }));
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
  // Several at once with their rules first (`normalize`) are a job of their own.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.update, {
    title: () => ACTIONS.updateGoldens.doing,
    build: (req, { store, projectId }) =>
      req.normalize === true ? testsBuild(normalizeAndUpdateJob(store, goldens(), req, normalizers()), busy(store, projectId, 'update them')) : testsBuild(updateGoldensJob(goldens(), req), busy(store, projectId, 'update it')),
  });
  // A golden's search waits for the tests, and they for it; a run's searches nothing on disk.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.bisect, {
    title: () => ACTIONS.findBreakingCommit.doing,
    build: async (req, { store, project, projectId }) => {
      const job = await bisectHere(store, goldens(), req, project?.path ?? null);
      return testsBuild(job, 'args' in job && inTestFamily({ kind: TEST_JOB_KINDS.bisect, args: job.args }) ? busy(store, projectId, 'find the breaking commit') : null);
    },
  });
  // Revert: git first, from the golden's standing answer, then its test, which asks first as Run
  // tests does when it runs live. It holds the working tree, and waits for the tests as they for it.
  ctx.jobs.registerJobKind(TEST_JOB_KINDS.revert, {
    title: () => ACTIONS.revert.doing,
    build: async (req, { store, project, projectId }) => {
      const list = goldens();
      const job = await revertJob(store, list, req, project?.path ?? null);
      if ('error' in job) return job;
      const waits = busy(store, projectId, 'revert it');
      return waits ? { error: waits, status: 409 } : (liveAsk(list, { title: job.title ?? ACTIONS.revert.doing, args: job.args }, req.yes) ?? job);
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
