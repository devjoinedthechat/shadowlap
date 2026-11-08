import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, SPRT_DEFAULTS, Store } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type CiWorkflowsView, type Dashboard, type GoldenSource } from '../src/index.js';
import { ciGates } from '../src/tests-gate.js';

/** Settings → CI's Write file and its Undo, against a project folder that is its repository's root. */

const FAKE = fileURLToPath(new URL('./fake-settings-cli.mjs', import.meta.url));

let project: string;
let store: Store;
let dash: Dashboard;
const env = { ...process.env };

beforeAll(() => {
  process.env.SHADOWLAP_HOME = mkdtempSync(join(tmpdir(), 'sl-ci-home-'));
  process.env.SHADOWLAP_AUTHOR = 'dana@example.com';
});
afterAll(() => {
  rmSync(process.env.SHADOWLAP_HOME!, { recursive: true, force: true });
  process.env = env;
});

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-ci-routes-')));
  mkdirSync(join(project, '.git'));
  writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(project, '.shadowlap'));
  const dbPath = join(project, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
  dash = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project }), project: { path: project } });
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}, d: Dashboard = dash) =>
  fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const send = (method: string, path: string, body: unknown, d?: Dashboard) => api(path, { method, body: JSON.stringify(body) }, d);
const view = async (query = ''): Promise<CiWorkflowsView> => {
  const res = await api(`ci/workflows${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as CiWorkflowsView;
};
const file = () => join(project, '.github', 'workflows', 'agent.yml');

describe('Write file', () => {
  it('writes the file the page showed, reads the same after, and its Undo removes the file it made', async () => {
    const before = await view('?fix=on');
    expect(before).toMatchObject({ file: '.github/workflows/agent.yml', exists: false, version: 'absent', problem: null });
    expect(before.workflow.same).toBe(false);
    const res = await send('PUT', 'ci/workflow', { options: { fix: true }, expect: before.version, shown: before.workflow.shown });
    expect(res.status, await res.clone().text()).toBe(200);
    const wrote = (await res.json()) as { path: string; version: string; was: string };
    expect(readFileSync(file(), 'utf8')).toBe(before.workflow.text);
    // The switches now start from the file: fix on without asking, and nothing to write.
    const after = await view();
    expect(after).toMatchObject({ exists: true, version: wrote.version });
    expect(after.fixOnFailure.on).toBe(true);
    expect(after.workflow.same).toBe(true);
    expect(store.listEvents({ kinds: ['ci.workflow'] })[0]).toMatchObject({ ref: '.github/workflows/agent.yml' });
    const undo = await send('POST', 'ci/workflow/undo', { was: wrote.was, expect: wrote.version });
    expect(undo.status, await undo.clone().text()).toBe(200);
    expect(await undo.json()).toMatchObject({ removed: true, version: 'absent' });
    expect(existsSync(file())).toBe(false);
    // Once used, it is gone.
    expect((await send('POST', 'ci/workflow/undo', { was: wrote.was, expect: 'absent' })).status).toBe(409);
  });

  it('refuses a file changed since it was read, a file the page never saw, and a project that isn’t its repository’s root', async () => {
    const shown = await view();
    mkdirSync(join(project, '.github', 'workflows'), { recursive: true });
    writeFileSync(file(), 'name: mine\n');
    const stale = await send('PUT', 'ci/workflow', { options: {}, expect: shown.version, shown: shown.workflow.shown });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe('.github/workflows/agent.yml changed since it was read');
    expect(readFileSync(file(), 'utf8')).toBe('name: mine\n');
    // A file with no action step can't be patched line by line: Copy only, saying why.
    const mine = await view();
    expect(mine.problem).toBe('.github/workflows/agent.yml has no step that uses the Shadowlap action. Write file leaves it as it is: copy the workflow and change the file yourself.');
    expect((await send('PUT', 'ci/workflow', { options: {}, expect: mine.version, shown: mine.workflow.shown })).status).toBe(422);
    rmSync(file());
    const now = await view();
    const unseen = await send('PUT', 'ci/workflow', { options: { fix: true }, expect: now.version, shown: now.workflow.shown });
    expect(unseen.status).toBe(409);
    expect(((await unseen.json()) as { error: string }).error).not.toMatch(/changed since it was read/);
    expect(existsSync(file())).toBe(false);
    rmSync(join(project, '.git'), { recursive: true });
    expect((await view()).problem).toBe('Write file writes only at a repository’s root, where GitHub reads .github/workflows/, and this project folder isn’t one.');
  });

  it('keeps the repository’s own lines and changes only what a switch owns', async () => {
    const first = await view();
    expect((await send('PUT', 'ci/workflow', { options: {}, expect: first.version, shown: first.workflow.shown })).status).toBe(200);
    writeFileSync(file(), readFileSync(file(), 'utf8').replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    timeout-minutes: 30 # ours\n'));
    const off = await view('?comment=off');
    expect(off.workflow.lines.filter((l) => l.op !== ' ')).toEqual([
      { op: '-', text: '  pull-requests: write' },
      { op: '+', text: '          comment: false' },
    ]);
    expect((await send('PUT', 'ci/workflow', { options: { comment: false }, expect: off.version, shown: off.workflow.shown })).status).toBe(200);
    expect(readFileSync(file(), 'utf8')).toContain('    timeout-minutes: 30 # ours\n');
    expect((await view()).comment.on).toBe(false);
  });
});

describe('Gates in the CI view', () => {
  const golden = (path: string, gate: GoldenSource['gate'], error: string | null = null): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'fork', repeat: 1, passes: 1, gate, checks: [], error });

  it('sends the config’s suite risk with the figures, and names the goldens each kind’s defaults stand for', async () => {
    expect((await view()).gates).toEqual({ suiteRisk: 0.05, uses: { sprt: [], baseline: [] } });
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { suiteRisk: 0.1 } }));
    const list = [golden('goldens/refund', { kind: 'sprt', ...SPRT_DEFAULTS }), golden('goldens/slow', { kind: 'sprt', ...SPRT_DEFAULTS, max: 40 }), golden('goldens/order', { kind: 'baseline', ...BASELINE_DEFAULTS }), golden('goldens/broken', { kind: 'sprt', ...SPRT_DEFAULTS }, 'run.json is missing'), golden('goldens/plain', null)];
    expect(ciGates(project, list, 'goldens')).toEqual({ suiteRisk: 0.1, uses: { sprt: ['refund'], baseline: ['order'] } });
    // A config that can't be read, or a suite risk it refuses, leaves the default: every session refuses the file meanwhile.
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { suiteRisk: 0.7 } }));
    expect(ciGates(project, [], 'goldens').suiteRisk).toBe(0.05);
    writeFileSync(join(project, 'shadowlap.config.json'), '{ not json');
    expect(ciGates(project, [], 'goldens').suiteRisk).toBe(0.05);
  });
});
