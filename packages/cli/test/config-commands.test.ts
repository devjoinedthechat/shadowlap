import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, storeApiRequest } from '@shadowlap/engine';

/** normalize, redact, gc and calibrate through the CLI, as a person or a dashboard job runs them. */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let cwd: string;
beforeEach(() => {
  // The real path: on macOS the temporary folder is a link, and the CLI reports where it actually is.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-config-cli-')));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

interface Ran {
  code: number | null;
  out: string;
  err: string;
  /** What the command reported to a dashboard job on fd 3. */
  events: Array<{ type: string; data?: unknown }>;
}

function shadowlap(args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_AUTHOR: 'dana', SHADOWLAP_EVENTS_FD: '3' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let fd3 = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (fd3 += d.toString()));
    child.on('close', (code) => resolve({ code, out, err, events: fd3.trim() ? fd3.trim().split('\n').map((l) => JSON.parse(l) as Ran['events'][number]) : [] }));
  });
}

const config = () => JSON.parse(readFileSync(join(cwd, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
const dbPath = () => join(cwd, '.shadowlap', 'shadowlap.db');
const activity = () => {
  const store = Store.open(dbPath());
  try {
    return store.listEvents().reverse().map((e) => [e.kind, e.actor, e.data?.n ?? null]);
  } finally {
    store.close();
  }
};

describe('shadowlap normalize', () => {
  it('adds every form of rule, lists them numbered, and removes by number, name, path or pattern', async () => {
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ $schema: 'x', tests: { 'goldens/*': { expect: { tools: { send_email: 0 } } } } }, null, 2));
    Store.open(dbPath()).close(); // a project that has recorded before keeps an activity log

    let r = await shadowlap(['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`added normalizer #1 to ${join(cwd, 'shadowlap.config.json')}\n`);
    // A regex with no path masks it in every string; a tool name with a path and no pattern masks the whole value.
    expect((await shadowlap(['normalize', 'add', '--pattern', '/req_[a-z0-9]+/i', '--replace', '<REQ>'])).code).toBe(0);
    expect((await shadowlap(['normalize', 'add', '--kind', 'tool', '--name', 'create_ticket', '--path', '$.args.idempotency_key', '--replace', '<ID>'])).code).toBe(0);

    r = await shadowlap(['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>']);
    expect(r).toMatchObject({ code: 0, out: expect.stringContaining('normalizer #1 in') });
    expect(r.out).toContain('is already this rule; nothing changed');

    r = await shadowlap(['normalize', 'add', '--replace', '<X>']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('give a path, a pattern or both');
    r = await shadowlap(['normalize', 'add', '--path', '$.a', '--pattern', 'uuidd']);
    expect(r.err).toContain('unknown pattern "uuidd"');
    r = await shadowlap(['normalize', 'add', '--path', '$.a', '--kind', 'tools']);
    expect(r.err).toMatch(/must be one of api, tool, clock, random/);

    const listed = JSON.parse((await shadowlap(['normalize', 'ls', '--json'])).out) as { file: string; version: string; rules: unknown[] };
    expect(listed.file).toBe(join(cwd, 'shadowlap.config.json'));
    expect(listed.version).toMatch(/^[0-9a-f]{64}$/);
    expect(listed.rules).toEqual([
      { n: 1, kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' },
      { n: 2, pattern: '/req_[a-z0-9]+/i', replace: '<REQ>' },
      { n: 3, kind: 'tool', name: 'create_ticket', path: '$.args.idempotency_key', replace: '<ID>' },
    ]);
    const table = (await shadowlap(['normalize', 'ls'])).out;
    expect(table).toMatch(/#2 +\* +\* +\(all strings\) +\/req_\[a-z0-9\]\+\/i +→ <REQ>/);
    expect(table).toMatch(/#3 +tool +create_ticket +\$\.args\.idempotency_key +\(whole value\) +→ <ID>/);

    // A script that read the list can make sure it removes what it read.
    r = await shadowlap(['normalize', 'rm', '1', '--expect', 'absent']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('changed since it was read') });
    r = await shadowlap(['normalize', 'rm', 'create_ticket', '--expect', listed.version]);
    expect(r.out).toContain('removed normalizer #3 (tool · create_ticket  $.args.idempotency_key  whole value → <ID>)');
    r = await shadowlap(['normalize', 'rm', '#1']);
    expect(r.out).toContain('removed normalizer #1');
    expect(r.out).toContain('the normalizers after it moved up one');
    r = await shadowlap(['normalize', 'rm', '7']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('there is no normalizer #7') });

    expect(config()).toEqual({ $schema: 'x', tests: { 'goldens/*': { expect: { tools: { send_email: 0 } } } }, normalize: [{ pattern: '/req_[a-z0-9]+/i', replace: '<REQ>' }] });
    expect(Object.keys(config())).toEqual(['$schema', 'tests', 'normalize']);
    expect(activity()).toEqual([
      ['normalizer.added', 'dana', 1],
      ['normalizer.added', 'dana', 2],
      ['normalizer.added', 'dana', 3],
      ['normalizer.removed', 'dana', 3],
      ['normalizer.removed', 'dana', 1],
    ]);
  });

  it('edits the config without creating a store where there is none', async () => {
    expect((await shadowlap(['normalize', 'add', '--path', '$.a', '--replace', '<A>'])).code).toBe(0);
    expect(existsSync(join(cwd, '.shadowlap'))).toBe(false);
    expect(JSON.parse((await shadowlap(['normalize', 'ls', '--json'])).out)).toMatchObject({ exists: true, rules: [{ n: 1, path: '$.a' }] });
    expect((await shadowlap(['redact', 'ls'])).out).toBe('no redaction rules\n');
  });

  it('lists a rule the config cannot load, so it can be removed', async () => {
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ normalize: [{ path: '$.a', replace: '<A>' }, { pattern: 'uuidd', replace: '<U>' }] }));
    expect((await shadowlap(['normalize', 'ls'])).out).toMatch(/#2 +✗ unknown pattern "uuidd"/);
    expect(JSON.parse((await shadowlap(['normalize', 'ls', '--json'])).out).rules[1]).toMatchObject({ n: 2, error: expect.stringContaining('uuidd') });
    // What applies normalizers names the broken rule before it records anything.
    const run = await shadowlap(['run', '--', process.execPath, '-e', '']);
    expect(run).toMatchObject({ code: 1, err: expect.stringContaining('shadowlap.config.json: normalizer #2: unknown pattern "uuidd"') });
    expect((await shadowlap(['normalize', 'rm', 'uuidd'])).code).toBe(0);
    expect(config().normalize).toEqual([{ path: '$.a', replace: '<A>' }]);
  });

  it('says when a list of rules is not a list', async () => {
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ normalize: { pattern: 'uuid', replace: '<U>' } }));
    const r = await shadowlap(['normalize', 'ls']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('shadowlap.config.json: normalize must be a list of rules') });
    const json = await shadowlap(['normalize', 'ls', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ error: 'shadowlap.config.json: normalize must be a list of rules', rules: [] });
    expect(JSON.parse((await shadowlap(['redact', 'ls', '--json'])).out)).toMatchObject({ error: null, rules: [] });
  });
});

describe('a broken or long rule in the file', () => {
  /** `shadowlap dashboard` in the background: its address and session token, and how to stop it. */
  function dashboard(): Promise<{ origin: string; token: string; stop: () => Promise<void> }> {
    const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open'], { cwd, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
    let err = '';
    return new Promise((resolve, reject) => {
      child.stderr!.on('data', (d: Buffer) => {
        err += d.toString();
        const link = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/.exec(err);
        if (link) resolve({ origin: link[1]!, token: link[2]!, stop: () => (child.kill('SIGTERM'), closed) });
      });
      void closed.then(() => reject(new Error(`the dashboard exited: ${err}`)));
    });
  }

  it('starts the dashboard and records, and stops only what applies the broken rule, naming it', async () => {
    const { done } = seedRuns();
    // A long alternation of customer names is a fine rule; a misspelled pattern is not.
    const names = Array.from({ length: 300 }, (_, i) => `customer${String(i).padStart(3, '0')}`).join('|');
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ normalize: [{ pattern: 'uuidd', replace: '<U>' }], redact: [{ pattern: `/${names}/g`, replace: '<NAME>' }, { pattern: 'emial', replace: '<E>' }] }));
    expect(names.length).toBeGreaterThan(2000);

    const dash = await dashboard();
    try {
      // A download applies the redaction rules as they are now: a broken one fails it rather than leaving the rule out.
      const res = await fetch(`${dash.origin}/api/runs/${done}/export`, { headers: { 'x-shadowlap-token': dash.token } });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain('shadowlap.config.json: redaction rule #2: unknown pattern "emial"');
      expect((await shadowlap(['redact', 'rm', '2'])).code).toBe(0);
      const ok = await fetch(`${dash.origin}/api/runs/${done}/export`, { headers: { 'x-shadowlap-token': dash.token } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('x-shadowlap-redacted')).toBe('yes');
    } finally {
      await dash.stop();
    }

    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: `/${names}/g`, replace: '<NAME>' }, { pattern: 'emial', replace: '<E>' }] }));
    // Recording applies no redaction rule, so a broken one doesn't stop it.
    const recorded = await shadowlap(['run', '--', process.execPath, '-e', '']);
    expect(recorded.code, recorded.err).toBe(0);
    // Sharing does: pack and the preview name the rule.
    expect((await shadowlap(['pack', done, join(cwd, 'out')])).err).toContain('shadowlap.config.json: redaction rule #2: unknown pattern "emial"');
    expect((await shadowlap(['redact', 'preview', done])).err).toContain('redaction rule #2: unknown pattern "emial"');
    expect((await shadowlap(['redact', 'rm', 'emial'])).code).toBe(0);
    const preview = await shadowlap(['redact', 'preview', done, '--json']);
    expect(preview.code, preview.err).toBe(0);
    expect(JSON.parse(preview.out)).toMatchObject({ rules: [{ n: 1, count: 0 }] });
  });
});

/** A finished run with an email in its prompt and a key in a tool's arguments, and one still recording. */
function seedRuns(): { done: string; live: string } {
  const store = Store.open(dbPath());
  const done = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd } });
  const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
  store.appendCallStart({ runId: done.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', system: 'Owner: alice@example.com', messages: [{ role: 'user', content: 'hi' }] }), meta: {}, at: 1 });
  store.appendCallEnd(api, { runId: done.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"content":[{"type":"text","text":"ok"}]}')), outcome: 'ok', meta: {}, at: 2 });
  const tool = { kind: 'tool' as const, name: 'send_email', fingerprint: 'b'.repeat(64), occurrence: 1 };
  store.appendCallStart({ runId: done.runId, callNo: 2, ...tool, origin: 'live', effect: 'write', requestRef: store.putJson({ args: { api_key: 'sk-live-1', to: 'bob@example.com' } }), meta: {}, at: 3 });
  store.appendCallEnd(tool, { runId: done.runId, callNo: 2, attempt: 0, responseRef: store.putJson({ result: 'sent' }), outcome: 'ok', meta: {}, at: 4 });
  store.endRun(done.runId, 'completed');
  const live = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd } });
  store.close();
  return { done: done.runId, live: live.runId };
}

describe('shadowlap redact', () => {
  it('adds, refuses a replacement a replay would rewrite, previews a finished run and removes', async () => {
    const { done, live } = seedRuns();
    expect((await shadowlap(['redact', 'add', '--pattern', 'email', '--replace', '<EMAIL>'])).code).toBe(0);
    // A path with no pattern masks the whole value there.
    expect((await shadowlap(['redact', 'add', '--kind', 'tool', '--path', '$.args.api_key', '--replace', '<KEY>'])).code).toBe(0);
    let r = await shadowlap(['redact', 'add', '--pattern', 'number', '--replace', 'n0']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('number would rewrite its own replacement "n0"') });
    r = await shadowlap(['redact', 'add', '--kind', 'clock', '--pattern', 'email']);
    expect(r.err).toMatch(/must be one of api, tool/);

    r = await shadowlap(['redact', 'preview', done.slice(0, 10), '--json']);
    expect(r.code, r.err).toBe(0);
    const preview = JSON.parse(r.out) as { runId: string; total: number; rules: Array<{ n: number; count: number; samples: Array<{ before: string; after: string }> }> };
    expect(preview).toMatchObject({ runId: done, total: 3 });
    expect(preview.rules.map((x) => [x.n, x.count])).toEqual([[1, 2], [2, 1]]);
    expect(preview.rules[1]!.samples).toEqual([{ before: 'sk-live-1', after: '<KEY>' }]);
    expect(r.events).toEqual([{ type: 'result', data: preview }]);

    r = await shadowlap(['redact', 'preview']);
    expect(r.out).toContain(`${done.slice(0, 10)} (node agent.js): 3 values would be masked`);
    expect(r.out).toMatch(/#1 +every call +any string +email → <EMAIL> +2/);
    expect(r.out).toContain('- Owner: alice@example.com');
    expect(r.out).toContain('+ Owner: <EMAIL>');

    r = await shadowlap(['redact', 'preview', live]);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('is still recording; preview it once it has ended') });

    expect((await shadowlap(['redact', 'rm', 'email'])).out).toContain('removed redaction rule #1 (every call  any string  email → <EMAIL>)');
    expect(config().redact).toEqual([{ kind: 'tool', path: '$.args.api_key', replace: '<KEY>' }]);
    expect(activity().map(([kind]) => kind)).toEqual(['redaction.added', 'redaction.added', 'redaction.removed']);
  });
});

describe('shadowlap gc', () => {
  it('says what it would free before deleting anything, then deletes and logs it', async () => {
    const { live } = seedRuns();
    const store = Store.open(dbPath());
    const old = store.createRun({ mode: 'record', command: { argv: ['node', 'old.js'], cwd }, startedAt: Date.now() - 40 * 86_400_000 });
    store.appendCallStart({ runId: old.runId, callNo: 1, kind: 'tool', name: 't', fingerprint: 'c'.repeat(64), occurrence: 1, origin: 'live', effect: 'read', requestRef: store.putBlob(Buffer.from(`only the old run has this ${'z'.repeat(5000)}`)), meta: {}, at: 1 });
    store.endRun(old.runId, 'completed');
    const ancient = store.createRun({ mode: 'record', command: { argv: ['node', 'old.js'], cwd }, startedAt: Date.now() - 90 * 86_400_000 }); // never ended: still "recording"
    store.close();

    let r = await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json']);
    expect(r.code, r.err).toBe(0);
    const plan = JSON.parse(r.out) as { dryRun: boolean; cutoff: number; total: number; runs: Array<{ runId: string }>; blobs: number; bytes: number; recording: Array<{ runId: string }>; store: { before: number; after: null } };
    expect(plan).toMatchObject({ dryRun: true, olderThanDays: 30, keep: null, total: 4, blobs: 1, deferred: true, store: { after: null } });
    expect(plan.runs.map((x) => x.runId)).toEqual([old.runId]);
    expect(plan.recording.map((x) => x.runId).sort()).toEqual([live, ancient.runId].sort());
    expect(plan.cutoff).toBeGreaterThan(Date.now() - 31 * 86_400_000);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.store.before).toBeGreaterThan(0);
    expect(r.events).toEqual([{ type: 'result', data: plan }]);

    r = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(r.out).toContain('▸ runs older than 30 days: 1 of 4 · runs still recording are never touched');
    expect(r.out).toMatch(/blobs nothing would reference: 1 · \d.* · collected once no run is recording: 2 runs are still recording/);
    expect(r.out).toMatch(/✓ dry run: would delete 1 run and free .+\. Run it without --dry-run to delete\./);
    const check = Store.open(dbPath());
    expect(check.getRun(old.runId)).not.toBeNull();
    check.close();

    // The dialog says "Delete 1 run": the run that confirms it deletes exactly the runs the dry run listed.
    r = await shadowlap(['gc', '--before', String(plan.cutoff), '--expect', '2']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('gc would delete 1 run, not 2: the runs changed since the dry run. Nothing was deleted') });
    r = await shadowlap(['gc', '--older-than', '30', '--before', String(plan.cutoff)]);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('give --older-than or --before, not both') });

    // Runs are still recording: the old run goes, its blobs wait for a gc when nothing records.
    r = await shadowlap(['gc', '--before', String(plan.cutoff), '--expect', '1']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('no blobs collected: 2 runs are still recording');
    expect(r.out).toMatch(/✓ deleted 1 run · store .+ → .+/);
    expect(r.events[0]).toMatchObject({ type: 'result', data: { dryRun: false, blobs: 0, deferred: true, store: { after: expect.any(Number) } } });
    const after = Store.open(dbPath());
    expect(after.getRun(old.runId)).toBeNull();
    expect(after.getRun(ancient.runId)).not.toBeNull();
    expect(after.listEvents()[0]).toMatchObject({ kind: 'runs.cleaned', actor: 'dana', data: { runs: 1, blobs: 0, olderThanDays: null, keep: null } });
    after.endRun(live, 'completed');
    after.endRun(ancient.runId, 'crashed');
    after.close();

    r = await shadowlap(['gc', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ runs: [], blobs: 1, deferred: false, recording: [] });
    r = await shadowlap(['gc', '--dry-run']);
    expect(r.out).toContain('▸ no runs to delete (--older-than <days> or --keep <n> picks them)');
    expect(r.out).toContain('✓ dry run: would free 0 B.');
  });

  it('reports the store as it will be, even while a dashboard holds it open', async () => {
    const store = Store.open(dbPath());
    const old = store.createRun({ mode: 'record', command: { argv: ['node', 'old.js'], cwd }, startedAt: Date.now() - 40 * 86_400_000 });
    for (let i = 1; i <= 300; i++) {
      store.appendCallStart({ runId: old.runId, callNo: i, kind: 'tool', name: 't', fingerprint: String(i).padStart(64, '0'), occurrence: 1, origin: 'live', effect: 'read', requestRef: store.putBlob(randomBytes(3000)), meta: {}, at: i });
    }
    store.endRun(old.runId, 'completed');
    // Left open, reading now and then, as the dashboard's server does.
    store.listRuns(5);
    const r = await shadowlap(['gc', '--older-than', '30', '--json']);
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse(r.out) as { blobs: number; store: { before: number; after: number } };
    expect(report.blobs).toBe(300);
    expect(report.store.before).toBeGreaterThan(300 * 3000);
    expect(report.store.after).toBeLessThan(report.store.before / 10);
    expect(store.size().bytes).toBe(report.store.after);
    store.close();
  });

  it('cleans up nothing, and creates no store, in a project that has never recorded', async () => {
    const r = await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ dryRun: true, total: 0, runs: [], blobs: 0, store: { before: 0 } });
    expect((await shadowlap(['gc', '--older-than', '30'])).code).toBe(0);
    expect((await shadowlap(['redact', 'preview'])).err).toContain('no run to preview: record one with shadowlap run -- <command>');
    expect((await shadowlap(['calibrate'])).err).toContain('Record a run first');
    expect(existsSync(join(cwd, '.shadowlap'))).toBe(false);
  });
});

describe('shadowlap calibrate', () => {
  it('asks for a recording first when there is none to calibrate', async () => {
    const r = await shadowlap(['calibrate']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Record a run first: shadowlap run -- <command>');
  });
});
