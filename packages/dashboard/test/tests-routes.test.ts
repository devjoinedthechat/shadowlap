import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type TestResultData } from '@shadowlap/engine';
import { startDashboard, type CiWorkflowsView, type Dashboard, type GoldenSource, type JobView, type SpawnCli, type TestsView } from '../src/index.js';

/**
 * The Tests screen's API: `GET /api/tests` over the goldens the CLI lists, `GET /api/ci/workflows`
 * for Settings → CI, and the four jobs the screen starts, each built from checked fields and run by
 * a stand-in CLI that reports what `shadowlap test` reports.
 */
const FAKE = fileURLToPath(new URL('./fake-tests-cli.mjs', import.meta.url));
const T0 = Date.UTC(2026, 8, 30, 10, 0);
const UUID_A = '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f';
const UUID_B = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const goldens: GoldenSource[] = [
  { path: 'goldens/refund-flow', runId: 'GOLDEN_FLOW', packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: ['issue_refund called 1 time'] },
  { path: 'goldens/refund-in-limit', runId: 'GOLDEN_LIMIT', packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'goldens/broken-flow', runId: 'GOLDEN_BROKEN', packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'evals/kept-elsewhere', runId: 'GOLDEN_ELSE', packedAt: T0, mode: 'fork', repeat: 3, passes: 3, checks: ['send_email called 0 times'] },
];

let project: string;
let store: Store;
let dash: Dashboard;
let bare: Dashboard;
const spawned: string[][] = [];

const spawnCli: SpawnCli = (args, options) => {
  spawned.push(args);
  return spawn(process.execPath, [FAKE, ...args], {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options?.events ? { SHADOWLAP_EVENTS_FD: '3' } : {}) },
    stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
};

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const getJson = async <T>(d: Dashboard, path: string): Promise<T> => {
  const res = await api(d, path);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};
const post = (body: unknown) => api(dash, 'jobs', { method: 'POST', body: JSON.stringify(body) });

async function job(body: unknown): Promise<JobView> {
  const res = await post(body);
  expect(res.status, await res.clone().text()).toBe(202);
  const started = (await res.json()) as JobView;
  for (let i = 0; i < 400; i++) {
    const view = await getJson<JobView>(dash, `jobs/${started.id}`);
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${started.id} did not finish`);
}

function seed(s: Store): void {
  for (const runId of ['GOLDEN_FLOW', 'R1_FLOW', 'R2_FLOW', 'R2_LIMIT', 'R1_LIMIT']) s.createRun({ runId, mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' } });
  const ok: TestResultData = { mode: 'replay', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } };
  const one = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'c91d0f4', actor: 'ci', startedAt: T0 - 86_400_000 });
  s.addTestResult({ sessionId: one.sessionId, golden: 'goldens/refund-flow', ok: true, runId: 'R1_FLOW', goldenRunId: 'GOLDEN_FLOW', revision: 'c91d0f4', at: T0 - 86_400_000 + 1, data: ok });
  s.addTestResult({ sessionId: one.sessionId, golden: 'goldens/refund-in-limit', ok: true, runId: 'R1_LIMIT', goldenRunId: 'GOLDEN_LIMIT', revision: 'c91d0f4', at: T0 - 86_400_000 + 2, data: ok });
  s.finishTestSession(one.sessionId, { passed: 2, failed: 0, upstreamRequests: 0, endedAt: T0 - 86_400_000 + 10 });
  const two = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', actor: 'ci', startedAt: T0 });
  s.addTestResult({ sessionId: two.sessionId, golden: 'goldens/refund-flow', ok: true, runId: 'R2_FLOW', goldenRunId: 'GOLDEN_FLOW', revision: 'd2e8a1f', at: T0 + 1, data: ok });
  s.addTestResult({
    sessionId: two.sessionId,
    golden: 'goldens/refund-in-limit',
    ok: false,
    failure: 'diverged',
    reason: 'diverged at call 1 (api POST /v1/messages)',
    runId: 'R2_LIMIT',
    goldenRunId: 'GOLDEN_LIMIT',
    revision: 'd2e8a1f',
    at: T0 + 2,
    data: {
      mode: 'replay',
      divergence: {
        type: 'request_changed',
        callNo: 1,
        kind: 'api',
        name: 'POST /v1/messages',
        replayedBefore: 0,
        diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }],
        text: `✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence\n  ~ $.metadata.user_id\n      - "${UUID_A}"\n      + "${UUID_B}"`,
      },
    },
  });
  s.finishTestSession(two.sessionId, { passed: 1, failed: 1, upstreamRequests: 0, endedAt: T0 + 10 });
}

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'sl-tests-routes-'));
  // The project's git files, as gitFacts reads them: a GitHub remote and a branch checked out.
  mkdirSync(join(project, '.git'));
  writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/fix-refund-limit\n');
  writeFileSync(join(project, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/support-agent.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  store = Store.open(':memory:');
  seed(store);
  dash = await startDashboard({ store, spawnCli, readOnly: false, project: { path: project }, goldens: () => goldens });
  bare = await startDashboard({ store: Store.open(':memory:') });
});

afterAll(async () => {
  await dash?.close();
  await bare?.close();
  store?.close();
  rmSync(project, { recursive: true, force: true });
});

describe('GET /api/tests', () => {
  it('reads the goldens the CLI lists and how each did', async () => {
    const view = await getJson<TestsView>(dash, 'tests');
    expect(view.empty).toBe(false);
    expect(view.goldens).toBe(4);
    expect(view.verdict).toMatchObject({ state: 'failing', failing: 1, passing: 1, untested: 2, title: 'refund-in-limit diverged at call 1', session: { revision: 'd2e8a1f', passed: 1, failed: 1 } });
    expect(view.revisions).toEqual(['c91d0f4', 'd2e8a1f']);
    expect(view.rows.map((r) => [r.name, r.modeLabel, r.last.result])).toEqual([
      ['refund-flow', 'replay', 'pass'],
      ['refund-in-limit', 'replay', 'fail'],
      ['broken-flow', 'replay', null],
      ['evals/kept-elsewhere', 'fork ×3', null],
    ]);
    const [d] = view.divergences;
    expect(d).toMatchObject({ golden: 'goldens/refund-in-limit', callNo: 1, normalizerFixes: true, maybeReal: false, bisect: { good: 'c91d0f4', bad: 'd2e8a1f' } });
    expect(d!.volatile).toMatchObject({ path: '$.metadata.user_id', looks: 'a UUID', certain: true });
    expect(view.commands.run).toEqual(['test', 'goldens/*', 'evals/kept-elsewhere']);
    expect(view.commands.ci).toBe('shadowlap test goldens/* evals/kept-elsewhere --junit report.xml');
  });

  it('answers 304 when nothing changed, and shows no goldens on a dashboard given none', async () => {
    const first = await api(dash, 'tests');
    const etag = first.headers.get('etag')!;
    const again = await fetch(`${dash.url}/api/tests`, { headers: { 'x-shadowlap-token': dash.token, 'if-none-match': etag } });
    expect(again.status).toBe(304);
    const none = await getJson<TestsView>(bare, 'tests');
    expect(none).toMatchObject({ empty: true, goldens: 0, verdict: null, rows: [] });
  });
});

describe('GET /api/tests/runs/:id', () => {
  it('gives a run\'s page Find the commit\'s choices, and the banner of a test replay that diverged', async () => {
    // R2_LIMIT is a replay `shadowlap test` made of refund-in-limit in the failing session.
    store.updateRunMeta('R2_LIMIT', { test: { golden: 'goldens/refund-in-limit', session: store.listTestSessions()[0]!.sessionId } });
    const view = await getJson<{ banner: { golden: string; normalizerFixes: boolean } | null; bisect: { target: unknown; failed: boolean; good: string | null } | null }>(dash, 'tests/runs/R2_LIMIT');
    expect(view.bisect).toMatchObject({ target: { kind: 'golden', golden: 'goldens/refund-in-limit' }, failed: true, good: 'c91d0f4' });
    // Its run has no divergence of its own in this store, so there is no banner to show.
    expect(view.banner).toBeNull();
    // The calendar's first day picked limits the good commits to before it.
    expect((await getJson<{ bisect: { good: string | null } }>(dash, `tests/runs/R2_LIMIT?before=${T0 - 86_400_000}`)).bisect.good).toBeNull();
    expect((await api(dash, 'tests/runs/NOPE')).status).toBe(404);
    expect((await api(dash, 'tests/runs/R2_LIMIT?before=yesterday')).status).toBe(400);
  });
});

describe('GET /api/ci/workflows', () => {
  it('gives both panels with their defaults, the project\'s goldens, repository and failures', async () => {
    const ci = await getJson<CiWorkflowsView>(dash, 'ci/workflows');
    expect(ci.file).toBe('.github/workflows/agent.yml');
    expect(ci.recordings).toBe('goldens/* evals/kept-elsewhere');
    expect(ci.repository).toBe('acme/support-agent');
    expect(ci.fixOnFailure).toMatchObject({ on: false, budget: '2.00', repairer: 'claude-code', offNote: 'Off: a failed check fails the build, and nobody opens a fix.' });
    expect(ci.fixOnFailure.budgets.map((b) => b.label)).toEqual(['$1', '$2', '$5']);
    expect(ci.fixOnFailure.repairers.map((r) => r.value)).toEqual(['claude-code', 'anthropic', 'openai:gpt-5']);
    expect(ci.fixOnFailure.yaml).toContain("    recordings: 'goldens/* evals/kept-elsewhere'\n    fix-on-failure: true\n    fix-budget: 2.00\n    repairer: claude-code");
    expect(ci.fixOnFailure.needs[0]).toEqual({ label: 'a model key for the repairer', value: 'ANTHROPIC_API_KEY' });
    expect(ci.fixOnFailure.never.map((r) => r.value)).toEqual(['divergence', 'rejected', '$2.00', 'merge']);
    // No fix verified here yet: the pull request is the example, and says so.
    expect(ci.fixOnFailure.preview).toMatchObject({ example: true, fixId: null, author: 'github-actions', base: 'main', spent: '≈$0.84 of $2.00' });
    expect(ci.alerts).toMatchObject({ onlyMain: true, secret: 'SLACK_WEBHOOK_URL' });
    expect(ci.alerts.yaml).toContain("if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/main'");
    expect(ci.alerts.needs.map((r) => r.value)).toEqual(['Slack app', 'SLACK_WEBHOOK_URL', 'id: goldens']);
    expect(ci.alerts.failures.map((r) => r.value)).toEqual(['diverged', 'live call', 'exit ≠ 0', 'check failed']);
    expect(ci.alerts.message).toEqual({ app: 'GitHub Actions', text: 'Shadowlap: 1 golden(s) failed on main.', link: 'github.com/acme/support-agent/actions/runs/…', at: T0 + 10 });
  });

  it('follows the panels\' options as they change', async () => {
    const ci = await getJson<CiWorkflowsView>(dash, `ci/workflows?fix=on&budget=5&repairer=openai:gpt-5&onlyMain=off&secret=${encodeURIComponent('TEAM-ALERTS hook')}`);
    expect(ci.fixOnFailure).toMatchObject({ on: true, budget: '5.00', repairer: 'openai:gpt-5' });
    expect(ci.fixOnFailure.yaml).toContain('    fix-budget: 5.00\n    repairer: openai:gpt-5\n  env:\n    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(ci.fixOnFailure.yaml).not.toContain('claude-code');
    expect(ci.fixOnFailure.needs[0]!.value).toBe('OPENAI_API_KEY');
    expect(ci.fixOnFailure.preview.spent).toBe('≈$0.84 of $5.00');
    // The secret keeps the letters, digits and _ GitHub allows, and every branch is told.
    expect(ci.alerts.secret).toBe('TEAMALERTShook');
    expect(ci.alerts.yaml).toContain('webhook: ${{ secrets.TEAMALERTShook }}');
    expect(ci.alerts.yaml).not.toContain('refs/heads/main');
    expect(ci.alerts.needs[1]!.value).toBe('TEAMALERTShook');
    expect(ci.alerts.message.text).toBe('Shadowlap: 1 golden(s) failed on fix-refund-limit.');
  });

  it('refuses options it can\'t use, saying which', async () => {
    for (const [q, error] of [
      ['budget=lots', 'budget is an amount in dollars, such as 2.00'],
      ['budget=-1', 'budget is an amount in dollars, such as 2.00'],
      ['repairer=' + encodeURIComponent('claude-code; rm -rf /'), 'repairer is claude-code, anthropic or openai, with :<model> after it if you like'],
      ['fix=maybe', 'fix is on or off'],
    ] as const) {
      const res = await api(dash, `ci/workflows?${q}`);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
  });
});

describe('the Tests jobs', () => {
  it('are listed in meta for the screen to offer', async () => {
    const meta = await getJson<{ jobKinds: string[] }>(dash, 'meta');
    expect(meta.jobKinds).toEqual(expect.arrayContaining(['test', 'test-update', 'bisect', 'normalize-and-test']));
  });

  it('runs every golden, the server expanding none of them by a shell', async () => {
    spawned.length = 0;
    const view = await job({ kind: 'test' });
    expect(view).toMatchObject({ title: 'Running the tests', args: ['test', 'goldens/*', 'evals/kept-elsewhere'], code: 0 });
    expect(spawned).toEqual([['test', 'goldens/*', 'evals/kept-elsewhere']]);
  });

  it('runs one golden and links to its replay; a golden that is not on disk is refused', async () => {
    const view = await job({ kind: 'test', golden: 'goldens/refund-in-limit' });
    expect(view.args).toEqual(['test', 'goldens/refund-in-limit']);
    expect(view.links[0]).toEqual({ label: 'Open the passing run', href: '#/run/01K5CQ4V5K0000000000000002' });
    for (const golden of ['goldens/nope', '../outside', 'goldens/*; rm -rf /', 42]) {
      const res = await post({ kind: 'test', golden });
      expect(res.status, String(golden)).toBe(400);
    }
  });

  it('updates the goldens named, each once, and only goldens on disk', async () => {
    const view = await job({ kind: 'test-update', goldens: ['goldens/refund-in-limit', 'goldens/broken-flow', 'goldens/refund-in-limit'] });
    expect(view).toMatchObject({ title: 'Updating goldens', args: ['test', 'goldens/refund-in-limit', 'goldens/broken-flow', '--update'], code: 1 });
    expect((await job({ kind: 'test-update', golden: 'goldens/refund-in-limit' })).title).toBe('Updating a golden');
    expect((await post({ kind: 'test-update', goldens: ['goldens/refund-in-limit', '--online'] })).status).toBe(400);
    expect((await post({ kind: 'test-update', goldens: [] })).status).toBe(400);
  });

  it('finds the commit between revisions that look like ones, never an option', async () => {
    spawned.length = 0;
    const view = await job({ kind: 'bisect', golden: 'goldens/refund-in-limit', good: 'c91d0f4', bad: 'd2e8a1f' });
    expect(view).toMatchObject({ title: 'Finding the commit', args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'] });
    // A tested `+dirty` revision is its commit; no bad one is HEAD.
    expect((await job({ kind: 'bisect', golden: 'goldens/refund-in-limit', good: 'c91d0f4+dirty' })).args).toEqual(['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4']);
    for (const good of ['--upload-pack=touch /tmp/x', 'a..b', '', null]) {
      const res = await post({ kind: 'bisect', golden: 'goldens/refund-in-limit', good });
      expect(res.status, String(good)).toBe(400);
    }
  });

  it('adds the normalizer, then tests the golden, and links to the replay that passes', async () => {
    spawned.length = 0;
    const view = await job({ kind: 'normalize-and-test', golden: 'goldens/refund-in-limit' });
    const normalize = ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'];
    expect(spawned).toEqual([normalize, ['test', 'goldens/refund-in-limit']]);
    expect(view).toMatchObject({ title: 'Adding a normalizer', args: normalize, code: 0, newRunId: '01K5CQ4V5K0000000000000002', runId: 'R2_LIMIT' });
    expect(view.lines).toContain('$ shadowlap test goldens/refund-in-limit');
    expect(view.lines.indexOf('added normalizer #1 to shadowlap.config.json')).toBeLessThan(view.lines.indexOf('$ shadowlap test goldens/refund-in-limit'));
    expect(view.links.map((l) => l.label)).toEqual(['Open the passing run', 'Tests']);
    // A golden whose last replay did not diverge has nothing to normalize.
    const res = await post({ kind: 'normalize-and-test', golden: 'goldens/refund-flow' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('goldens/refund-flow did not diverge the last time it ran');
  });
});
