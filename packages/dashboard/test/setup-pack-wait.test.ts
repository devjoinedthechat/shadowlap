import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, Store, projectDbPath, type SetupFindings } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard, type ProjectConfig } from '../src/index.js';

/**
 * The setup's Pack refuses while it waits, as its button does: while a write tool isn't wrapped, a
 * replay of the golden would run it for real, and once it is wrapped, the recording made before
 * doesn't hold its calls. So a stale page or a second tab can't pack (`packWait`, pack-test.ts).
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

let open: Array<{ dash: Dashboard; host: ProjectHost<ProjectConfig> }> = [];
afterEach(async () => {
  for (const o of open) {
    await o.dash.close();
    o.host.close();
  }
  open = [];
});

const tool = (name: string, effect: 'read' | 'write', wrapped: boolean) => ({ name, effect, wrapped, why: wrapped ? 'declared' : 'leading verb', file: 'agent.py', line: 9 });
const findings = (tools: SetupFindings['tools'], at = Date.now()): SetupFindings => ({
  at,
  language: 'Python 3.12 · uv',
  files: ['pyproject.toml'],
  sdk: 'anthropic 0.69.0',
  framework: null,
  command: ['uv', 'run', 'agent.py'],
  commandFrom: 'the entry file agent.py',
  config: { file: 'shadowlap.config.json', created: true, existed: false },
  tools,
  wrap: [],
});

/** The research agent, inspected with `tools` before its one recording, on a dashboard whose CLI exits at once. */
async function world(tools: SetupFindings['tools']) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-pack-wait-')));
  dirs.push(home);
  const research = join(home, 'research-agent');
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: join(home, '.sl') }, actor: () => null });
  const store = Store.open(projectDbPath(research));
  writeFileSync(join(research, 'pyproject.toml'), '');
  const host = ProjectHost.open<ProjectConfig>(research, { registry, loadConfig: () => ({ normalize: [], redact: [] }) });
  registry.noteInspected('research-agent', findings(tools, Date.now() - 1000));
  const run = store.createRun({ mode: 'record', command: { argv: ['uv', 'run', 'agent.py'], cwd: research } });
  store.appendCallStart({ runId: run.runId, callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'f1', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
  store.endRun(run.runId, 'completed');
  store.close();
  const dash = await startDashboard({ projects: host, spawnCli: cliSpawner({ command: [process.execPath, '-e', ''], cwd: research }), version: '0.1.0', routes: [] });
  open.push({ dash, host });
  const api = async <T,>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${dash.url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { registry, api, pack: () => api<{ error?: string; id?: string }>('jobs', { kind: 'pack-test', golden: 'goldens/research-agent', project: 'research-agent' }) };
}

describe('the setup’s Pack while it waits', () => {
  it('is refused while a write tool isn’t wrapped, in the words the page shows', async () => {
    const w = await world([tool('lookup', 'read', true), tool('save_report', 'write', false)]);
    const shown = await w.api<{ wait: { text: string } | null }>('setup');
    expect(shown.body.wait?.text).toBe('Packing waits until save_report is wrapped: a replay of this golden would run it for real.');
    expect(await w.pack()).toEqual({ status: 409, body: { error: shown.body.wait!.text } });
  });

  it('is refused once it is wrapped, until a recording made since', async () => {
    const w = await world([tool('save_report', 'write', false)]);
    w.registry.noteInspected('research-agent', findings([tool('save_report', 'write', true)]));
    expect(await w.pack()).toEqual({ status: 409, body: { error: 'Packing waits for a recording made since save_report was wrapped: this one doesn’t hold its calls.' } });
  });

  it('never waits for tools that only read', async () => {
    const w = await world([tool('lookup', 'read', false)]);
    expect((await w.api<{ wait: unknown }>('setup')).body.wait).toBeNull();
    const started = await w.pack();
    expect(started.status).toBe(202);
    for (let i = 0; i < 200 && !(await w.api<{ done: boolean }>(`jobs/${started.body.id}`)).body.done; i++) await new Promise((r) => setTimeout(r, 25));
  });
});
