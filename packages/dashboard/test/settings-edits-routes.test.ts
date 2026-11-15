import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard } from '../src/index.js';

/**
 * The Undo of Settings' edits over HTTP: a removed rule goes back at its number from what the
 * removal answered, and the clock and Push from CI say what they replaced and take their key out
 * again with null, each against the version the edit wrote, so the file is byte for byte what it was.
 */

/** A stand-in CLI: these edits run no command, but a dashboard without one is read-only. */
const FAKE = fileURLToPath(new URL('./fake-settings-cli.mjs', import.meta.url));

let project: string;
let store: Store;
let dash: Dashboard;
const env = { ...process.env };

beforeAll(() => {
  process.env.SHADOWLAP_HOME = mkdtempSync(join(tmpdir(), 'sl-settings-undo-home-'));
  process.env.SHADOWLAP_AUTHOR = 'dana@example.com';
});
afterAll(() => {
  rmSync(process.env.SHADOWLAP_HOME!, { recursive: true, force: true });
  process.env = env;
});

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-settings-undo-')));
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

const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const send = async <T = Record<string, unknown>>(method: string, path: string, body: unknown, status = 200): Promise<T> => {
  const res = await api(path, { method, body: JSON.stringify(body) });
  const out = (await res.json()) as T;
  expect(res.status, `${method} ${path}: ${JSON.stringify(out)}`).toBe(status);
  return out;
};
const file = () => readFileSync(join(project, 'shadowlap.config.json'), 'utf8');
const version = async () => ((await (await api('settings/matching')).json()) as { config: { version: string } }).config.version;

describe('Undo of a removed rule', () => {
  it('puts it back at its number from what the removal answered, the file as it was', async () => {
    let v = await version();
    for (const rule of [{ path: '$.id', pattern: 'uuid' }, { kind: 'tool', name: 'send_email', path: '$.to', pattern: 'email' }, { pattern: 'iso-date', replace: '<DATE>' }]) {
      v = (await send<{ version: string }>('POST', 'settings/rules/normalize', { rule, expect: v })).version;
    }
    const before = file();
    const removed = await send<{ n: number; rule: unknown; version: string }>('DELETE', `settings/rules/normalize/2?expect=${v}`, undefined);
    expect(removed.rule).toEqual({ kind: 'tool', name: 'send_email', path: '$.to', pattern: 'email', replace: '<MASKED>' });
    const back = await send<{ n: number; version: string }>('POST', `settings/rules/normalize/${removed.n}/restore`, { rule: removed.rule, expect: removed.version });
    expect(back).toEqual({ list: 'normalize', n: 2, version: v });
    expect(file()).toBe(before);
    expect(store.listEvents().map((e) => [e.kind, e.ref])).toContainEqual(['normalizer.added', '$.to']);
  });

  it('puts back a rule written into the file by hand that adding would refuse', async () => {
    // It loads with no error, so Settings offers Undo on its Remove: the file holds it as it held it.
    writeFileSync(join(project, 'shadowlap.config.json'), `${JSON.stringify({ normalize: [{ path: '$.a', pattern: '/x*/', replace: '<X>' }, { path: '$', replace: '<ANY>' }] }, null, 2)}\n`);
    const before = file();
    const removed = await send<{ n: number; rule: unknown; version: string }>('DELETE', `settings/rules/normalize/1?expect=${await version()}`, undefined);
    expect((await send<{ error: string }>('POST', 'settings/rules/normalize', { rule: removed.rule, expect: removed.version }, 400)).error).toMatch(/matches an empty string/);
    await send('POST', `settings/rules/normalize/${removed.n}/restore`, { rule: removed.rule, expect: removed.version });
    expect(file()).toBe(before);
  });

  it('is refused once the file changed since the removal, in the rule’s words for one the file couldn’t hold, and for a list or number that isn’t one', async () => {
    const added = await send<{ version: string }>('POST', 'settings/rules/redact', { rule: { pattern: 'email', replace: '<EMAIL>' }, expect: await version() });
    const removed = await send<{ n: number; rule: unknown; version: string }>('DELETE', `settings/rules/redact/1?expect=${added.version}`, undefined);
    await send('POST', 'settings/rules/redact', { rule: { pattern: 'uuid', replace: '<ID>' }, expect: removed.version });
    expect((await send<{ error: string }>('POST', 'settings/rules/redact/1/restore', { rule: removed.rule, expect: removed.version }, 409)).error).toMatch(/changed since it was read/);
    expect((await send<{ error: string }>('POST', 'settings/rules/redact/1/restore', { rule: { pattern: 'email' }, expect: await version() }, 400)).error).toMatch(/replace must be text/);
    await send('POST', 'settings/rules/everything/1/restore', { rule: removed.rule, expect: await version() }, 404);
    await send('POST', 'settings/rules/redact/0/restore', { rule: removed.rule, expect: await version() }, 400);
  });

  it('needs the session token, as every route does', async () => {
    const added = await send<{ version: string }>('POST', 'settings/rules/redact', { rule: { pattern: 'email', replace: '<EMAIL>' }, expect: await version() });
    const removed = await send<{ n: number; rule: unknown; version: string }>('DELETE', `settings/rules/redact/1?expect=${added.version}`, undefined);
    const after = file();
    for (const token of [null, 'wrong']) {
      const res = await fetch(`${dash.url}/api/settings/rules/redact/1/restore`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-shadowlap-token': token } : {}) }, body: JSON.stringify({ rule: removed.rule, expect: removed.version }) });
      expect(res.status, `token ${token}`).toBe(401);
    }
    expect(file()).toBe(after);
  });
});

describe('Undo of the clock and Push from CI', () => {
  it('answers what the clock replaced, and takes the key out with null', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), `${JSON.stringify({ store: 's3://b/f' }, null, 2)}\n`);
    const before = file();
    const set = await send<{ clock: string; was: string | null; version: string }>('PUT', 'settings/clock', { mode: 'exact', expect: await version() });
    expect([set.clock, set.was]).toEqual(['exact', null]);
    const back = await send<{ clock: string; was: string | null }>('PUT', 'settings/clock', { mode: set.was, expect: set.version });
    expect([back.clock, back.was]).toEqual(['auto', 'exact']);
    expect(file()).toBe(before);
  });

  it('answers what Push from CI replaced, the file’s own value or null, and takes the key out with null', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), `${JSON.stringify({ store: 's3://b/f' }, null, 2)}\n`);
    const before = file();
    const off = await send<{ ciPush: boolean; previous: boolean; was: boolean | null; version: string }>('PUT', 'settings/store/ci-push', { on: false, expect: await version() });
    expect([off.ciPush, off.previous, off.was]).toEqual([false, true, null]);
    const back = await send<{ ciPush: boolean; previous: boolean; was: boolean | null }>('PUT', 'settings/store/ci-push', { on: off.was, expect: off.version });
    expect([back.ciPush, back.previous, back.was]).toEqual([true, false, false]);
    expect(file()).toBe(before);
    // Each write is in Activity, as the CLI's is: off, then on again.
    expect(store.listEvents().map((e) => [e.kind, e.data])).toEqual([
      ['store.ci', { push: true, previous: false }],
      ['store.ci', { push: false, previous: true }],
    ]);
    await send('PUT', 'settings/store/ci-push', { on: 'yes', expect: await version() }, 400);
  });
});

describe('Build, on Settings → Project', () => {
  const feed = async () => ((await (await api('activity')).json()) as { items: Array<{ text: string; href?: string }> }).items;
  const read = async () => (await (await api('settings/build')).json()) as { build: string | null; problem: string | null; config: { version: string } };

  it('reads the command that builds the agent, writes it against the version read, and takes the key out again with null', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), `${JSON.stringify({ store: 's3://b/f' }, null, 2)}\n`);
    const before = file();
    const none = await read();
    expect([none.build, none.problem]).toEqual([null, null]);
    const set = await send<{ build: string | null; was: string | null; changed: boolean; version: string }>('PUT', 'settings/build', { command: ' npm run build ', expect: none.config.version });
    expect([set.build, set.was, set.changed]).toEqual(['npm run build', null, true]);
    expect(JSON.parse(file())).toEqual({ store: 's3://b/f', build: 'npm run build' });
    expect((await read()).build).toBe('npm run build');
    // A page that read the file before is refused, and nothing changes.
    await send('PUT', 'settings/build', { command: 'make', expect: none.config.version }, 409);
    // Its Undo: null against the version the write left, the file as it was.
    const back = await send<{ build: string | null; was: string | null }>('PUT', 'settings/build', { command: set.was, expect: set.version });
    expect([back.build, back.was]).toEqual([null, 'npm run build']);
    expect(file()).toBe(before);
    expect((await feed()).filter((i) => i.text.startsWith('Build')).map((i) => [i.text, i.href])).toEqual([
      ['Build removed', '#/settings/project'],
      ['Build set · npm run build', '#/settings/project'],
    ]);
  });

  it('refuses what is no command on one line, in the CLI’s words, an empty one taking the key out, and says why a file’s build can’t run', async () => {
    const words = 'build must be the command that builds the agent, on one line, such as "npm run build"';
    for (const command of ['npm run build\nrm -rf ~', 'x'.repeat(1001)]) expect(await send<{ error: string }>('PUT', 'settings/build', { command, expect: (await read()).config.version }, 400)).toMatchObject({ error: words });
    await send('PUT', 'settings/build', { command: ['npm', 'run', 'build'], expect: (await read()).config.version }, 400);
    const set = await send<{ version: string }>('PUT', 'settings/build', { command: 'make', expect: (await read()).config.version });
    expect(await send('PUT', 'settings/build', { command: '  ', expect: set.version })).toMatchObject({ build: null, was: 'make' });
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ build: 7 }));
    expect(await read()).toMatchObject({ build: null, problem: `shadowlap.config.json: ${words}` });
  });
});
