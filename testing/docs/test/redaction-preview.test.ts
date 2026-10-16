// docs/normalizers-and-redaction.md shows the commands that add its redaction rules and what
// `shadowlap redact preview` prints with them. Readers add their rules from the one and compare
// their preview with the other, so both are made real here: the page's `redact add` commands write
// the config, a store holds the run its sample describes (a clock read, a model call, a card a tool
// returns as a number and another tool is sent, a tool call that carries a key), and what the CLI
// prints for it is the page's block, run ids masked. The run's details line is held to a second run
// that has some.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, storeApiRequest, type CallKind } from '@shadowlap/engine';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const page = readFileSync(join(ROOT, 'docs', 'normalizers-and-redaction.md'), 'utf8');

/** The first fenced block after the line that starts with `lead`. */
function block(lead: string): string {
  const from = page.indexOf(`\n${lead}`);
  if (from < 0) throw new Error(`no line starting "${lead}"`);
  const m = /^```[^\n]*\n([\s\S]*?)^```/m.exec(page.slice(from));
  if (!m) throw new Error(`no code block after "${lead}"`);
  return m[1]!;
}

/** Run ids differ on every run: masked in the page and in what the CLI printed alike. Lines keep their indent. */
const mask = (text: string) => text.replace(/\b01[0-9A-HJKMNP-TV-Z]{8,24}/g, '<run>').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');

/** The `shadowlap redact add` commands under "## Redaction", as argv. */
const commands = (/^## Redaction\n[\s\S]*?^```sh\n([\s\S]*?)^```/m.exec(page)?.[1] ?? '')
  .split('\n')
  .filter((l) => l.startsWith('shadowlap redact add '))
  .map((l) => [...l.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!).slice(1));

let dir: string;
let db: string;
const cli = (args: string[]) => spawnSync(process.execPath, [CLI, '--db', db, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' } });

/** A finished run of `argv` with these calls: a request (JSON) and what it got back (stored as written). */
function recorded(store: Store, argv: string[], calls: Array<{ kind: CallKind; name: string; request: unknown; response: string }>): string {
  const run = store.createRun({ mode: 'record', command: { argv, cwd: dir } });
  calls.forEach((c, i) => {
    const id = { kind: c.kind, name: c.name, fingerprint: `${run.runId}${i}`.padEnd(64, '0'), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: i + 1, ...id, origin: 'live', effect: c.kind === 'tool' ? 'read' : null, requestRef: c.kind === 'api' ? storeApiRequest(store, c.request) : store.putJson(c.request), meta: {}, at: i + 1 });
    store.appendCallEnd(id, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putBlob(Buffer.from(c.response)), outcome: 'ok', meta: {}, at: i + 1 });
  });
  store.endRun(run.runId, 'completed');
  return run.runId;
}

let sample: string;
let details: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shadowlap-redact-preview-'));
  db = join(dir, 'store.db');
  for (const argv of commands) {
    const r = cli(argv);
    if (r.status !== 0) throw new Error(`${argv.join(' ')}\n${r.stdout}${r.stderr}`);
  }
  const store = Store.open(db);
  const system = 'You help customers. The account owner is alice@example.com.';
  const ask = { role: 'user', content: 'Refund order 4417 for bob@example.com' };
  sample = recorded(store, ['node', 'agent.js'], [
    { kind: 'clock', name: 'now', request: { label: 'now' }, response: '{"result":1792155242516}' },
    { kind: 'api', name: 'POST /v1/messages', request: { model: 'claude-sonnet-5', max_tokens: 1024, system, messages: [ask] }, response: JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'lookup_order', input: { order: '4417' } }] }) },
    { kind: 'tool', name: 'lookup_order', request: { args: { order: '4417' } }, response: '{"result": {"order": "4417", "card": 4111111111111111, "note": "paid with 4111 1111 1111 1111"}}' },
    { kind: 'tool', name: 'refund_card', request: { args: { card: 4111111111111111, amount: 42 } }, response: '{"result": {"refunded": true}}' },
    { kind: 'tool', name: 'send_email', request: { args: { api_key: 'sk-live-123', to: 'bob@example.com' } }, response: '{"result": {"sent": true}}' },
  ]);
  details = recorded(store, ['node', 'agent.js', '--customer', 'erin@example.com'], [{ kind: 'clock', name: 'now', request: { label: 'now' }, response: '{"result":1792155242600}' }]);
  store.updateRunMeta(details, { notes: [{ callNo: null, text: 'called back hank@example.com', at: 1 }] });
  store.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the redaction preview the docs show', () => {
  it('comes from the commands the page gives', () => {
    expect(commands.length).toBeGreaterThan(0);
    const listed = JSON.parse(cli(['redact', 'ls', '--json']).stdout) as { rules: unknown[] };
    expect(listed.rules).toHaveLength(commands.length);
  });

  it('is what shadowlap redact preview prints for the run it describes', () => {
    const r = cli(['redact', 'preview', sample]);
    expect(r.status, r.stderr).toBe(0);
    expect(mask(block('`shadowlap redact preview [run]`')), `docs/normalizers-and-redaction.md shows another preview than shadowlap redact preview prints:\n${r.stdout}`).toBe(mask(r.stdout));
  });

  it("shows the run's details line as the preview prints it", () => {
    const r = cli(['redact', 'preview', details]);
    expect(r.status, r.stderr).toBe(0);
    const shown = mask(block("The run's details come on a line of their own"));
    expect(`\n${mask(r.stdout)}\n`, `docs/normalizers-and-redaction.md shows another details line than shadowlap redact preview prints:\n${r.stdout}`).toContain(`\n${shown}\n`);
  });
});
