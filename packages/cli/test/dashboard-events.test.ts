import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

/**
 * What a command tells a dashboard job on fd 3 (the runs it made, a link, the files it wrote, its
 * result), who it says made a run, and the activity events it records. Run as the dashboard runs
 * it: with an extra pipe and SHADOWLAP_EVENTS_FD naming it.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));

interface Outcome {
  code: number | null;
  out: string;
  events: Array<Record<string, unknown>>;
}

let mock: MockServer;
let cwd: string;
let db: string;
let env: NodeJS.ProcessEnv;

function shadowlap(args: string[], options: { cwd?: string; db?: string | null } = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const dbArgs = options.db === null ? [] : ['--db', options.db ?? db];
    const child = spawn(process.execPath, [CLI, ...dbArgs, ...args], { cwd: options.cwd ?? cwd, env: { ...env, SHADOWLAP_EVENTS_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let events = '';
    child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (out += c.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => (events += c.toString()));
    child.on('close', (code) => resolve({ code, out, events: events.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }));
  });
}

function withStore<T>(fn: (store: Store) => T): T {
  const store = Store.open(db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: referenceScript });
  cwd = mkdtempSync(join(tmpdir(), 'sl-dash-events-'));
  db = join(cwd, '.shadowlap', 'shadowlap.db');
  env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'maya@example.com' };
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a command started by a dashboard job', () => {
  let recordingId: string;

  it('run: reports the run it made, its result and a link, and marks who made it', async () => {
    const r = await shadowlap(['run', '--', process.execPath, AGENT]);
    expect(r.code, r.out).toBe(0);
    recordingId = /recording run (\w{26})/.exec(r.out)![1]!;
    expect(r.events[0]).toEqual({ type: 'run', runId: recordingId, role: 'new' });
    const result = r.events.find((e) => e.type === 'result') as { data: { exitCode: number; summary: { runId: string; total: number } } };
    expect(result.data.exitCode).toBe(0);
    expect(result.data.summary).toMatchObject({ runId: recordingId, total: 30 });
    expect(r.events.at(-1)).toEqual({ type: 'link', label: `Open run ${recordingId.slice(0, 10)}`, href: `#/run/${recordingId}` });
    expect(withStore((s) => s.getRun(recordingId)!.meta?.author)).toBe('maya@example.com');
  });

  it('keeps the agent out of the job\'s pipe: an agent that runs shadowlap itself reports nothing into it', async () => {
    const r = await shadowlap(['run', '--', process.execPath, '-e', 'console.log("events fd: " + (process.env.SHADOWLAP_EVENTS_FD ?? "unset"))']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('events fd: unset');
    expect(r.events.map((e) => e.type)).toEqual(['run', 'result', 'link']);
  });

  it('replay --repeat: reports every attempt as an attempt, the report, and where to see them', async () => {
    const r = await shadowlap(['replay', recordingId, '--repeat', '2']);
    expect(r.code, r.out).toBe(0);
    const runs = r.events.filter((e) => e.type === 'run');
    expect(runs).toHaveLength(2);
    expect(runs.every((e) => e.role === 'attempt')).toBe(true);
    const result = r.events.find((e) => e.type === 'result') as { data: { attempts: Array<{ runId: string; exitCode: number }>; report: unknown } };
    expect(result.data.attempts.map((a) => a.runId)).toEqual(runs.map((e) => e.runId));
    expect(r.events.at(-1)).toEqual({ type: 'link', label: 'Open the attempts', href: `#/run/${recordingId}/1/forks` });
    withStore((s) => {
      for (const e of runs) expect(s.getRun(String(e.runId))!.meta).toMatchObject({ author: 'maya@example.com', repeat: { of: 2 } });
    });
  });

  it('pack: names the folder it wrote and records it in the activity log', async () => {
    const r = await shadowlap(['pack', recordingId, 'share/first']);
    expect(r.code, r.out).toBe(0);
    expect(r.events).toContainEqual({ type: 'file', path: 'share/first', label: 'Pack' });
    expect(r.events.find((e) => e.type === 'result')).toMatchObject({ data: { dir: 'share/first', runs: [recordingId], calls: 30 } });
    const [event] = withStore((s) => s.listEvents({ kinds: ['golden.packed'] }));
    expect(event).toMatchObject({ kind: 'golden.packed', actor: 'maya@example.com', runId: recordingId, ref: 'share/first', data: { runs: 1, calls: 30, redacted: false } });
  });

  it('normalize add and redact add: record who changed the rules', async () => {
    expect((await shadowlap(['normalize', 'add', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'])).code).toBe(0);
    expect((await shadowlap(['redact', 'add', '--pattern', 'email'])).code).toBe(0);
    const events = withStore((s) => s.listEvents({ kinds: ['normalizer.added', 'redaction.added'] }));
    expect(events.map((e) => [e.kind, e.ref, e.actor])).toEqual([
      ['redaction.added', 'email', 'maya@example.com'],
      ['normalizer.added', '$.metadata.user_id', 'maya@example.com'],
    ]);
    expect(events[1]!.data).toEqual({ path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' });
  });

  it('adds no store to a project that has none just to log a rule', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sl-dash-bare-'));
    try {
      const r = await shadowlap(['normalize', 'add', '--path', '$.x'], { cwd: bare, db: null });
      expect(r.code, r.out).toBe(0);
      expect(existsSync(join(bare, 'shadowlap.config.json'))).toBe(true);
      expect(existsSync(join(bare, '.shadowlap'))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('init: reports what it found, and records the setup when it wrote the config', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sl-dash-init-'));
    try {
      writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'triage-bot', scripts: { agent: 'node agent.js' }, dependencies: { '@anthropic-ai/sdk': '^0.60.0' } }));
      writeFileSync(join(project, 'agent.js'), "import Anthropic from '@anthropic-ai/sdk';\n");
      const projectDb = join(project, '.shadowlap', 'shadowlap.db');
      Store.open(projectDb).close(); // the dashboard that runs init has the store open already
      const r = await shadowlap(['init', '--json'], { cwd: project, db: projectDb });
      expect(r.code, r.out).toBe(0);
      expect(r.events.find((e) => e.type === 'result')).toMatchObject({ data: { config: { created: true } } });
      const store = Store.open(projectDb);
      try {
        expect(store.listEvents({ kinds: ['project.setup'] }).map((e) => [e.ref, e.actor, (e.data as { config: string }).config])).toEqual([[project.split(/[\\/]/).pop(), 'maya@example.com', 'created']]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
