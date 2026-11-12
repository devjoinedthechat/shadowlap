import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { editorCommand } from '../src/editor.js';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * Open in editor over HTTP (A18): a project file at a line, in the editor the server's environment
 * names, its file and line only ever arguments; refused for any path outside the project folder, on
 * a read-only dashboard and without the session token. Meta says beforehand whether it can, and how.
 */

let project: string;
let outside: string;
let store: Store;
let dash: Dashboard;
let spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>;
/** How the program the spawner starts ends as soon as it has started: an exit code, or still running. */
let ends: number | 'running';

/** A spawner that starts nothing: it records what it was asked, and says the program started, then ended as `ends` says. */
const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
  spawned.push({ cmd, args, opts });
  const child = Object.assign(new EventEmitter(), { unref: () => undefined });
  const code = ends;
  setImmediate(() => {
    child.emit('spawn');
    if (code !== 'running') child.emit('exit', code, null);
  });
  return child;
}) as unknown as typeof spawn;

const start = (o: { env?: NodeJS.ProcessEnv; readOnly?: boolean; project?: boolean; platform?: NodeJS.Platform } = {}) =>
  startDashboard({ store, readOnly: o.readOnly ?? false, ...(o.project === false ? {} : { project: { path: project } }), editor: { env: o.env ?? { EDITOR: 'code' }, platform: o.platform ?? 'darwin', spawn: fakeSpawn, settleMs: 30 } });

type Answer = { status: number; body: Record<string, unknown> };
async function api(d: Dashboard, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<Answer> {
  const res = await fetch(`${d.url}/api/${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.token === null ? {} : { 'x-shadowlap-token': init.token ?? d.token }), 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const open = (body: unknown, d: Dashboard = dash, token?: string | null) => api(d, 'editor/open', { method: 'POST', body, ...(token !== undefined ? { token } : {}) });

beforeEach(async () => {
  spawned = [];
  ends = 0;
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-editor-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'sl-editor-outside-')));
  mkdirSync(join(project, 'agent'));
  writeFileSync(join(project, 'agent', 'refund.py'), 'def refund():\n    pass\n');
  writeFileSync(join(outside, 'secret.txt'), 'not the project’s\n');
  symlinkSync(join(outside, 'secret.txt'), join(project, 'agent', 'away.txt'));
  store = Store.open(':memory:');
  dash = await start();
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('POST /api/editor/open', () => {
  it('opens a project file at a line, the line and the real path only as arguments', async () => {
    expect(await open({ file: 'agent/refund.py', line: 2 })).toEqual({ status: 200, body: { file: 'agent/refund.py', line: 2, editor: 'code' } });
    expect(spawned).toEqual([{ cmd: 'code', args: ['--goto', `${join(project, 'agent', 'refund.py')}:2`], opts: expect.objectContaining({ cwd: project, detached: true, stdio: 'ignore' }) }]);
    // Nothing else in the request is read: a command, arguments or an editor of its own change nothing.
    await open({ file: 'agent/refund.py', line: 2, cmd: 'rm -rf /', args: ['--evil'], editor: 'sh' });
    expect(spawned[1]).toEqual(spawned[0]);
  });

  it('refuses any path that is not a file inside the project folder', async () => {
    for (const file of ['../x', '/etc/passwd', 'agent/../../x', 'agent/refund.py\0x', '', 42]) expect((await open({ file, line: 1 })).status, String(file)).toBe(400);
    for (const file of ['agent/away.txt', 'agent', 'agent/gone.py']) expect((await open({ file, line: 1 })).status, file).toBe(404);
    for (const line of [0, 1.5, '12', -3, 20_000_000]) expect((await open({ file: 'agent/refund.py', line })).status, String(line)).toBe(400);
    expect(spawned).toEqual([]);
  });

  it('runs a value with arguments as git runs an editor, and gives any other editor +<line>', async () => {
    await dash.close();
    dash = await start({ env: { VISUAL: 'code --wait', EDITOR: 'vim' } });
    await open({ file: 'agent/refund.py', line: 7 });
    const real = join(project, 'agent', 'refund.py');
    expect(spawned[0]).toMatchObject({ cmd: 'sh', args: ['-c', 'code --wait "$@"', 'code --wait', '--goto', `${real}:7`] });
    await dash.close();
    dash = await start({ env: { EDITOR: 'gedit' } });
    await open({ file: 'agent/refund.py', line: 7 });
    expect(spawned[1]).toMatchObject({ cmd: 'gedit', args: ['+7', real] });
  });

  it('answers once the editor has started and not failed at once, and refuses one that fails as it starts with why', async () => {
    await dash.close();
    dash = await start({ env: { VISUAL: 'code --wait' } });
    // Still running once the watch ends: it opened the file, and holds it open.
    ends = 'running';
    expect((await open({ file: 'agent/refund.py', line: 2 })).status).toBe(200);
    // sh found no such program on the server's PATH.
    ends = 127;
    expect(await open({ file: 'agent/refund.py', line: 2 })).toEqual({ status: 409, body: { error: "code could not start: the dashboard's PATH has no code" } });
    ends = 2;
    expect(await open({ file: 'agent/refund.py', line: 2 })).toEqual({ status: 409, body: { error: 'code could not start: it exited 2' } });
  });

  it('is a write, behind the token, refused with why where no editor can open', async () => {
    expect((await open({ file: 'agent/refund.py', line: 1 }, dash, 'wrong')).status).toBe(401);
    await dash.close();
    dash = await start({ readOnly: true });
    expect((await open({ file: 'agent/refund.py', line: 1 })).status).toBe(403);
    await dash.close();
    dash = await start({ env: {} });
    expect(await open({ file: 'agent/refund.py', line: 1 })).toMatchObject({ status: 409, body: { error: expect.stringContaining('$VISUAL or $EDITOR') } });
    expect(spawned).toEqual([]);
  });
});

describe('the editor in meta', () => {
  const meta = async (o: Parameters<typeof start>[0]) => {
    await dash.close();
    dash = await start(o);
    return (await api(dash, 'meta')).body.editor;
  };

  it('says what it runs here, read-only too, and is null where this machine can open none', async () => {
    expect((await api(dash, 'meta')).body.editor).toBe('code --goto <file>:<line>');
    // A read-only dashboard draws the button off, with its reason.
    expect(await meta({ readOnly: true })).toBe('code --goto <file>:<line>');
    expect(await meta({ env: {} })).toBeNull();
    expect(await meta({ env: { EDITOR: 'vim' } })).toBeNull();
    expect(await meta({ project: false })).toBeNull();
    expect(await meta({ env: { EDITOR: 'code' }, platform: 'linux' })).toBeNull();
    expect(await meta({ env: { EDITOR: 'code', WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })).toBe('code --goto <file>:<line>');
  });

  it('names a terminal-only editor, an unset one and a missing display as the reasons', () => {
    expect(editorCommand({ env: { EDITOR: '/usr/bin/nvim' }, platform: 'darwin' })).toEqual({ off: expect.stringContaining('nvim runs in a terminal') });
    expect(editorCommand({ env: { VISUAL: '"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" -n' }, platform: 'darwin' })).toMatchObject({ name: 'subl', shell: true, form: '"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" -n <file>:<line>' });
    expect(editorCommand({ env: { EDITOR: 'code' }, platform: 'win32' })).toEqual({ off: expect.stringContaining("can't be started here") });
  });
});
