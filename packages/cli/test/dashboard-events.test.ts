import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity } from '@shadowlap/dashboard';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

/**
 * What a command tells a dashboard job on fd 3 (the runs it made, a link, the files it wrote, its
 * result), who it says made a run, and the activity events it records. Run as the dashboard runs
 * it: with an extra pipe and SHADOWLAP_EVENTS_FD naming it.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));
const VOLATILE_AGENT = fileURLToPath(new URL('./volatile-agent.mjs', import.meta.url));

interface Outcome {
  code: number | null;
  out: string;
  events: Array<Record<string, unknown>>;
}

let mock: MockServer;
let cwd: string;
let db: string;
let env: NodeJS.ProcessEnv;

function shadowlap(args: string[], options: { cwd?: string; db?: string | null; env?: NodeJS.ProcessEnv } = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const dbArgs = options.db === null ? [] : ['--db', options.db ?? db];
    const child = spawn(process.execPath, [CLI, ...dbArgs, ...args], { cwd: options.cwd ?? cwd, env: { ...env, ...options.env, SHADOWLAP_EVENTS_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
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
    // The variable is gone, and the descriptor is not inherited: a line written to fd 3 never reaches the job.
    const agent = [
      'console.log("events fd: " + (process.env.SHADOWLAP_EVENTS_FD ?? "unset"));',
      'try { require("node:fs").writeSync(3, JSON.stringify({ type: "link", label: "from the agent", href: "#/runs" }) + "\\n"); } catch (err) { console.log("fd 3: " + err.code); }',
    ].join(' ');
    const r = await shadowlap(['run', '--', process.execPath, '-e', agent]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('events fd: unset');
    expect(r.events.map((e) => e.type)).toEqual(['run', 'result', 'link']);
    expect(r.events.some((e) => e.label === 'from the agent')).toBe(false);
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

  it('replay with an intervention flag: the fork says who made it, and the feed names the flag', async () => {
    const r = await shadowlap(['replay', recordingId, '--diverge-at', '5', '--writes', 'stub']);
    const run = r.events.find((e) => e.type === 'run');
    expect(run, r.out).toBeDefined();
    const runId = String(run!.runId);
    withStore((s) => expect(s.getRun(runId)!.meta).toMatchObject({ author: 'maya@example.com' }));
    // The flags the replay kept on its run (meta.interventions) when it keeps them; its forced divergence otherwise.
    const entry = withStore((s) => activity(s).items.find((i) => i.runId === runId));
    expect(entry?.text).toMatch(/^Forked at #5 with --diverge-at 5( --writes stub)? · /);
  });

  it('pack: names the folder it wrote and records it in the activity log, a golden apart from a pack to share', async () => {
    const r = await shadowlap(['pack', recordingId, 'share/first']);
    expect(r.code, r.out).toBe(0);
    expect(r.events).toContainEqual({ type: 'file', path: 'share/first', label: 'Pack' });
    expect(r.events.find((e) => e.type === 'result')).toMatchObject({ data: { dir: 'share/first', runs: [recordingId], calls: 30 } });
    const [event] = withStore((s) => s.listEvents({ kinds: ['run.packed'] }));
    expect(event).toMatchObject({ kind: 'run.packed', actor: 'maya@example.com', runId: recordingId, ref: 'share/first', data: { runs: 1, calls: 30, redacted: false } });
    expect((await shadowlap(['pack', recordingId, 'goldens/refund'])).code).toBe(0);
    expect(withStore((s) => s.listEvents({ kinds: ['golden.packed'] })).map((e) => e.ref)).toEqual(['goldens/refund']);
    // A pack does not carry who recorded it.
    expect(readFileSync(join(cwd, 'goldens', 'refund', 'run.json'), 'utf8')).not.toContain('maya@example.com');
    // Written outside the project: the log names the folder, never the way out of the project to it.
    const elsewhere = mkdtempSync(join(tmpdir(), 'sl-dash-events-elsewhere-'));
    try {
      expect((await shadowlap(['pack', recordingId, join(elsewhere, 'share-with-ravi')])).code).toBe(0);
      const outside = withStore((s) => s.listEvents({ kinds: ['run.packed'] }))[0]!;
      expect(outside).toMatchObject({ ref: 'share-with-ravi', data: { outside: true } });
      expect(JSON.stringify(outside)).not.toContain('..');
      expect(JSON.stringify(outside)).not.toContain(elsewhere);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('test: marks who replayed the golden, as every run says who made it', async () => {
    const r = await shadowlap(['test', 'goldens/refund']);
    expect(r.code, r.out).toBe(0);
    const runs = withStore((s) => s.allRuns().filter((x) => (x.meta?.test as { golden?: string } | undefined)?.golden));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.meta?.author).toBe('maya@example.com');
  });

  it('export html, har, dataset and otel: name the file each wrote, and what it holds', async () => {
    const quiet = { env: { OTEL_EXPORTER_OTLP_ENDPOINT: '' } };
    const exports: Array<[string[], string, string, Record<string, unknown>]> = [
      [['export', 'html', recordingId, 'run.html'], 'run.html', 'HTML', { runIds: [recordingId], calls: 30, redacted: false }],
      [['export', 'har', recordingId, 'run.har'], 'run.har', 'HAR', { entries: expect.any(Number), skipped: expect.any(Number) }],
      [['export', 'dataset', recordingId, '--out', 'dataset.jsonl'], 'dataset.jsonl', 'Dataset', { examples: 1, runs: 1, format: 'jsonl', calls: 'final' }],
      [['export', 'otel', recordingId, '--out', 'trace.json'], 'trace.json', 'OTel trace', { spans: 31, written: true, sent: false }],
    ];
    for (const [args, name, label, result] of exports) {
      const r = await shadowlap(args, quiet);
      expect(r.code, r.out).toBe(0);
      const file = r.events.find((e) => e.type === 'file') as { path: string; label: string } | undefined;
      expect(file?.label, name).toBe(label);
      expect(realpathSync(file!.path)).toBe(realpathSync(join(cwd, name)));
      expect(r.events.find((e) => e.type === 'result'), name).toEqual({ type: 'result', data: result });
    }
  });

  it('unpack: reports the runs it brought in, the pack\'s own run last, so the job opens it', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'sl-dash-events-unpack-'));
    try {
      // The fork made above, packed with the recording it came from.
      const fork = withStore((s) => s.childRuns(recordingId).find((r) => !r.meta?.repeat))!.runId;
      expect((await shadowlap(['pack', fork, 'share/lineage', '--lineage'])).code).toBe(0);
      const r = await shadowlap(['unpack', join(cwd, 'share', 'lineage')], { db: join(elsewhere, 'shadowlap.db') });
      expect(r.code, r.out).toBe(0);
      expect(r.events.filter((e) => e.type === 'run')).toEqual([
        { type: 'run', runId: recordingId, role: 'imported' },
        { type: 'run', runId: fork, role: 'imported' },
      ]);
      expect(r.events.find((e) => e.type === 'result')).toEqual({ type: 'result', data: { imported: [recordingId, fork], skipped: [] } });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('normalize add and redact add: record who changed the rules', async () => {
    expect((await shadowlap(['normalize', 'add', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'])).code).toBe(0);
    expect((await shadowlap(['redact', 'add', '--pattern', '/ACME-\\d{6}/', '--replace', '<ACCOUNT>', '--path', '$.messages'])).code).toBe(0);
    const events = withStore((s) => s.listEvents({ kinds: ['normalizer.added', 'redaction.added'] }));
    expect(events.map((e) => [e.kind, e.ref, e.actor])).toEqual([
      ['redaction.added', '<ACCOUNT>', 'maya@example.com'],
      ['normalizer.added', '$.metadata.user_id', 'maya@example.com'],
    ]);
    expect(events[1]!.data).toEqual({ path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' });
    // A redaction rule's pattern can hold what it hides: the log and the feed name it by its replacement.
    expect(events[0]!.data).toEqual({ path: '$.messages', replace: '<ACCOUNT>' });
    expect(JSON.stringify(withStore((s) => activity(s).items))).not.toContain('ACME');
    expect(withStore((s) => activity(s).items.find((i) => i.id === `e:${events[0]!.eventId}`))?.text).toBe('Redaction rule added · <ACCOUNT> at $.messages');
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

describe('more commands a dashboard job runs', () => {
  let volatile: MockServer;
  beforeAll(async () => {
    volatile = await startMockAnthropic({ script: () => ({ message: message([text('triaged')]) }) });
  });
  afterAll(() => volatile.close());

  it('calibrate --write: reports its result, and records each normalizer it adds', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sl-dash-calibrate-'));
    const projectDb = join(project, '.shadowlap', 'shadowlap.db');
    const options = { cwd: project, db: projectDb, env: { SHADOWLAP_UPSTREAM_ANTHROPIC: volatile.url } };
    try {
      const recorded = await shadowlap(['run', '--', process.execPath, VOLATILE_AGENT], options);
      expect(recorded.code, recorded.out).toBe(0);
      const runId = String(recorded.events.find((e) => e.type === 'run')!.runId);
      const r = await shadowlap(['calibrate', runId, '--write'], options);
      expect(r.code, r.out).toBe(0);
      expect(r.events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', data: expect.objectContaining({ runId, clean: true, written: true, stopped: null }) }]);
      const result = r.events.find((e) => e.type === 'result') as { data: { normalizers: unknown[] } };
      expect(result.data.normalizers).toHaveLength(3);
      const store = Store.open(projectDb);
      try {
        const added = store.listEvents({ kinds: ['normalizer.added'] });
        expect(added.map((e) => [e.ref, e.runId, e.actor, (e.data as { via?: string }).via])).toEqual(
          expect.arrayContaining([
            ['$.metadata.user_id', runId, 'maya@example.com', 'calibrate'],
            ['$.system', runId, 'maya@example.com', 'calibrate'],
            ['$.args.path', runId, 'maya@example.com', 'calibrate'],
          ]),
        );
        expect(added).toHaveLength(3);
      } finally {
        store.close();
      }
    } finally {
      rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('serve: reports the run it records as it starts, and marks who made it', async () => {
    const child = spawn(process.execPath, [CLI, '--db', db, 'serve'], { cwd, env: { ...env, SHADOWLAP_EVENTS_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let events = '';
    let out = '';
    child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (out += c.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => (events += c.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    for (let i = 0; i < 400 && !events.includes('\n'); i++) await new Promise((r) => setTimeout(r, 25));
    const started = JSON.parse(events.split('\n')[0]!) as { type: string; runId: string; role: string };
    expect(started, out).toMatchObject({ type: 'run', role: 'new' });
    withStore((s) => expect(s.getRun(started.runId)).toMatchObject({ status: 'running', meta: { author: 'maya@example.com' } }));
    child.kill('SIGTERM');
    // Windows has no SIGTERM a process can catch: kill() ends it on the spot, before it can end its run.
    if (process.platform === 'win32') return void (await exited);
    expect(await exited).toBe(0);
    withStore((s) => expect(s.getRun(started.runId)!.status).toBe('completed'));
  });
});
