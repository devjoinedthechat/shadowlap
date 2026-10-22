import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, storeApiRequest } from '@shadowlap/engine';

/** normalize, redact, gc and calibrate through the CLI, as a person or a dashboard job runs them. */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const ENGINE = fileURLToPath(new URL('../../engine/dist/index.js', import.meta.url));

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
    return store.listEvents().reverse().map((e) => [e.kind, e.actor, e.ref]);
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
    // Each edit is in the activity log, a normalizer named by its path.
    expect(activity()).toEqual([
      ['normalizer.added', 'dana', '$.metadata.user_id'],
      ['normalizer.added', 'dana', null],
      ['normalizer.added', 'dana', '$.args.idempotency_key'],
      ['normalizer.removed', 'dana', '$.args.idempotency_key'],
      ['normalizer.removed', 'dana', '$.metadata.user_id'],
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
    // The dashboard keeps its list of projects in SHADOWLAP_HOME: the test's own, never the real one.
    const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open'], { cwd, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_HOME: join(cwd, '.sl-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
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
/** The dry run's JSON, as these tests read it. */
interface GcPlan {
  dryRun: boolean;
  cutoff: number;
  total: number;
  count: number;
  runs: Array<{ runId: string; command: string }>;
  expect: string;
  blobs: number;
  bytes: number;
  recording: Array<{ runId: string }>;
  abandoned: Array<{ runId: string }>;
  store: { before: number; after: null };
}

/** A recording made by a process of its own that is killed before it ends the run, as `kill -9` or a crash leaves one. */
function abandonedRun(startedAt: number, orphanBlob?: string): string {
  const script = `const { Store } = await import(${JSON.stringify(`file://${ENGINE}`)});
const s = Store.open(${JSON.stringify(dbPath())});
const r = s.createRun({ mode: 'record', command: { argv: ['node', 'crashed.js'], cwd: '.' }, startedAt: ${startedAt} });
${orphanBlob ? `s.putBlob(Buffer.from(${JSON.stringify(orphanBlob)}));` : ''}
process.stdout.write(r.runId);
process.exit(0);`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

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
    // A redaction rule is named by what it puts in place: its pattern can hold what it hides, so the log never has it.
    expect(activity()).toEqual([
      ['redaction.added', 'dana', '<EMAIL>'],
      ['redaction.added', 'dana', '<KEY>'],
      ['redaction.removed', 'dana', '<EMAIL>'],
    ]);
    const log = Store.open(dbPath());
    expect(log.listEvents().map((e) => e.data)).toEqual([{ replace: '<EMAIL>' }, { kind: 'tool', path: '$.args.api_key', replace: '<KEY>' }, { replace: '<EMAIL>' }]);

    // An imported run is named by the file it came from, not by a command it never had.
    const imported = log.createRun({ mode: 'record', command: { argv: [NO_COMMAND], cwd }, meta: { imported: { at: 1, from: 'captures/session.har' } } });
    log.endRun(imported.runId, 'completed');
    log.close();
    r = await shadowlap(['redact', 'preview', imported.runId]);
    expect(r.out).toContain(`${imported.runId.slice(0, 10)} (imported from captures/session.har): 0 values would be masked`);
  });

  it('says what a pack leaves as it is, with the path rule that masks it in the copies that are read, and that rule does', async () => {
    const store = Store.open(dbPath());
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd } });
    const call = (callNo: number, kind: 'clock' | 'tool', name: string, request: unknown, result: string) => {
      const id = { kind, name, fingerprint: String(callNo).padStart(64, 'c'), occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo, ...id, origin: 'live', effect: kind === 'tool' ? 'read' : null, requestRef: store.putJson(request), meta: {}, at: callNo });
      store.appendCallEnd(id, { runId: run.runId, callNo, attempt: 0, responseRef: store.putBlob(Buffer.from(result)), outcome: 'ok', meta: {}, at: callNo });
    };
    // The time the agent read, a card on file (a number, and the same card as text), and the card sent to a charge as a number.
    call(1, 'clock', 'now', { label: 'now' }, '{"result":1792155242516}');
    call(2, 'tool', 'lookup_card', { args: { customer: 'C-311' } }, '{"result": {"card": 4111111111111111, "on_file": "4111 1111 1111 1111"}}');
    call(3, 'tool', 'charge', { args: { card: 4111111111111111 } }, '{"result": {"ok": true}}');
    store.endRun(run.runId, 'completed');
    store.close();
    expect((await shadowlap(['redact', 'add', '--pattern', '/\\b(?:\\d[ -]?){13,16}\\b/', '--replace', '<CARD>'])).code).toBe(0);

    let r = await shadowlap(['redact', 'preview', run.runId]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(
      [
        `${run.runId.slice(0, 10)} (node agent.js): 1 value would be masked, 2 left as they are`,
        '  #1  every call  any string  /\\b(?:\\d[ -]?){13,16}\\b/ → <CARD>  1',
        '        - 4111 1111 1111 1111',
        '        + <CARD>',
        '        2 left as they are:',
        '        = 1792155242516  call 1 clock now, response $.result',
        '        = 4111111111111111  call 2 tool lookup_card, response $.result.card',
        '        a path rule masks the whole value at its path, numbers included:',
        "          shadowlap redact add --kind tool --name charge --path '$.args.card' --replace '<CARD>'",
        '        a pack keeps what a call got back, since its replay hands it to the agent; export html, har and dataset mask it with:',
        "          shadowlap redact add --kind tool --name lookup_card --path '$.result.card' --replace '<CARD>'",
        '        a clock or random read stays as recorded: a replay needs it',
        '',
      ].join('\n'),
    );
    r = await shadowlap(['redact', 'preview', run.runId, '--json']);
    type Unmasked = { count: number; samples: Array<{ value: string; key: boolean; in: string; path: string; event: number | null }>; places: number; remedies: Array<{ rule: unknown; command: string; copies: string }>; covered: number[]; reasons: string[] };
    const preview = JSON.parse(r.out) as { total: number; returned: number; unmasked: number; rules: Array<{ returned: { count: number }; unmasked: Unmasked }> };
    expect(preview).toMatchObject({ total: 1, returned: 0, unmasked: 2 });
    expect(preview.rules[0]!.unmasked.samples.map((s) => [s.value, s.key, s.in, s.path, s.event])).toEqual([
      ['1792155242516', false, 'response', '$.result', null],
      ['4111111111111111', false, 'response', '$.result.card', null],
    ]);
    expect(preview.rules[0]!.unmasked).toMatchObject({
      places: 2,
      remedies: [
        { rule: { kind: 'tool', name: 'charge', path: '$.args.card', replace: '<CARD>' }, command: "shadowlap redact add --kind tool --name charge --path '$.args.card' --replace '<CARD>'", copies: 'all' },
        { rule: { kind: 'tool', name: 'lookup_card', path: '$.result.card', replace: '<CARD>' }, command: "shadowlap redact add --kind tool --name lookup_card --path '$.result.card' --replace '<CARD>'", copies: 'read' },
      ],
      covered: [],
      reasons: ['replay'],
    });

    // The commands it gives, run: the charge's card is masked in a pack; the card the lookup returned
    // only in a copy that is read, and the preview says which rule does it; the time is left everywhere.
    expect((await shadowlap(['redact', 'add', '--kind', 'tool', '--name', 'charge', '--path', '$.args.card', '--replace', '<CARD>'])).code).toBe(0);
    expect((await shadowlap(['redact', 'add', '--kind', 'tool', '--name', 'lookup_card', '--path', '$.result.card', '--replace', '<CARD>'])).code).toBe(0);
    r = await shadowlap(['redact', 'preview', run.runId]);
    expect(r.out).toContain(': 2 values would be masked, 2 left as they are; export html, har and dataset mask 1 more in what calls got back\n');
    expect(r.out).toContain('        a pack keeps what a call got back, since its replay hands it to the agent; export html, har and dataset mask it (#3 already does)\n        a clock or random read stays as recorded: a replay needs it\n');
    expect(r.out).toMatch(/#3 +tool · lookup_card +\$\.result\.card +whole value → <CARD> +0 +a pack keeps what calls got back, since its replay hands it to the agent\n {8}export html, har and dataset mask 1 in what calls got back:\n {8}- 4111111111111111\n {8}\+ <CARD>/);
    expect((await shadowlap(['pack', run.runId, join(cwd, 'packed')])).code).toBe(0);
    const blobs = readdirSync(join(cwd, 'packed', 'blobs')).map((f) => readFileSync(join(cwd, 'packed', 'blobs', f), 'utf8'));
    expect(blobs).toContain('{"result":1792155242516}');
    expect(blobs).toContain('{"result": {"card": 4111111111111111, "on_file": "<CARD>"}}');
    expect(blobs).toContain('{"args":{"card":"<CARD>"}}');
  });

  it("previews the run's command line, labels and notes apart, which export html masks and pack keeps", async () => {
    const store = Store.open(dbPath());
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js', '--customer', 'erin@example.com'], cwd } });
    store.updateRunMeta(run.runId, { labels: ['vip'], notes: [{ callNo: null, text: 'called back hank@example.com', at: 1 }] });
    store.endRun(run.runId, 'completed');
    store.close();
    expect((await shadowlap(['redact', 'add', '--pattern', 'email', '--replace', '<EMAIL>'])).code).toBe(0);
    let r = await shadowlap(['redact', 'preview', run.runId]);
    expect(r.out).toContain(`${run.runId.slice(0, 10)} (node agent.js --customer erin@example.com): 0 values would be masked`);
    expect(r.out).toContain("the run's command line, labels and notes: 2 (#1)  masked by export html, dataset and otel; pack copies them as recorded, since a replay runs the command");
    expect(r.out).toContain('+ called back <EMAIL>');
    r = await shadowlap(['redact', 'preview', run.runId, '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ total: 0, details: { count: 2, rules: [1] } });

    // export html carries neither; pack keeps the command line a replay runs.
    expect((await shadowlap(['export', 'html', run.runId, join(cwd, 'run.html')])).code).toBe(0);
    const html = readFileSync(join(cwd, 'run.html'), 'utf8');
    expect(html).not.toContain('erin@example.com');
    expect(html).not.toContain('hank@example.com');
    expect(html).toContain('--customer <EMAIL>');
    expect((await shadowlap(['pack', run.runId, join(cwd, 'packed')])).code).toBe(0);
    expect(readFileSync(join(cwd, 'packed', 'run.json'), 'utf8')).toContain('erin@example.com');
  });
});

describe('shadowlap gc', () => {
  it('says what it would free before deleting anything, then deletes exactly that and logs it', async () => {
    const { live } = seedRuns();
    const store = Store.open(dbPath());
    const old = store.createRun({ mode: 'record', command: { argv: ['node', 'old.js'], cwd }, startedAt: Date.now() - 40 * 86_400_000 });
    store.appendCallStart({ runId: old.runId, callNo: 1, kind: 'tool', name: 't', fingerprint: 'c'.repeat(64), occurrence: 1, origin: 'live', effect: 'read', requestRef: store.putBlob(Buffer.from(`only the old run has this ${'z'.repeat(5000)}`)), meta: {}, at: 1 });
    store.endRun(old.runId, 'completed');
    store.close();
    // Recordings whose process was killed: one months ago, which also stored a blob before the call that would have used it, and one yesterday.
    const ancient = abandonedRun(Date.now() - 90 * 86_400_000, 'stored just before the process was killed');
    const yesterday = abandonedRun(Date.now() - 86_400_000);

    let r = await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json']);
    expect(r.code, r.err).toBe(0);
    const plan = JSON.parse(r.out) as GcPlan;
    expect(plan).toMatchObject({ dryRun: true, olderThanDays: 30, keep: null, total: 5, count: 2, blobs: 2, deferred: true, recordingCount: 1, abandonedCount: 2, store: { after: null } });
    // A run its process abandoned is deleted like any other when it is old enough.
    expect(plan.runs.map((x) => x.runId)).toEqual([old.runId, ancient]);
    expect(plan.recording.map((x) => x.runId)).toEqual([live]);
    expect(plan.abandoned.map((x) => x.runId)).toEqual([ancient, yesterday]);
    expect(plan.expect).toMatch(/^2-[0-9a-f]{16}$/);
    expect(plan.cutoff).toBeGreaterThan(Date.now() - 31 * 86_400_000);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.store.before).toBeGreaterThan(0);
    expect(r.events).toEqual([{ type: 'result', data: plan }]);

    r = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(r.out).toContain(`! 2 runs were left recording by a process that stopped (${ancient.slice(0, 10)}, ${yesterday.slice(0, 10)}): gc would mark them interrupted; they hold nothing up`);
    expect(r.out).toContain('▸ runs older than 30 days: 2 of 5 · runs still recording are never touched');
    expect(r.out).toMatch(/blobs nothing would reference: 2 · \d.* · collected once no run is recording: 1 run is still recording/);
    expect(r.out).toMatch(/✓ dry run: would delete 2 runs and free .+\. To delete exactly these runs: shadowlap gc --before \d+ --expect 2-[0-9a-f]{16}/);
    const check = Store.open(dbPath());
    expect(check.getRun(old.runId)).not.toBeNull();
    expect(check.getRun(yesterday)!.status).toBe('running');
    check.close();

    // The dialog says "Delete 2 runs": the run that confirms it deletes exactly those, or nothing.
    r = await shadowlap(['gc', '--before', String(plan.cutoff), '--expect', '3-0123456789abcdef']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('the runs gc would delete changed since the dry run (2 runs, not the 3 it listed). Nothing was deleted') });
    r = await shadowlap(['gc', '--before', String(plan.cutoff), '--expect', '2-0123456789abcdef']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('(the same number of runs, but not the same ones or not the same attempts under them)') });
    r = await shadowlap(['gc', '--before', String(plan.cutoff), '--expect', '2']);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('must be the "expect" value a dry run printed') });
    r = await shadowlap(['gc', '--older-than', '30', '--before', String(plan.cutoff)]);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('give --older-than or --before, not both') });

    // A run is still recording: the old runs go, the abandoned ones are marked interrupted, and blobs wait for a gc when nothing records.
    r = await shadowlap(['gc', '--before', String(plan.cutoff), '--expect', plan.expect]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('marked interrupted');
    expect(r.out).toContain('no blobs collected: 1 run is still recording');
    expect(r.out).toMatch(/✓ deleted 2 runs · store .+ → .+/);
    expect(r.events[0]).toMatchObject({ type: 'result', data: { dryRun: false, count: 2, blobs: 0, deferred: true, abandonedCount: 2, store: { after: expect.any(Number) } } });
    const after = Store.open(dbPath());
    expect(after.getRun(old.runId)).toBeNull();
    expect(after.getRun(ancient)).toBeNull();
    // Interrupted as of its start, the last thing it recorded.
    expect(after.getRun(yesterday)).toMatchObject({ status: 'crashed', endedAt: after.getRun(yesterday)!.startedAt });
    expect(after.listEvents()[0]).toMatchObject({ kind: 'runs.cleaned', actor: 'dana', data: { runs: 2, blobs: 0, interrupted: 2, olderThanDays: null, keep: null } });
    after.endRun(live, 'completed');
    after.close();

    r = await shadowlap(['gc', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ count: 0, runs: [], blobs: 2, deferred: false, recording: [], abandonedCount: 0 });
    r = await shadowlap(['gc', '--dry-run']);
    expect(r.out).toContain('▸ no runs to delete (--older-than <days> or --keep <n> picks them)');
    // Nothing to delete and nothing to give back: no command to delete nothing with.
    expect(r.out).toContain('✓ dry run: nothing to delete or give back.');
    expect(r.out).not.toContain('--expect');
    expect(JSON.parse((await shadowlap(['gc', '--dry-run', '--json'])).out).store).toEqual({ path: dbPath(), before: expect.any(Number), after: null, free: expect.any(Number) });
  });

  it('leaves the run a replay in progress reads from, as rm does', async () => {
    const store = Store.open(dbPath());
    const old = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd }, startedAt: Date.now() - 40 * 86_400_000 });
    store.endRun(old.runId, 'completed');
    const other = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd }, startedAt: Date.now() - 40 * 86_400_000 });
    store.endRun(other.runId, 'completed');
    // `replay <old> --repeat 2`, between its attempts: this process records it.
    const replay = store.createRun({ mode: 'replay', parentRunId: old.runId, command: { argv: ['node', 'agent.js'], cwd } });
    store.close();

    let r = await shadowlap(['gc', '--keep', '1', '--dry-run', '--json']);
    const plan = JSON.parse(r.out) as GcPlan & { held: Array<{ runId: string; why: string }>; heldCount: number };
    expect(plan.runs.map((x) => x.runId)).toEqual([other.runId]);
    expect(plan.held).toEqual([expect.objectContaining({ runId: old.runId, why: 'a replay of it is still running' })]);
    expect(plan.heldCount).toBe(1);
    r = await shadowlap(['gc', '--keep', '1']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`! left ${old.runId.slice(0, 10)}: a replay of it is still running; gc deletes it once that has ended`);
    expect(r.out).toContain('✓ deleted 1 run');
    const after = Store.open(dbPath());
    expect(after.getRun(old.runId)).not.toBeNull();
    expect(after.getRun(other.runId)).toBeNull();
    // Once the replay has ended, gc deletes it.
    after.endRun(replay.runId, 'completed');
    after.close();
    expect(JSON.parse((await shadowlap(['gc', '--keep', '1', '--json'])).out)).toMatchObject({ count: 1, held: [], heldCount: 0 });
  });

  it('offers to give back what deleted runs left unused when no run is old enough, without a command that deletes runs', async () => {
    const store = Store.open(dbPath());
    // 3 MB of blobs only deleted runs used, as `rm` or the dashboard's Delete leave them, and the pages they leave unused.
    for (let i = 0; i < 3; i++) {
      const run = store.createRun({ mode: 'record', command: { argv: ['node', 'big.js'], cwd } });
      store.appendCallStart({ runId: run.runId, callNo: 1, kind: 'tool', name: 't', fingerprint: String(i).repeat(64), occurrence: 1, origin: 'live', effect: 'read', requestRef: store.putBlob(randomBytes(1024 * 1024)), meta: {}, at: 1 });
      store.endRun(run.runId, 'completed');
      store.deleteRun(run.runId);
    }
    const free = store.size().free;
    store.close();
    let r = await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json']);
    const plan = JSON.parse(r.out) as Omit<GcPlan, 'store'> & { store: { before: number; free: number; after: null } };
    expect(plan).toMatchObject({ count: 0, deferred: false });
    expect(plan.store.free).toBe(free);
    r = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(r.out).toContain('▸ runs older than 30 days: none');
    expect(r.out).toMatch(/✓ dry run: no runs to delete; would give back .+\. To do that: shadowlap gc\n/);
    expect(r.out).not.toContain('--expect');
    // While a run records, gc leaves the blobs alone: the dry run says they can be given back once it ends, and never that there is nothing.
    const recording = Store.open(dbPath());
    const live = recording.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd } });
    recording.close();
    r = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(r.out).toMatch(/✓ dry run: no runs to delete; 3\.0 MB of blobs nothing references can be given back with shadowlap gc once no run is recording\.\n/);
    expect(r.out).not.toContain('nothing to delete or give back');
    expect(r.out).not.toContain('To do that');
    const ended = Store.open(dbPath());
    ended.endRun(live.runId, 'completed');
    ended.close();
    // Plain gc deletes no run and gives it back.
    r = await shadowlap(['gc']);
    expect(r.out).toMatch(/✓ removed 3 blobs nothing referenced and compacted the store · store .+ → .+/);
    r = await shadowlap(['gc', '--json']);
    const done = JSON.parse(r.out) as { count: number; dryRun: boolean; store: { before: number; after: number; free: number } };
    expect(done).toMatchObject({ count: 0, dryRun: false });
    expect(done.store.after).toBeLessThanOrEqual(done.store.before);
  });

  it('says the unused space a recording holds up can be given back once it ends, not that there is nothing', async () => {
    const store = Store.open(dbPath());
    for (let i = 0; i < 3; i++) {
      const run = store.createRun({ mode: 'record', command: { argv: ['node', 'big.js'], cwd } });
      store.appendCallStart({ runId: run.runId, callNo: 1, kind: 'tool', name: 't', fingerprint: String(i).repeat(64), occurrence: 1, origin: 'live', effect: 'read', requestRef: store.putBlob(randomBytes(1024 * 1024)), meta: {}, at: 1 });
      store.endRun(run.runId, 'completed');
      store.deleteRun(run.runId);
    }
    // The blobs go, and their pages stay unused until a vacuum; then a run starts recording.
    store.gcBlobs();
    expect(store.size().free).toBeGreaterThan(1024 * 1024);
    const live = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd } });
    store.close();
    const r = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(r.out).toMatch(/unused space in the store: .+ · given back once no run is recording\n/);
    expect(r.out).toMatch(/✓ dry run: no runs to delete; .+ of unused space can be given back with shadowlap gc once no run is recording\.\n/);
    expect(r.out).not.toContain('nothing to delete or give back');
    const after = Store.open(dbPath());
    after.endRun(live.runId, 'completed');
    after.close();
  });

  it('keeps its report small however many runs a clean-up deletes', async () => {
    const store = Store.open(dbPath());
    const long = Array.from({ length: 40 }, (_, i) => `--option-${i}=${'v'.repeat(30)}`);
    store.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const run = store.createRun({ mode: 'record', command: { argv: ['uv', 'run', 'python', '-m', 'agent', ...long], cwd }, startedAt: Date.now() - 40 * 86_400_000 - i * 1000 });
        store.endRun(run.runId, 'completed');
      }
    });
    store.close();
    let r = await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json']);
    expect(r.code, r.err).toBe(0);
    const plan = JSON.parse(r.out) as GcPlan;
    expect(plan).toMatchObject({ count: 5000, total: 5000 });
    expect(plan.runs).toHaveLength(100);
    expect(plan.runs[0]!.command.length).toBeLessThanOrEqual(200);
    // What a dashboard job hears: well under its 1 MB limit for one event.
    expect(JSON.stringify(r.events[0]).length).toBeLessThan(64 * 1024);
    r = await shadowlap(['gc', '--before', String(plan.cutoff), '--expect', plan.expect, '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ count: 5000, total: 5000 });
    const check = Store.open(dbPath());
    expect(check.allRuns()).toEqual([]);
    check.close();
  }, 60_000);

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
    // The vacuum gives back what the blobs took; what is left is the store's schema, whatever its size.
    expect(report.store.before - report.store.after).toBeGreaterThan(0.9 * 300 * 3000);
    expect(store.size().bytes).toBe(report.store.after);
    store.close();
  });

  it('cleans up an old run with the attempts bundled under it, as rm does, and counts runs for --keep as the lists count them', async () => {
    const store = Store.open(dbPath());
    const command = { argv: ['node', 'agent.js'], cwd };
    const recorded = (startedAt: number, status: 'completed' | 'failed' = 'completed') => {
      const r = store.createRun({ mode: 'record', command, startedAt });
      store.endRun(r.runId, status);
      return r.runId;
    };
    const attempt = (parent: string, meta: Parameters<Store['createRun']>[0]['meta'], end = true) => {
      const r = store.createRun({ mode: 'replay', parentRunId: parent, command, startedAt: Date.now() - 86_400_000, ...(meta ? { meta } : {}) });
      if (end) store.endRun(r.runId, 'completed');
      return r.runId;
    };
    // A run recorded 40 days ago that blame probed yesterday: two probes and a --repeat of one, newer than any cutoff.
    const old = recorded(Date.now() - 40 * 86_400_000, 'failed');
    const probes = [1, 2].map((n) => attempt(old, { probe: { of: old, callNo: 1, passed: false }, repeat: { group: 'b1-1', attempt: n, of: 2 } }));
    const again = attempt(probes[0]!, { repeat: { group: 'again', attempt: 1, of: 1 } });
    // A run from yesterday that verify tried three times.
    const recent = recorded(Date.now() - 86_400_000);
    const verifies = [1, 2, 3].map(() => attempt(recent, { verify: { role: 'target', passed: true } }));
    store.close();

    // --keep 1 keeps the newest run as Runs lists it, with its attempts, not the newest attempt alone.
    let r = await shadowlap(['gc', '--keep', '1', '--dry-run', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ total: 2, count: 1, attempts: 3, runs: [{ runId: old }], held: [] });
    r = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(r.out).toContain('▸ runs older than 30 days: 1 of 2, with the 3 attempts bundled under it · runs still recording are never touched');
    expect(r.out).toMatch(/✓ dry run: would delete 1 run, with the 3 attempts bundled under it, and free .+\. To delete exactly these runs: shadowlap gc --before \d+ --expect 1-[0-9a-f]{16}/);
    const dry = JSON.parse((await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json'])).out) as GcPlan & { attempts: number };

    // An attempt filed under it since the dry run: what the dry run listed changed, so nothing is deleted.
    const more = Store.open(dbPath());
    const late = more.createRun({ mode: 'replay', parentRunId: old, command, meta: { verify: { role: 'target', passed: false } } });
    more.endRun(late.runId, 'completed');
    more.close();
    r = await shadowlap(['gc', '--before', String(dry.cutoff), '--expect', dry.expect]);
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('(the same number of runs, but not the same ones or not the same attempts under them)') });
    const fresh = JSON.parse((await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json'])).out) as GcPlan & { attempts: number };
    expect(fresh).toMatchObject({ count: 1, attempts: 4 });
    r = await shadowlap(['gc', '--before', String(fresh.cutoff), '--expect', fresh.expect]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/✓ deleted 1 run, with the 4 attempts bundled under it, and \d+ blobs? · store /);
    const check = Store.open(dbPath());
    // Nothing of it is left behind as a run of its own; the run kept keeps its attempts.
    expect([old, ...probes, again, late.runId].map((id) => check.getRun(id))).toEqual([null, null, null, null, null]);
    expect(verifies.map((id) => check.getRun(id)?.runId)).toEqual(verifies);
    expect(check.listEvents()[0]).toMatchObject({ kind: 'runs.cleaned', data: { runs: 1, attempts: 4 } });

    // A run blame is still probing stays, with its attempts, until the probe has ended, as rm leaves it.
    const probing = check.createRun({ mode: 'record', command, startedAt: Date.now() - 40 * 86_400_000 });
    check.endRun(probing.runId, 'failed');
    const running = check.createRun({ mode: 'replay', parentRunId: probing.runId, command, meta: { probe: { of: probing.runId, callNo: 1, passed: false }, repeat: { group: 'b2-1', attempt: 1, of: 2 } } });
    check.close();
    r = await shadowlap(['gc', '--older-than', '30']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`! left ${probing.runId.slice(0, 10)}: an attempt of it is still running; gc deletes it once that has ended`);
    const after = Store.open(dbPath());
    expect([probing.runId, running.runId].map((id) => after.getRun(id)?.runId)).toEqual([probing.runId, running.runId]);
    after.close();
  });

  it('deletes the attempts bundled under a run with it, as the dashboard does, and leaves its forks as runs', async () => {
    const { done } = seedRuns();
    const store = Store.open(dbPath());
    const replay = (parent: string, meta: Parameters<Store['createRun']>[0]['meta'], end = true) => {
      const r = store.createRun({ mode: 'replay', parentRunId: parent, command: { argv: ['node', 'agent.js'], cwd }, ...(meta ? { meta } : {}) });
      if (end) store.endRun(r.runId, 'completed');
      return r.runId;
    };
    // Blame's two probes, a --repeat of one of them, and a fork made on purpose.
    const probes = [1, 2].map((n) => replay(done, { probe: { of: done, callNo: 1, passed: false }, repeat: { group: 'p', attempt: n, of: 2 } }));
    const again = replay(probes[0]!, { repeat: { group: 'again', attempt: 1, of: 1 } });
    const fork = replay(done, undefined);
    store.close();
    let r = await shadowlap(['rm', done]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`deleted 1 run (${done.slice(0, 10)}) and the 3 attempts bundled under it;`);
    const check = Store.open(dbPath());
    // Nothing of it is left behind as a run of its own; the fork keeps its data and loses the link.
    expect([done, ...probes, again].map((id) => check.getRun(id))).toEqual([null, null, null, null]);
    expect(check.getRun(fork)?.parentRunId).toBeNull();
    // A run blame is still probing stays, with its attempts, until the probe has ended.
    const probing = check.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd } });
    check.endRun(probing.runId, 'failed');
    const running = check.createRun({ mode: 'replay', parentRunId: probing.runId, command: { argv: ['node', 'agent.js'], cwd }, meta: { probe: { of: probing.runId, callNo: 1, passed: false }, repeat: { group: 'q', attempt: 1, of: 2 } } });
    check.close();
    r = await shadowlap(['rm', probing.runId]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`left ${probing.runId.slice(0, 10)}: an attempt of it is still running; delete it once that has ended`);
    const after = Store.open(dbPath());
    expect(after.getRun(probing.runId)).not.toBeNull();
    expect(after.getRun(running.runId)).not.toBeNull();
    after.close();
  });

  it('says when rm leaves blobs for a recording to finish', async () => {
    const { done, live } = seedRuns();
    const r = await shadowlap(['rm', done]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('0 blobs, 0 B freed');
    expect(r.out).toContain(`blobs are left while a run is still recording (${live.slice(0, 10)}); shadowlap gc frees them once it ends`);
  });

  it('leaves a run in progress, and the run a replay in progress reads from, as the dashboard does', async () => {
    const { done, live } = seedRuns();
    // live is recorded by this process, which is still running: rm leaves it, and says why.
    let r = await shadowlap(['rm', live]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`left ${live.slice(0, 10)}: still recording; delete it once that has ended`);
    // A replay of done, still running here: done serves its answers, so it stays too.
    const store = Store.open(dbPath());
    const replay = store.createRun({ mode: 'replay', parentRunId: done, command: { argv: ['node', 'agent.js'], cwd } });
    store.close();
    r = await shadowlap(['rm', done, '--forks']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`left ${done.slice(0, 10)}: a replay of it is still running`);
    expect(r.err).toContain(`left ${replay.runId.slice(0, 10)}: still running`);
    const check = Store.open(dbPath());
    expect(check.getRun(done)).not.toBeNull();
    check.endRun(replay.runId, 'completed');
    check.close();
    // Once the replay has ended, both go.
    r = await shadowlap(['rm', done, '--forks']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('deleted 2 runs');
  });

  it('copies a run once it has ended, as the dashboard\'s Share does', async () => {
    const { done, live } = seedRuns();
    for (const args of [['pack', live, 'goldens/half'], ['export', 'html', live, 'half.html'], ['export', 'har', live, 'half.har'], ['export', 'otel', live, '--out', 'half.json'], ['export', 'dataset', live]]) {
      const r = await shadowlap(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toContain(`${live.slice(0, 10)} is still recording: ${args[0] === 'pack' ? 'pack' : 'export'} it once it has ended`);
    }
    expect(existsSync(join(cwd, 'goldens', 'half'))).toBe(false);
    // Picked by --all, it waits for a later export; the run that ended goes.
    const all = await shadowlap(['export', 'dataset', '--all', '--out', 'all.jsonl']);
    expect(all.code, all.err).toBe(0);
    expect(all.err).toContain('1 run is still recording, left for a later export');
    expect(readFileSync(join(cwd, 'all.jsonl'), 'utf8')).toContain(done);
    expect(readFileSync(join(cwd, 'all.jsonl'), 'utf8')).not.toContain(live);
    // Nor is it replayed, forked or calibrated: there is no end to replay to yet.
    for (const [verb, args] of [['replay', ['replay', live]], ['replay', ['replay', live, '--diverge-at', '1']], ['calibrate', ['calibrate', live]]] as const) {
      const r = await shadowlap([...args]);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toContain(`${live.slice(0, 10)} is still recording: ${verb} it once it has ended`);
    }
    // A copy with its lineage waits for every run in it: a fork that ended, of a run still recording.
    const store = Store.open(dbPath());
    const fork = store.createRun({ mode: 'replay', parentRunId: live, command: { argv: ['node', 'agent.js'], cwd } });
    store.endRun(fork.runId, 'completed');
    store.close();
    for (const args of [['pack', fork.runId, 'goldens/fork', '--lineage'], ['export', 'html', fork.runId, 'fork.html', '--lineage']]) {
      const r = await shadowlap(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toContain(`${live.slice(0, 10)}, which ${fork.runId.slice(0, 10)} was forked from, is still recording: ${args[0] === 'pack' ? 'pack' : 'export'} ${fork.runId.slice(0, 10)} with --lineage once it has ended, or without --lineage now`);
    }
    expect((await shadowlap(['pack', fork.runId, 'goldens/fork'])).code).toBe(0);
    // The team store's share link copies it too, so it waits as well (before anything is asked of the store).
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ store: 's3://team-bucket/shadowlap' }));
    const shared = await shadowlap(['share', live]);
    expect(shared.code).toBe(1);
    expect(shared.err).toContain(`${live.slice(0, 10)} is still recording: share it once it has ended`);
  });

  it('copies and replays a run whose recorder stopped without ending it: nothing will add to it', async () => {
    seedRuns();
    const left = abandonedRun(Date.now() - 60_000);
    const r = await shadowlap(['pack', left, 'goldens/left']);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(cwd, 'goldens', 'left', 'run.json'))).toBe(true);
    const replay = await shadowlap(['replay', left, '--', process.execPath, '-e', '']);
    expect(replay.code, replay.err).toBe(0);
    expect(replay.err).toContain(`replaying run`);
  });

  it('says --no-redact skipped the rules, not that there were none', async () => {
    const { done } = seedRuns();
    const plain = await shadowlap(['export', 'dataset', done, '--out', 'plain.jsonl']);
    expect(plain.err).toContain('no redaction rules in shadowlap.config.json: the dataset holds the conversations as recorded');
    expect((await shadowlap(['redact', 'add', '--pattern', 'email', '--replace', '<EMAIL>'])).code).toBe(0);
    expect((await shadowlap(['redact', 'add', '--kind', 'tool', '--path', '$.args.api_key', '--replace', '<KEY>'])).code).toBe(0);
    const skipped = (holds: string) => `--no-redact: the 2 redaction rules in shadowlap.config.json were not applied; ${holds}`;
    expect((await shadowlap(['export', 'dataset', done, '--no-redact', '--out', 'raw.jsonl'])).err).toContain(skipped('the dataset holds the conversations as recorded'));
    expect((await shadowlap(['export', 'har', done, 'raw.har', '--no-redact'])).out).toContain(skipped('the HAR holds the prompts and responses as recorded'));
    expect((await shadowlap(['export', 'html', done, 'raw.html', '--no-redact'])).out).toContain(skipped('the file holds the prompts and tool data as recorded'));
    expect((await shadowlap(['pack', done, 'raw-pack', '--no-redact'])).err).toContain(skipped('the pack holds everything the agent saw'));
    // With the rules, each says how many applied.
    expect((await shadowlap(['export', 'html', done, 'masked.html'])).out).toContain('2 redaction rules applied');
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
