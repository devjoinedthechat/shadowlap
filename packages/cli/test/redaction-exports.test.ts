import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACTION_EXPORTS, Store, storeApiRequest, type RedactionExport } from '@shadowlap/engine';

/**
 * Every way a run leaves the machine, held to what REDACTION_EXPORTS (and so the Settings page and
 * the docs) says it does. A run carries a value for each form of rule and for each of its own
 * details; each export is made through the CLI and searched for them. A new export fails here until
 * it has an entry.
 *
 * REDACTION_EXPORTS describes decision 6 as the merged product has it. An export another slice adds
 * (`export pairs`) is checked once the CLI has it, and one whose rules another slice is adding
 * (`export har`, E9) once it takes `--no-redact`, which every export that applies the rules takes.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let cwd: string;
let runId: string;

/** One value per form of rule and per detail of the run, and what replaces it. */
const VALUES = {
  // A rule without a path: every string.
  system: { value: 'alice@example.com', marker: '<EMAIL>' },
  // An api rule with a path and a pattern: a message field the dataset keeps.
  account: { value: 'ACCT-4417', marker: '<ACCT>' },
  // An api rule with a path and no pattern: a field no message carries.
  user: { value: 'user-7f3a9', marker: '<USER>' },
  // A tool rule with a path: the tool's arguments.
  key: { value: 'sk-live-5b1c', marker: '<KEY>' },
  // The model's answer and a tool's error: rules without a path.
  answer: { value: 'bob@example.com', marker: '<EMAIL>' },
  error: { value: 'carol@example.com', marker: '<EMAIL>' },
  // The run's details: its command line, a label and a note.
  command: { value: 'dave@example.com', marker: '<EMAIL>' },
  label: { value: 'erin@example.com', marker: '<EMAIL>' },
  note: { value: 'hank@example.com', marker: '<EMAIL>' },
};
type Value = keyof typeof VALUES;

const RULES = [
  { pattern: 'email', replace: '<EMAIL>' },
  { kind: 'api', path: '$.system', pattern: '/ACCT-\\d+/', replace: '<ACCT>' },
  { kind: 'api', path: '$.metadata.user_id', replace: '<USER>' },
  { kind: 'tool', path: '$.args.api_key', replace: '<KEY>' },
];

/**
 * What each export, made from that run, must hold: the values it carries as recorded, and those it
 * carries masked. Anything in neither list it must not carry at all.
 */
const EXPECT: Record<RedactionExport['id'], { kept: Value[]; masked: Value[] } | null> = {
  // Every request, response and error masked; the command line, labels and notes as recorded, since a replay runs the command.
  pack: { kept: ['command', 'label', 'note'], masked: ['system', 'account', 'user', 'key', 'answer', 'error'] },
  // Everything, the run's details too: the file is read, never replayed.
  html: { kept: [], masked: ['system', 'account', 'user', 'key', 'answer', 'error', 'command', 'label', 'note'] },
  // The model calls only, whole requests and responses: no tool calls, no command line.
  har: { kept: [], masked: ['system', 'account', 'user', 'answer'] },
  // The conversation (the tool's error is in it as a result) and the answer, then each row's command line, labels and notes.
  dataset: { kept: [], masked: ['system', 'account', 'answer', 'error', 'command', 'label', 'note'] },
  // Pairs come from blame, verify and --repeat attempts, which this run has none of: training's own tests hold them to decision 6.
  pairs: null,
  // No prompt text: the command line and the error message, masked.
  otel: { kept: [], masked: ['command', 'error'] },
};

/** Each export as the CLI makes it, read back as text. */
const MAKE: Record<RedactionExport['id'], () => Promise<string>> = {
  pack: async () => {
    await ok(['pack', runId, join(cwd, 'packed')]);
    return readTree(join(cwd, 'packed'));
  },
  html: async () => {
    await ok(['export', 'html', runId, join(cwd, 'run.html')]);
    return readFileSync(join(cwd, 'run.html'), 'utf8');
  },
  // Response bodies travel base64-encoded in a HAR: read them as text too, or an answer that leaks would go unseen.
  har: async () => {
    const out = await ok(['export', 'har', runId]);
    const har = JSON.parse(out) as { log: { entries: Array<{ response: { content: { text?: string; encoding?: string } } }> } };
    const bodies = har.log.entries.map((e) => (e.response.content.encoding === 'base64' ? Buffer.from(e.response.content.text ?? '', 'base64').toString('utf8') : ''));
    return [out, ...bodies].join('\n');
  },
  dataset: () => ok(['export', 'dataset', runId, '--calls', 'model']),
  pairs: () => ok(['export', 'pairs']),
  otel: () => ok(['export', 'otel', runId]),
};

/** The CLI's help for a command, as this build has it. */
function help(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args, '--help'], { encoding: 'utf8', env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' } });
}
const EXPORT_HELP = help(['export']);
/** `shadowlap export <name>` commands this build has. */
const EXPORTS = [...EXPORT_HELP.slice(EXPORT_HELP.indexOf('Commands:')).matchAll(/^ {2}(\w[\w-]*)/gm)].map((m) => m[1]!).filter((c) => c !== 'help');
const argsOf = (e: RedactionExport) => (e.id === 'pack' ? ['pack'] : ['export', e.id]);
const inThisBuild = (e: RedactionExport) => e.id === 'pack' || EXPORTS.includes(e.id);
const appliesRules = (e: RedactionExport) => inThisBuild(e) && help(argsOf(e)).includes('--no-redact');
/** Exports whose rules another slice is adding, so this build may not apply them yet. */
const PENDING: Partial<Record<RedactionExport['id'], string>> = { har: 'E9, export har applying the rules' };

beforeAll(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-redact-exports-')));
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ redact: RULES }, null, 2));
  const store = Store.open(join(cwd, '.shadowlap', 'shadowlap.db'));
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js', '--notify', VALUES.command.value], cwd } });
  runId = run.runId;
  store.updateRunMeta(runId, { labels: [VALUES.label.value], notes: [{ callNo: null, text: `called back ${VALUES.note.value}`, at: 1 }] });
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

describe('where the redaction rules apply', () => {
  it('lists every export the CLI has, and each export it lists applies the rules', () => {
    expect(EXPORTS.length).toBeGreaterThan(0);
    for (const command of EXPORTS) expect(REDACTION_EXPORTS.map((e) => e.command), `shadowlap export ${command}`).toContain(`shadowlap export ${command}`);
    expect(Object.keys(EXPECT).sort()).toEqual(REDACTION_EXPORTS.map((e) => e.id).sort());
    // Only an export another slice is still adding rules to may lack them in this build.
    for (const e of REDACTION_EXPORTS.filter(inThisBuild)) if (!PENDING[e.id]) expect(appliesRules(e), e.command).toBe(true);
  });

  for (const entry of REDACTION_EXPORTS) {
    const expected = EXPECT[entry.id];
    const pending = appliesRules(entry) ? null : (PENDING[entry.id] ?? (inThisBuild(entry) ? null : `${entry.command}, which another slice adds`));
    it.skipIf(expected === null || pending !== null)(`holds ${entry.command} to "${entry.applies}", details ${entry.details}${pending ? ` (once this build has ${pending})` : ''}`, async () => {
      const text = await MAKE[entry.id]();
      expect(text.length).toBeGreaterThan(0);
      const present = (Object.keys(VALUES) as Value[]).filter((k) => text.includes(VALUES[k].value));
      expect(present.sort()).toEqual([...expected!.kept].sort());
      for (const k of expected!.masked) expect(text, k).toContain(VALUES[k].marker);
      // The run's details as the entry says.
      if (entry.details === 'kept') expect(present).toContain('command');
      if (entry.details === 'masked') expect(text).toContain(`--notify ${VALUES.command.marker}`);
      if (entry.details === 'absent') expect(text).not.toContain('--notify');
      if (entry.applies === 'attributes') expect(text).not.toContain('You help the owner');
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
