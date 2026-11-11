import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent, Store } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard } from '../src/index.js';

/**
 * Settings → Tools' Mark untrusted and Mark trusted: `PUT /api/settings/tools/trust` writes one
 * tool's `tools.<name>.trust` against the version the page read, answers what the file held before
 * (`was`) and the line, and lands in the activity feed; its Undo puts `was` back against the version
 * the mark wrote, null taking the key out, and is refused once anything else changed the file.
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

let project: string;
let store: Store;
let dash: Dashboard;
const env = { ...process.env };

beforeAll(() => {
  process.env.SHADOWLAP_HOME = mkdtempSync(join(tmpdir(), 'sl-trust-home-'));
  process.env.SHADOWLAP_AUTHOR = 'dana@example.com';
});
afterAll(() => {
  rmSync(process.env.SHADOWLAP_HOME!, { recursive: true, force: true });
  process.env = env;
});
beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-trust-routes-')));
  mkdirSync(join(project, '.shadowlap'));
  const dbPath = join(project, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
  // A dashboard that runs commands is one that writes: a read-only one refuses every edit.
  dash = await startDashboard({ store, dbPath, spawnCli: cliSpawner({ command: [process.execPath, FAKE], dbPath, cwd: project }), project: { path: project } });
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' } });
const mark = (body: Record<string, unknown>) => api('settings/tools/trust', { method: 'PUT', body: JSON.stringify(body) });
const config = () => JSON.parse(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
const version = async () => ((await (await api('settings/matching')).json()) as { config: { version: string } }).config.version;
const write = (data: unknown) => writeFileSync(join(project, 'shadowlap.config.json'), `${JSON.stringify(data, null, 2)}\n`);
const feed = async () => ((await (await api('activity')).json()) as { items: Array<{ text: string; href?: string }> }).items;

describe('PUT /api/settings/tools/trust', () => {
  it('marks a tool untrusted, keeping the rest of the file, and answers the line and what it held before', async () => {
    write({ tools: { unrecorded: { effect: 'read' }, search: { trust: 'trusted' } }, clock: 'exact' });
    const res = await mark({ tool: 'get_ticket', trust: 'untrusted', expect: await version() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ tool: 'get_ticket', trust: 'untrusted', was: null, changed: true, line: '"tools": { "get_ticket": { "trust": "untrusted" } }' });
    expect(body.version).toBe(await version());
    expect(config()).toEqual({ tools: { unrecorded: { effect: 'read' }, search: { trust: 'trusted' }, get_ticket: { trust: 'untrusted' } }, clock: 'exact' });
    expect((await feed()).find((i) => i.text.startsWith('Tool marked'))).toMatchObject({ text: 'Tool marked untrusted · get_ticket', href: '#/settings/tools' });
  });

  it('undoes a mark against the version it wrote: was back, or the key out, and tools with it when empty', async () => {
    const first = (await (await mark({ tool: 'fetch_page', trust: 'untrusted', expect: await version() })).json()) as { version: string; was: null };
    expect(config()).toEqual({ tools: { fetch_page: { trust: 'untrusted' } } });
    const undo = (await (await mark({ tool: 'fetch_page', trust: first.was, expect: first.version })).json()) as Record<string, unknown>;
    expect(undo).toMatchObject({ trust: null, was: 'untrusted', changed: true, line: '"tools": { "fetch_page": { "trust": "untrusted" } }' });
    expect(config()).toEqual({});
    expect((await feed()).map((i) => i.text)).toContain('Tool mark removed · fetch_page');
    // Marked trusted over an SDK's untrusted: the line is written, never the key taken out.
    const trusted = (await (await mark({ tool: 'fetch_page', trust: 'trusted', expect: await version() })).json()) as { version: string };
    expect(config()).toEqual({ tools: { fetch_page: { trust: 'trusted' } } });
    expect(trusted.version).toBe(await version());
  });

  it('refuses a page’s old version, and an Undo once anything else changed the file', async () => {
    const v = await version();
    const marked = (await (await mark({ tool: 'fetch_page', trust: 'untrusted', expect: v })).json()) as { version: string };
    const stale = await mark({ tool: 'get_ticket', trust: 'untrusted', expect: v });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(/changed since it was read/);
    write({ tools: { fetch_page: { trust: 'untrusted' } }, clock: 'auto' });
    expect((await mark({ tool: 'fetch_page', trust: null, expect: marked.version })).status).toBe(409);
    expect(config()).toEqual({ tools: { fetch_page: { trust: 'untrusted' } }, clock: 'auto' });
  });

  it('refuses a bad name, tools.unrecorded, a bad trust, and a file whose tools a recording would refuse, in its words', async () => {
    const v = await version();
    const error = async (body: Record<string, unknown>) => {
      const res = await mark(body);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await error({ tool: '', trust: 'untrusted', expect: v })).toMatch(/^tool is the tool's name/);
    expect(await error({ tool: 'x'.repeat(201), trust: 'untrusted', expect: v })).toMatch(/at most 200 characters/);
    expect(await error({ tool: 'unrecorded', trust: 'untrusted', expect: v })).toMatch(/^tools.unrecorded declares/);
    expect(await error({ tool: 'a', trust: 'maybe', expect: v })).toBe('trust is "trusted", "untrusted" or null (no mark)');
    expect(await error({ tool: 'a', trust: 'trusted', expect: 'x' })).toMatch(/^expect is the version/);
    write({ tools: { search: { trust: 'sometimes' } } });
    expect(await error({ tool: 'a', trust: 'trusted', expect: await version() })).toBe('shadowlap.config.json: tools["search"].trust must be "trusted" or "untrusted"');
    expect(config()).toEqual({ tools: { search: { trust: 'sometimes' } } });
  });

  it('words a gate Pack with injection gate… wrote apart from a check, in the feed beside the marks', async () => {
    recordEvent(store, { kind: 'checks.changed', ref: 'goldens/refund', actor: 'dana@example.com', data: { key: 'goldens/refund', added: [], removed: [], gate: { obeyed: 0, repeat: 3 } } });
    expect((await feed()).find((i) => i.text.startsWith('Injection gate'))).toMatchObject({ text: 'Injection gate added · refund', href: '#/tests' });
  });

  it('takes a tool named as Object’s own keys as any other name', async () => {
    await mark({ tool: '__proto__', trust: 'untrusted', expect: await version() });
    expect(Object.keys(config().tools as object)).toEqual(['__proto__']);
  });
});
