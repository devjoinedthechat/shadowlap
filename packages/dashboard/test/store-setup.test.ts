import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { parseStoreUrl, push, recordCheck, storeKey } from '@shadowlap/remote';

const storeKeyOf = (url: string) => storeKey(parseStoreUrl(url));
import { cliSpawner, startDashboard, type Dashboard, type JobView } from '../src/index.js';
import { VERSION } from '../src/ci-yaml.js';
import { checkSetupUrl, recordSetup, setupCommand, setupRecord, setupUnderWay, storeSetupView, type StoreSetupView } from '../src/store-setup.js';
import { nextSetupStep } from '../src/store-steps.js';
import { setupShowsOn } from '../ui/projects.js';
import { href, parseRoute, routeHref } from '../ui/route.js';
import { MemoryStore } from '../../remote/test/fakes/memory.js';
import { addRun, HOUR } from './read-model-store.js';
import { setupStates } from '../ui/pages/settings/store-logic.js';

/**
 * Settings → Store's setup of a team store: the read model (providers, where the setup stands, the
 * CI steps, the commit), a URL checked against the provider picked, the steps recorded, and the
 * job that connects a bucket, `store set <url> --provider <p> --check`, built on the server.
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const NOW = Date.now();
const URL_ = 's3://northwind-agent-runs/support-agent?region=eu-central-1';
const KEY = 's3://northwind-agent-runs/support-agent';

let project: string;
let store: Store;
let dash: Dashboard;
let ro: Dashboard;
const spawned: string[][] = [];

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
const get = async <T,>(d: Dashboard, path: string): Promise<T> => {
  const res = await api(d, path);
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as T;
};
const post = (d: Dashboard, path: string, body: unknown) => api(d, path, { method: 'POST', body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const setConfig = (config: Record<string, unknown> | null) => {
  const file = join(project, 'shadowlap.config.json');
  if (config) writeFileSync(file, JSON.stringify(config));
  else rmSync(file, { force: true });
};

async function finished(job: JobView): Promise<JobView> {
  for (let i = 0; i < 300; i++) {
    const view = (await (await api(dash, `jobs/${job.id}`)).json()) as JobView;
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job never ended');
}

beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-store-setup-')));
  store = Store.open(':memory:');
  addRun(store, { startedAt: NOW - 2 * HOUR, calls: 'll', meta: { author: 'dana@northwind.example' } });
  addRun(store, { startedAt: NOW - HOUR, calls: 'l' });
  const spawner = cliSpawner({ command: [process.execPath, FAKE], cwd: tmpdir() });
  const common = { store, dbPath: ':memory:', project: { path: project } };
  dash = await startDashboard({ ...common, spawnCli: (args, o) => (spawned.push(args), spawner(['text-only'], o)) });
  ro = await startDashboard({ ...common, readOnly: true });
});

afterAll(async () => {
  await dash.close();
  await ro.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

afterEach(() => setConfig(null));

describe('the setup read model', () => {
  it('offers every provider with its scheme and an example, and the runs a push would send, before any store', () => {
    const s = Store.open(':memory:');
    addRun(s, { startedAt: NOW - HOUR, calls: 'l' });
    addRun(s, { startedAt: NOW, calls: 'l', status: 'running' });
    const view = storeSetupView(s, { store: null }, { env: {}, home: tmpdir() });
    expect(view.store).toBeNull();
    expect(view).toMatchObject({ active: false, connected: false, pushed: false, ci: null, commit: null, runs: { onlyLocal: 1, pushedHere: 0 } });
    expect(view.providers.map((p) => [p.provider, p.name, p.scheme])).toEqual([
      ['s3', 'Amazon S3', 's3://'],
      ['gcs', 'Google Cloud', 'gs://'],
      ['azure', 'Azure Blob', 'az://'],
      ['r2', 'Cloudflare R2', 'r2://'],
    ]);
    // Nothing on this machine names credentials: each says where they would come from.
    expect(view.providers.every((p) => p.credentials === null && p.hint.uses.length > 0)).toBe(true);
    s.close();
  });

  it('follows a setup started here: connected once the check works, pushed, CI, then finished', async () => {
    const s = Store.open(':memory:');
    const r = s.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
    s.endRun(r.runId, 'completed');
    const input = { store: URL_ };
    expect(storeSetupView(s, input).active).toBe(false);
    // Set with the CLI: nothing under way, so Needs a look and the palette leave it alone.
    expect(setupUnderWay(s, input)).toBeNull();
    recordSetup(s, KEY, { startedAt: NOW, finishedAt: null });
    expect(setupUnderWay(s, input)).toEqual({ step: 1, title: 'Connect your bucket' });
    recordCheck(s, KEY, { ok: true, at: NOW, encryption: 'AES256', versioning: 'off', objectLock: 'off', credentials: 'AWS profile northwind' });
    let view = storeSetupView(s, input);
    expect(view).toMatchObject({ active: true, connected: true, pushed: false, runs: { onlyLocal: 1 }, store: { url: KEY, key: KEY, configured: URL_, name: 'northwind-agent-runs/support-agent', provider: 's3' } });
    expect(setupStates(view)).toEqual({ connect: 'done', push: 'cur', ci: 'todo', team: 'todo' });
    expect(view.next).toEqual({ step: 2, title: 'Push your runs' });
    expect(setupUnderWay(s, input)).toEqual(view.next);
    // Each CI's step, as store ci prints it, and the commit that brings the team in.
    expect(view.ci!.map((c) => [c.ci, c.name, c.command])).toEqual([
      ['github', 'GitHub Actions', 'shadowlap store ci --provider github'],
      ['gitlab', 'GitLab CI', 'shadowlap store ci --provider gitlab'],
      ['other', 'Other', 'shadowlap store ci --provider other'],
    ]);
    // Pinned as Settings → CI pins the action's step, and complete: Node 22 and the agent's dependencies first.
    expect(view.ci![0].text).toContain(`npx shadowlap@${VERSION} test goldens/* --push`);
    expect(view.ci![0].text).toContain('  - run: npm ci && npm run build   # whatever your agent needs to run\n');
    // On GitHub Actions, your workflow on Settings → CI runs the goldens and pushes: the setup gives its job the credentials alone,
    // and says that store ci prints them in a job of its own, which would run the goldens again.
    expect(view.ci![0].workflow).toEqual({
      href: '#/settings/ci',
      credentials: expect.stringMatching(/^- if: .*\n {2}uses: aws-actions\/configure-aws-credentials/),
      printed: 'shadowlap store ci --provider github prints these two steps in a job of its own, which would run your goldens a second time: copy only the two steps.',
    });
    expect(view.ci![0].text).toContain(view.ci![0].workflow!.credentials!.split('\n')[0]);
    expect(view.ci!.slice(1).map((c) => c.workflow)).toEqual([null, null]);
    // With R2 the keys are secrets and your workflow's step is the rest: nothing store ci prints goes in, so no command is offered.
    const r2 = storeSetupView(s, { store: 'r2://0123456789abcdef0123456789abcdef/northwind-agent-runs/support-agent' });
    expect(r2.ci!.map((c) => [c.ci, c.command, c.workflow])).toEqual([
      ['github', null, { href: '#/settings/ci', credentials: null, printed: null }],
      ['gitlab', 'shadowlap store ci --provider gitlab', null],
      ['other', 'shadowlap store ci --provider other', null],
    ]);
    expect(view.commit).toEqual({ file: 'shadowlap.config.json', line: `"store": "${URL_}"`, command: 'git add shadowlap.config.json && git commit -m "Use the team store"' });

    await push({ store: s, remote: new MemoryStore(parseStoreUrl(URL_)), actor: 'dana@northwind.example', now: () => NOW }, { all: true });
    view = storeSetupView(s, input);
    expect(view).toMatchObject({ pushed: true, runs: { onlyLocal: 0, pushedHere: 1 } });
    expect(setupStates(view)).toEqual({ connect: 'done', push: 'done', ci: 'cur', team: 'todo' });
    recordSetup(s, KEY, { ci: 'skipped', ciProvider: 'gitlab' });
    view = storeSetupView(s, input);
    expect(setupStates(view)).toEqual({ connect: 'done', push: 'done', ci: 'done', team: 'cur' });
    expect(setupUnderWay(s, input)).toEqual({ step: 4, title: 'Bring your team' });
    expect(view.setup).toMatchObject({ ci: 'skipped', ciProvider: 'gitlab', finishedAt: null });
    recordSetup(s, KEY, { finishedAt: NOW });
    view = storeSetupView(s, input);
    expect(view.active).toBe(false);
    expect(view.next).toBeNull();
    expect(setupUnderWay(s, input)).toBeNull();
    expect(setupStates(view)).toEqual({ connect: 'done', push: 'done', ci: 'done', team: 'done' });
    s.close();
  });

  it('counts nothing to push as pushed, and keeps what the bucket said apart from what this machine recorded', () => {
    const s = Store.open(':memory:');
    const view = storeSetupView(s, { store: URL_ });
    expect(setupStates({ ...view, connected: true })).toEqual({ connect: 'done', push: 'done', ci: 'cur', team: 'todo' });
    // A setup record from the bucket's data is never read: it is this machine's, kept per store.
    s.setTeamSync(KEY, { data: { setup: { startedAt: 'yesterday', ci: 'everything', ciProvider: 'jenkins', finishedAt: null } } });
    expect(setupRecord(s, KEY)).toEqual({ startedAt: null, ci: null, ciProvider: null, finishedAt: null });
    s.close();
  });
});

describe('a store URL typed in the setup', () => {
  it('is checked against the provider picked, with the policy for its bucket and folder and the command that connects it', () => {
    const wrong = checkSetupUrl('gcs', 's3://northwind-agent-runs/support-agent', { env: {} });
    expect(wrong).toMatchObject({ ok: false, error: 'A Google Cloud store starts with gs://, then the bucket and, if you like, a folder: gs://<bucket>/<folder>.' });
    // Without a URL, the policy names no bucket.
    expect(checkSetupUrl('s3', '', { env: {} }).policy.writer.text).toContain('arn:aws:s3:::your-bucket');
    const ok = checkSetupUrl('s3', URL_, { env: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'x' } });
    expect(ok).toMatchObject({ ok: true, configured: URL_, url: KEY, name: 'northwind-agent-runs/support-agent', command: `shadowlap store set '${URL_}' --provider s3 --check` });
    expect(ok.ok && ok.credentials).toMatchObject({ uses: expect.stringMatching(/keys/) });
    expect(ok.policy.writer.text).toContain('arn:aws:s3:::northwind-agent-runs/support-agent/*');
    expect(ok.policy.pullRequest.text).toContain('support-agent/pr/*');
    expect(ok.policy.command).toBe('shadowlap store policy --provider s3');
  });

  it('quotes the command only when a shell needs it', () => {
    expect(setupCommand('gs://agent-runs/team', 'gcs')).toBe('shadowlap store set gs://agent-runs/team --provider gcs --check');
    expect(setupCommand("s3://b/x?endpoint=http://minio:9000&path-style=true", 's3')).toBe("shadowlap store set 's3://b/x?endpoint=http://minio:9000&path-style=true' --provider s3 --check");
  });
});

describe('the setup page', () => {
  it('is a page of its own, #/setup/store, which opens before there are runs to push, as Settings does', () => {
    expect(parseRoute('#/setup/store')).toEqual({ page: 'store-setup' });
    expect(routeHref({ page: 'store-setup' })).toBe('#/setup/store');
    expect(href.storeSetup()).toBe('#/setup/store');
    // The project's own setup keeps #/setup.
    expect(parseRoute('#/setup')).toEqual({ page: 'setup' });
    expect(parseRoute('#/setup/store/more')).toEqual({ page: 'setup' });
    const noRuns = { exported: false, meta: null, runs: [] };
    expect(setupShowsOn({ page: 'store-setup' }, noRuns)).toBe(false);
    expect(setupShowsOn({ page: 'runs' }, noRuns)).toBe(true);
  });

  it('names the next step, each unlocking the next', () => {
    const facts = { connected: false, pushed: false, onlyLocal: 3, ci: null, finished: false } as const;
    expect(nextSetupStep(facts)).toEqual({ step: 1, title: 'Connect your bucket' });
    expect(nextSetupStep({ ...facts, connected: true })).toEqual({ step: 2, title: 'Push your runs' });
    // Nothing to push: that step is done.
    expect(nextSetupStep({ ...facts, connected: true, onlyLocal: 0 })).toEqual({ step: 3, title: 'Push from CI' });
    // CI said before the bucket was pushed to still waits for the push.
    expect(nextSetupStep({ ...facts, connected: true, ci: 'added' })).toEqual({ step: 2, title: 'Push your runs' });
    expect(nextSetupStep({ ...facts, connected: true, pushed: true, ci: 'skipped' })).toEqual({ step: 4, title: 'Bring your team' });
    expect(nextSetupStep({ connected: true, pushed: true, onlyLocal: 0, ci: 'added', finished: true })).toBeNull();
  });
});

describe('the setup routes', () => {
  it('reads where the setup stands, and checks a URL against the provider picked', async () => {
    const view = await get<StoreSetupView>(dash, 'store/setup');
    expect(view).toMatchObject({ store: null, active: false, runs: { onlyLocal: 2 } });
    const bad = await get<{ ok: boolean; error: string }>(dash, `store/setup/url?provider=azure&url=${encodeURIComponent('gs://x/y')}`);
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/^An Azure Blob store starts with az:\/\//) });
    const res = await api(dash, 'store/setup/url?provider=ftp&url=x');
    expect(res.status).toBe(400);
    // Read-only dashboards read it too.
    expect((await get<StoreSetupView>(ro, 'store/setup')).store).toBeNull();
  });

  it('connects a bucket with store set --check, and marks the setup started once that worked', async () => {
    const res = await post(dash, 'jobs', { kind: 'store-set', provider: 's3', url: `  ${URL_}  ` });
    expect(res.status, await res.clone().text()).toBe(202);
    const job = await finished((await res.json()) as JobView);
    expect(spawned.at(-1)).toEqual(['store', 'set', URL_, '--provider', 's3', '--check']);
    expect(job.code).toBe(0);
    expect(setupRecord(store, KEY).startedAt).toBe(job.startedAt);
    // A check that fails starts nothing: the store it named isn't set.
    const other = 's3://northwind-agent-runs/elsewhere';
    const failing = await startDashboard({ store, dbPath: ':memory:', project: { path: project }, spawnCli: (args, o) => cliSpawner({ command: [process.execPath, FAKE], cwd: tmpdir() })(['fail'], o) });
    try {
      const r = await fetch(`${failing.url}/api/jobs`, { method: 'POST', headers: { 'x-shadowlap-token': failing.token, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'store-set', provider: 's3', url: other }) });
      const started = (await r.json()) as JobView;
      for (let i = 0; i < 300; i++) {
        const v = (await (await fetch(`${failing.url}/api/jobs/${started.id}`, { headers: { 'x-shadowlap-token': failing.token } })).json()) as JobView;
        if (v.done) break;
        await new Promise((ok) => setTimeout(ok, 20));
      }
    } finally {
      await failing.close();
    }
    expect(setupRecord(store, storeKeyOf(other)).startedAt).toBeNull();
    // What the browser sends is checked first: the wrong scheme, an unknown provider, no URL.
    for (const [body, error] of [
      [{ provider: 'gcs', url: URL_ }, /A Google Cloud store starts with gs:\/\//],
      [{ provider: 'nfs', url: URL_ }, /provider is s3, gcs, azure or r2/],
      [{ provider: 's3', url: '' }, /url: the bucket and folder/],
      [{ provider: 's3', url: 's3://bucket?colour=blue' }, /unknown setting "colour"/],
    ] as const) {
      const refused = await post(dash, 'jobs', { kind: 'store-set', ...body });
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toMatch(error);
    }
    const ro1 = await post(ro, 'jobs', { kind: 'store-set', provider: 's3', url: URL_ });
    expect(ro1.status).toBe(403);
  });

  it('records Push from CI and the end of the setup for the store the config names', async () => {
    const none = await post(dash, 'store/setup', { ci: 'added' });
    expect(none.status).toBe(409);
    setConfig({ store: URL_ });
    for (const [body, error] of [
      [{ ci: 'maybe' }, /ci is added or skipped/],
      [{ ciProvider: 'jenkins' }, /ciProvider is github, gitlab or other/],
      [{ finished: 'yes' }, /finished is true/],
      [{ ci: 'added', ciPush: 'yes' }, /ciPush is true or false/],
      [{}, /say what was done/],
    ] as const) {
      const refused = await post(dash, 'store/setup', body);
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toMatch(error);
    }
    const added = await post(dash, 'store/setup', { ci: 'added', ciProvider: 'gitlab' });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { setup: unknown }).setup).toMatchObject({ ci: 'added', ciProvider: 'gitlab' });
    await post(dash, 'store/setup', { finished: true });
    const view = await get<StoreSetupView>(dash, 'store/setup');
    expect(view).toMatchObject({ active: false, setup: { ci: 'added', ciProvider: 'gitlab' } });
    expect(view.setup.finishedAt).toBeGreaterThan(0);
    expect((await post(ro, 'store/setup', { finished: true })).status).toBe(403);
  });

  it('turns Push from CI on or off with step 3 on GitHub, written to the config as Settings → Store’s switch writes it', async () => {
    setConfig({ store: URL_ });
    const config = () => JSON.parse(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
    // Skip for now: off, which the file then says.
    const skipped = await post(dash, 'store/setup', { ci: 'skipped', ciProvider: 'github', ciPush: false });
    expect(skipped.status).toBe(200);
    expect((await skipped.json())).toMatchObject({ setup: { ci: 'skipped', ciProvider: 'github' }, ciPush: { ciPush: false, previous: true, was: null, changed: true } });
    expect(config()).toEqual({ store: URL_, ciPush: false });
    // Turn on Push from CI: on, and the store's activity says so as the switch's does.
    const on = await post(dash, 'store/setup', { ci: 'added', ciProvider: 'github', ciPush: true });
    expect((await on.json())).toMatchObject({ setup: { ci: 'added' }, ciPush: { ciPush: true, previous: false, was: false, changed: true } });
    expect(config()).toEqual({ store: URL_, ciPush: true });
    expect(store.listEvents({ kinds: ['store.ci'] }).map((e) => (e.data as { push: boolean }).push)).toEqual([true, false]);
  });

  it('checks the store again with store check, which writes nothing and leaves a finished setup finished', async () => {
    setConfig({ store: URL_ });
    await post(dash, 'store/setup', { finished: true });
    const before = setupRecord(store, KEY);
    expect(before.finishedAt).toBeGreaterThan(0);
    const res = await post(dash, 'jobs', { kind: 'store-check' });
    expect(res.status, await res.clone().text()).toBe(202);
    const job = await finished((await res.json()) as JobView);
    expect(spawned.at(-1)).toEqual(['store', 'check']);
    expect(job).toMatchObject({ kind: 'store-check', title: 'Checking store', code: 0 });
    // Not store set --check: the setup isn't reopened.
    expect(setupRecord(store, KEY)).toMatchObject({ startedAt: before.startedAt, finishedAt: before.finishedAt });
    setConfig(null);
    const none = await post(dash, 'jobs', { kind: 'store-check' });
    expect(none.status).toBe(409);
    expect(await errorOf(none)).toMatch(/no team store yet/);
    expect((await post(ro, 'jobs', { kind: 'store-check' })).status).toBe(403);
  });
});
