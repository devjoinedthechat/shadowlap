import { spawn } from 'node:child_process';
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

    r = await shadowlap(['normalize', 'rm', 'create_ticket']);
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
    // Everything that loads the config names the broken rule.
    expect((await shadowlap(['redact', 'preview'])).err).toContain('shadowlap.config.json: normalizer #2: unknown pattern "uuidd"');
    expect((await shadowlap(['normalize', 'rm', 'uuidd'])).code).toBe(0);
    expect(config().normalize).toEqual([{ path: '$.a', replace: '<A>' }]);
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
    seedRuns();
    const store = Store.open(dbPath());
    const old = store.createRun({ mode: 'record', command: { argv: ['node', 'old.js'], cwd }, startedAt: Date.now() - 40 * 86_400_000 });
    store.appendCallStart({ runId: old.runId, callNo: 1, kind: 'tool', name: 't', fingerprint: 'c'.repeat(64), occurrence: 1, origin: 'live', effect: 'read', requestRef: store.putBlob(Buffer.from(`only the old run has this ${'z'.repeat(5000)}`)), meta: {}, at: 1 });
    store.endRun(old.runId, 'completed');
    const ancient = store.createRun({ mode: 'record', command: { argv: ['node', 'old.js'], cwd }, startedAt: Date.now() - 90 * 86_400_000 }); // never ended: still "recording"
    store.close();

    let r = await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json']);
    expect(r.code, r.err).toBe(0);
    const plan = JSON.parse(r.out) as { dryRun: boolean; total: number; runs: Array<{ runId: string }>; blobs: number; bytes: number; store: { before: number; after: null } };
    expect(plan).toMatchObject({ dryRun: true, olderThanDays: 30, keep: null, total: 4, blobs: 1, store: { after: null } });
    expect(plan.runs.map((x) => x.runId)).toEqual([old.runId]);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.store.before).toBeGreaterThan(0);
    expect(r.events).toEqual([{ type: 'result', data: plan }]);

    r = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(r.out).toContain('▸ runs older than 30 days: 1 of 4 · runs still recording are never touched');
    expect(r.out).toMatch(/blobs nothing would reference: 1 · \d/);
    expect(r.out).toMatch(/✓ dry run: would delete 1 run and free .+\. Run it without --dry-run to delete\./);
    const check = Store.open(dbPath());
    expect(check.getRun(old.runId)).not.toBeNull();
    check.close();

    r = await shadowlap(['gc', '--older-than', '30']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/✓ deleted 1 run and 1 blob · store .+ → .+/);
    expect(r.events[0]).toMatchObject({ type: 'result', data: { dryRun: false, blobs: 1, store: { after: expect.any(Number) } } });
    const after = Store.open(dbPath());
    expect(after.getRun(old.runId)).toBeNull();
    expect(after.getRun(ancient.runId)).not.toBeNull();
    expect(after.listEvents()[0]).toMatchObject({ kind: 'runs.cleaned', actor: 'dana', data: { runs: 1, blobs: 1, olderThanDays: 30, keep: null } });
    after.close();

    r = await shadowlap(['gc', '--dry-run']);
    expect(r.out).toContain('▸ no runs to delete (--older-than <days> or --keep <n> picks them)');
    expect(r.out).toContain('✓ dry run: would free 0 B.');
  });
});

describe('shadowlap calibrate', () => {
  it('asks for a recording first when there is none to calibrate', async () => {
    const r = await shadowlap(['calibrate']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Record a run first: shadowlap run -- <command>');
  });
});
