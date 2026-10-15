import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACTION_EXPORTS, Store, storeApiRequest, type RedactionExport } from '@shadowlap/engine';

/**
 * Every way a run leaves the machine, held to what REDACTION_EXPORTS (and so the Settings page and
 * the docs) says it applies. A run carries a value for each form of rule; each export is made
 * through the CLI and searched for them. An export that starts applying rules, or a new one, fails
 * here until its entry says so.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let cwd: string;
let runId: string;

/** One value per form of rule, where the run carries it, and what replaces it. */
const VALUES = {
  // A rule without a path: every string.
  system: { value: 'alice@example.com', marker: '<EMAIL>' },
  // An api rule with a path and a pattern: a message field the dataset keeps.
  account: { value: 'ACCT-4417', marker: '<ACCT>' },
  // An api rule with a path and no pattern: a field no message carries.
  user: { value: 'user-7f3a9', marker: '<USER>' },
  // A tool rule with a path: the tool's arguments.
  key: { value: 'sk-live-5b1c', marker: '<KEY>' },
  // The model's answer, a tool's error, and the command line: rules without a path.
  answer: { value: 'bob@example.com', marker: '<EMAIL>' },
  error: { value: 'carol@example.com', marker: '<EMAIL>' },
  command: { value: 'dave@example.com', marker: '<EMAIL>' },
};

const RULES = [
  { pattern: 'email', replace: '<EMAIL>' },
  { kind: 'api', path: '$.system', pattern: '/ACCT-\\d+/', replace: '<ACCT>' },
  { kind: 'api', path: '$.metadata.user_id', replace: '<USER>' },
  { kind: 'tool', path: '$.args.api_key', replace: '<KEY>' },
];

beforeAll(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-redact-exports-')));
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ redact: RULES }, null, 2));
  const store = Store.open(join(cwd, '.shadowlap', 'shadowlap.db'));
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js', '--notify', VALUES.command.value], cwd } });
  runId = run.runId;
  const system = `You help the owner of ${VALUES.account.value}, ${VALUES.system.value}.`;
  const api = (n: number) => ({ kind: 'api' as const, name: 'POST /v1/messages', fingerprint: String(n).padStart(64, 'a'), occurrence: 1 });
  const headers = { 'content-type': 'application/json' };
  const answer = (text: string) => Buffer.from(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }));
  const first = [{ role: 'user', content: 'Send the refund note.' }];
  store.appendCallStart({ runId, callNo: 1, ...api(1), origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-test', max_tokens: 100, system, metadata: { user_id: VALUES.user.value }, messages: first }), meta: { provider: 'anthropic' }, at: 1 });
  store.appendCallEnd(api(1), { runId, callNo: 1, attempt: 0, responseRef: store.putBlob(answer(`Writing to ${VALUES.answer.value} now.`)), outcome: 'ok', meta: { provider: 'anthropic', status: 200, headers, model: 'claude-test' }, at: 2 });
  const tool = { kind: 'tool' as const, name: 'send_email', fingerprint: 'b'.repeat(64), occurrence: 1 };
  const error = { name: 'Error', message: `mailbox of ${VALUES.error.value} is full` };
  store.appendCallStart({ runId, callNo: 2, ...tool, origin: 'live', effect: 'write', requestRef: store.putJson({ args: { to: 'the owner', api_key: VALUES.key.value } }), meta: {}, at: 3 });
  store.appendCallEnd(tool, { runId, callNo: 2, attempt: 0, responseRef: store.putJson({ error: error.message }), outcome: 'error', meta: { error }, at: 4 });
  const second = [...first, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_email', input: { to: 'the owner' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: error.message, is_error: true }] }];
  store.appendCallStart({ runId, callNo: 3, ...api(3), origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'claude-test', max_tokens: 100, system, metadata: { user_id: VALUES.user.value }, messages: second }), meta: { provider: 'anthropic' }, at: 5 });
  store.appendCallEnd(api(3), { runId, callNo: 3, attempt: 0, responseRef: store.putBlob(answer('The mailbox is full; I will try later.')), outcome: 'ok', meta: { provider: 'anthropic', status: 200, headers, model: 'claude-test' }, at: 6 });
  store.endRun(runId, 'failed', 7);
  store.close();
});
afterAll(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function cli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function ok(args: string[]): Promise<string> {
  const r = await cli(args);
  expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0);
  return r.out;
}

/** Everything under a directory, as one text. */
function readTree(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? readTree(path) : readFileSync(path, 'utf8')))
    .join('\n');
}

/** Each export as the CLI makes it, read back as text. */
const EXPORTS: Record<RedactionExport['id'], () => Promise<string>> = {
  pack: async () => {
    await ok(['pack', runId, join(cwd, 'packed')]);
    return readTree(join(cwd, 'packed'));
  },
  html: async () => {
    await ok(['export', 'html', runId, join(cwd, 'run.html')]);
    return readFileSync(join(cwd, 'run.html'), 'utf8');
  },
  dataset: () => ok(['export', 'dataset', runId, '--calls', 'model']),
  otel: () => ok(['export', 'otel', runId]),
  har: () => ok(['export', 'har', runId]),
};

describe('where the redaction rules apply', () => {
  it('lists every export the CLI has', async () => {
    const help = await ok(['export', '--help']);
    const commands = [...help.slice(help.indexOf('Commands:')).matchAll(/^ {2}(\w[\w-]*)/gm)].map((m) => m[1]).filter((c) => c !== 'help');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(REDACTION_EXPORTS.map((e) => e.command), `shadowlap export ${command}`).toContain(`shadowlap export ${command}`);
    expect(Object.keys(EXPORTS).sort()).toEqual(REDACTION_EXPORTS.map((e) => e.id).sort());
  });

  for (const entry of REDACTION_EXPORTS) {
    it(`holds ${entry.command} to "${entry.applies}"`, async () => {
      const text = await EXPORTS[entry.id]();
      expect(text.length).toBeGreaterThan(0);
      const present = (Object.keys(VALUES) as Array<keyof typeof VALUES>).filter((k) => text.includes(VALUES[k].value));
      switch (entry.applies) {
        case 'all':
          // Every request, response and error is masked; the command line is copied as recorded, because a replay runs it.
          expect(present).toEqual(['command']);
          for (const k of ['system', 'account', 'user', 'key', 'answer', 'error'] as const) expect(text, k).toContain(VALUES[k].marker);
          break;
        case 'messages':
          // The conversation and the answer it keeps are masked as pack masks them, and the rest of each row by the rules without a path.
          expect(present).toEqual([]);
          for (const k of ['system', 'account', 'answer', 'error', 'command'] as const) expect(text, k).toContain(VALUES[k].marker);
          break;
        case 'attributes':
          // No prompt text at all; the command line and the error message carry the rules without a path.
          expect(present).toEqual([]);
          expect(text).not.toContain('You help the owner');
          expect(text).toContain(`--notify ${VALUES.command.marker}`);
          expect(text).toContain(`mailbox of ${VALUES.error.marker} is full`);
          break;
        case 'none':
          // Nothing is masked yet: the requests go out as recorded, which the docs and the Settings page say.
          expect(present).toEqual(expect.arrayContaining(['system', 'account', 'user']));
          break;
      }
    });
  }

  it('skips the rules with --no-redact, and stops on a rule it cannot read', async () => {
    expect(await ok(['export', 'otel', runId, '--no-redact'])).toContain(VALUES.command.value);
    expect(await ok(['export', 'dataset', runId, '--no-redact'])).toContain(VALUES.system.value);
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ redact: [...RULES, { pattern: 'emial', replace: 'x' }] }));
    try {
      for (const args of [['export', 'otel', runId], ['export', 'dataset', runId], ['export', 'html', runId, join(cwd, 'x.html')]]) {
        const r = await cli(args);
        expect(r.code, args.join(' ')).toBe(1);
        expect(r.err).toContain('shadowlap.config.json: redaction rule #5: unknown pattern "emial"');
      }
    } finally {
      writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ redact: RULES }, null, 2));
    }
  });
});
