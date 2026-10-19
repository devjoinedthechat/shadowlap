import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { departures } from './json-shapes.js';

/**
 * `shadowlap skill install`: the coding agents' plugin and rule, put into the project from the copy
 * that comes with the CLI, as a person runs it and as Settings → Coding agents runs it, through the
 * `skill-install` job. The real commands, so the result the job carries is the one the CLI prints.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }).version;
const SKILL = '.claude/skills/shadowlap/skills/debug-agent/SKILL.md';
const RULE = '.cursor/rules/shadowlap.mdc';

const dirs: string[] = [];
const scratch = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `sl-skill-cli-${name}-`)));
  dirs.push(dir);
  return dir;
};
let claudeHome: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  claudeHome = scratch('claude-home');
  env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_AUTHOR: 'dana@example.com', SHADOWLAP_HOME: scratch('home'), CLAUDE_CONFIG_DIR: claudeHome };
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shadowlap(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
const held = (value: { files: unknown[] }) => {
  const problems = departures('skillInstall', value);
  for (const f of value.files) {
    const d = departures('skillInstallFile', f);
    problems.missing.push(...d.missing);
    problems.extra.push(...d.extra);
  }
  return problems;
};

describe('shadowlap skill install', () => {
  it('puts the plugin into the project, leaves it when current, and refuses an edited copy without --force', async () => {
    const cwd = scratch('project');
    const first = await shadowlap(cwd, ['skill', 'install']);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain(`✓ Installed the Claude Code plugin, ${VERSION}, in .claude/skills/shadowlap`);
    expect(first.stdout).toContain('/shadowlap:debug-agent');
    expect(readFileSync(join(cwd, SKILL), 'utf8')).toBe(readFileSync(join(ROOT, 'coding-agents/claude-code/skills/debug-agent/SKILL.md'), 'utf8'));
    // Installing makes no store where there was none.
    expect(existsSync(join(cwd, '.shadowlap'))).toBe(false);

    const again = await shadowlap(cwd, ['skill', 'install', 'claude-code', '--json']);
    expect(again.code).toBe(0);
    const unchanged = JSON.parse(again.stdout) as { outcome: string; before: string; files: unknown[] };
    expect(held(unchanged)).toEqual({ missing: [], extra: [] });
    expect(unchanged).toMatchObject({ before: 'current', outcome: 'unchanged' });

    writeFileSync(join(cwd, SKILL), 'ours now');
    const refused = await shadowlap(cwd, ['skill', 'install', '--json']);
    expect(refused.code).toBe(1);
    const report = JSON.parse(refused.stdout) as { outcome: string; reason: string; files: unknown[] };
    expect(held(report)).toEqual({ missing: [], extra: [] });
    expect(report).toMatchObject({ outcome: 'refused', files: [{ path: SKILL, action: 'differs' }] });
    expect(report.reason).toMatch(/--force replaces it/);
    expect(readFileSync(join(cwd, SKILL), 'utf8')).toBe('ours now');
    const human = await shadowlap(cwd, ['skill', 'install']);
    expect(human.code).toBe(1);
    expect(human.stdout).toMatch(/^✗ Nothing was changed: .claude\/skills\/shadowlap isn’t .*’s copy of the plugin/);
    expect(human.stdout).toContain(`    ${SKILL}  differs`);

    const forced = await shadowlap(cwd, ['skill', 'install', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain(`✓ Updated the Claude Code plugin in .claude/skills/shadowlap to ${VERSION} (1 replaced)`);
  });

  it('puts the Cursor rule into .cursor/rules, and records the install where the project has a store', async () => {
    const cwd = scratch('cursor');
    mkdirSync(join(cwd, '.shadowlap'));
    Store.open(join(cwd, '.shadowlap', 'shadowlap.db')).close();
    const added = await shadowlap(cwd, ['skill', 'install', 'cursor']);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain(`✓ Installed the Cursor rule, ${VERSION}, in ${RULE}`);
    expect(readFileSync(join(cwd, RULE), 'utf8')).toBe(readFileSync(join(ROOT, 'coding-agents/cursor/shadowlap.mdc'), 'utf8'));
    // Nothing done, nothing recorded.
    expect((await shadowlap(cwd, ['skill', 'install', 'cursor'])).code).toBe(0);
    const store = Store.open(join(cwd, '.shadowlap', 'shadowlap.db'));
    try {
      expect(store.listEvents().map((e) => ({ kind: e.kind, ref: e.ref, actor: e.actor, data: e.data }))).toEqual([
        { kind: 'skill.installed', ref: 'cursor', actor: 'dana@example.com', data: { path: RULE, version: VERSION, outcome: 'installed', previous: null } },
      ]);
    } finally {
      store.close();
    }
  });

  it('refuses an agent it has nothing for', async () => {
    const r = await shadowlap(scratch('codex'), ['skill', 'install', 'codex']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Allowed choices are claude-code, cursor/);
  });
});

describe('Settings → Coding agents, from shadowlap dashboard', () => {
  let cwd: string;
  let dash: { child: ChildProcess; url: string; token: string };
  interface Job {
    id: string;
    done: boolean;
    code: number | null;
    lines: string[];
    result: Record<string, unknown> | null;
  }
  const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' } });
  async function run(body: unknown): Promise<Job> {
    const res = await api('jobs', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(202);
    let job = (await res.json()) as Job;
    for (let i = 0; i < 600 && !job.done; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await (await api(`jobs/${job.id}`)).json()) as Job;
    }
    expect(job.done, job.lines.join('\n')).toBe(true);
    return job;
  }
  const agents = async () => ((await (await api('settings/agents')).json()) as { skill: { claudeCode: Record<string, unknown>; cursor: Record<string, unknown> } }).skill;

  beforeAll(async () => {
    cwd = scratch('dashboard');
    mkdirSync(join(cwd, '.shadowlap'));
    Store.open(join(cwd, '.shadowlap', 'shadowlap.db')).close();
    const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '--port', String(40_000 + Math.floor(Math.random() * 20_000))], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    dash = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no link printed: ${out}`)), 20_000);
      const on = (c: Buffer) => {
        out += c.toString();
        const m = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/.exec(out);
        if (!m) return;
        clearTimeout(timer);
        resolve({ child, url: m[1]!, token: m[2]! });
      };
      child.stdout.on('data', on);
      child.stderr.on('data', on);
    });
  }, 30_000);
  afterAll(async () => {
    dash.child.kill('SIGINT');
    await new Promise((r) => dash.child.once('exit', r));
  });
  it('runs the install the tab offers, and then reads it as current', async () => {
    const before = await agents();
    expect(before.cursor).toMatchObject({ state: 'missing', install: { job: { kind: 'skill-install', agent: 'cursor', replace: false } } });
    const job = await run((before.cursor.install as { job: unknown }).job);
    expect(job.code, job.lines.join('\n')).toBe(0);
    expect(job.result).toMatchObject({ agent: 'cursor', path: RULE, outcome: 'installed', version: VERSION });
    expect(existsSync(join(cwd, RULE))).toBe(true);
    expect((await agents()).cursor).toMatchObject({ state: 'current', install: null });

    // The plugin, as the job a published Install the skill starts.
    const plugin = await run({ kind: 'skill-install', agent: 'claude-code' });
    expect(plugin.code).toBe(0);
    expect(plugin.result).toMatchObject({ agent: 'claude-code', outcome: 'installed' });
    expect((await agents()).claudeCode).toMatchObject({ state: 'current', installedVersion: VERSION, install: null, marketplace: null });

    // An edit, then Replace: the job with replace runs it with --force.
    writeFileSync(join(cwd, RULE), 'edited');
    const offered = (await agents()).cursor as { state: string; install: { job: Record<string, unknown> } };
    expect(offered.state).toBe('changed');
    const replaced = await run(offered.install.job);
    expect(replaced.result).toMatchObject({ before: 'changed', outcome: 'updated', files: [{ path: RULE, action: 'replaced' }] });

    // And the activity feed says so.
    const feed = JSON.stringify(await (await api('activity')).json());
    expect(feed).toContain('Cursor rule added');
    expect(feed).toContain('Claude Code skill installed');
  }, 60_000);
});
