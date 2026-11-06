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

  it('is refused once the file changed since the removal, in the rule’s words for one that isn’t, and for a list or number that isn’t one', async () => {
    const added = await send<{ version: string }>('POST', 'settings/rules/redact', { rule: { pattern: 'email', replace: '<EMAIL>' }, expect: await version() });
    const removed = await send<{ n: number; rule: unknown; version: string }>('DELETE', `settings/rules/redact/1?expect=${added.version}`, undefined);
    await send('POST', 'settings/rules/redact', { rule: { pattern: 'uuid', replace: '<ID>' }, expect: removed.version });
    expect((await send<{ error: string }>('POST', 'settings/rules/redact/1/restore', { rule: removed.rule, expect: removed.version }, 409)).error).toMatch(/changed since it was read/);
    expect((await send<{ error: string }>('POST', 'settings/rules/redact/1/restore', { rule: { replace: '<X>' }, expect: await version() }, 400)).error).toMatch(/give a path, a pattern or both/);
    await send('POST', 'settings/rules/everything/1/restore', { rule: removed.rule, expect: await version() }, 404);
    await send('POST', 'settings/rules/redact/0/restore', { rule: removed.rule, expect: await version() }, 400);
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
