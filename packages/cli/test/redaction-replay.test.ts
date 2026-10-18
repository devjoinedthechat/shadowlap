import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * A redacted pack still replays where it is all there is, as CI replays it (`--db :memory:`): every
 * rule `redact preview` proposes added, the card and the time a tool returned as numbers, and a rule
 * with a path on what calls got back that also names a clock read. A pack keeps what calls got back
 * for its replay, so the agent gets the numbers it acted on; `export html`, which is only read, masks
 * them.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./card-agent.mjs', import.meta.url));
const TICKET_AGENT = fileURLToPath(new URL('./ticket-agent.mjs', import.meta.url));
const CARD = '/\\b(?:\\d[ -]?){13,16}\\b/';

let mock: MockServer;
let work: string;
const dirs: string[] = [];

beforeAll(async () => {
  mock = await startMockAnthropic({
    script: ({ assistantTurns, requestNo }) => ({ message: assistantTurns === 0 ? message([toolUse('lookup_card', { customer: 'C-311' }, `toolu_${requestNo}`)], { stop_reason: 'tool_use' }) : message([text('Card ending 1111.')]) }),
  });
});
afterAll(async () => {
  await mock.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'sl-redact-replay-'));
  dirs.push(work);
});

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out, stdout }));
  });
}

async function record(): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, AGENT]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Card ending 1111.');
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

interface Remedy {
  rule: { kind?: string; name?: string; path: string; pattern?: string; replace: string };
  copies: 'all' | 'read';
}

describe('a redacted pack, replayed as CI replays it', () => {
  it('passes with every rule the preview proposes, and export html masks what the pack keeps', async () => {
    expect((await shadowlap(['redact', 'add', '--pattern', CARD, '--replace', '<CARD>'])).code).toBe(0);
    const runId = await record();
    const preview = JSON.parse((await shadowlap(['redact', 'preview', runId, '--json'])).stdout) as { rules: Array<{ unmasked: { remedies: Remedy[]; reasons: string[] } }> };
    const { remedies, reasons } = preview.rules[0]!.unmasked;
    // The card and the time the tool returned, which only a copy that is read masks; the clock read, which none does.
    expect(remedies.map((r) => [r.rule.path, r.copies])).toEqual([
      ['$.result.card', 'read'],
      ['$.result.created_at', 'read'],
    ]);
    expect(reasons).toEqual(['replay']);
    for (const r of remedies) {
      const rule = r.rule;
      const added = await shadowlap(['redact', 'add', ...(rule.kind ? ['--kind', rule.kind] : []), ...(rule.name ? ['--name', rule.name] : []), '--path', rule.path, ...(rule.pattern ? ['--pattern', rule.pattern] : []), '--replace', rule.replace]);
      expect(added.code, added.out).toBe(0);
    }
    const again = await shadowlap(['redact', 'preview', runId]);
    expect(again.out).toContain('export html, har and dataset mask it (#2, #3 already do)');

    expect((await shadowlap(['pack', runId, 'goldens/card'])).code).toBe(0);
    const ci = await shadowlap(['--db', ':memory:', 'test', 'goldens/card']);
    expect(ci.code, ci.out).toBe(0);
    expect((await shadowlap(['test', 'goldens/card'])).code).toBe(0);

    const html = await shadowlap(['export', 'html', runId, 'run.html']);
    expect(html.code, html.out).toBe(0);
    const page = readFileSync(join(work, 'run.html'), 'utf8');
    expect(page).not.toContain('4111111111111111');
    expect(page).not.toContain('1500000000000');
  }, 120_000);

  it('passes with a path rule on every result, which leaves the clock read and a pack as recorded', async () => {
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ redact: [{ path: '$.result', replace: '<HIDDEN>' }] }));
    const runId = await record();
    const preview = await shadowlap(['redact', 'preview', runId]);
    expect(preview.out).toMatch(/#1 +every call +\$\.result +whole value → <HIDDEN> +0 +a pack keeps what calls got back, since its replay hands it to the agent\n {8}export html, har and dataset mask 1 in what calls got back:/);
    expect((await shadowlap(['pack', runId, 'goldens/hidden'])).code).toBe(0);
    // The pack holds what each call got back as recorded, the clock read and the card among them.
    const blobs = readdirSync(join(work, 'goldens', 'hidden', 'blobs')).map((f) => readFileSync(join(work, 'goldens', 'hidden', 'blobs', f), 'utf8')).join('\n');
    expect(blobs).not.toContain('<HIDDEN>');
    expect(blobs).toContain('"card":4111111111111111');
    const ci = await shadowlap(['--db', ':memory:', 'test', 'goldens/hidden']);
    expect(ci.code, ci.out).toBe(0);
    // export html, which is only read, masks the tool's result (the engine's tests hold the clock read to its bytes there).
    const html = await shadowlap(['export', 'html', runId, 'run.html']);
    expect(html.code, html.out).toBe(0);
    expect(readFileSync(join(work, 'run.html'), 'utf8')).toContain('"result":{"result":"<HIDDEN>"}');
  }, 120_000);

  it('passes with a rule that matches the uuid the agent read, which every copy keeps as recorded', async () => {
    expect((await shadowlap(['redact', 'add', '--pattern', 'uuid'])).code).toBe(0);
    const recorded = await shadowlap(['run', '--', process.execPath, TICKET_AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
    const preview = await shadowlap(['redact', 'preview', runId]);
    expect(preview.out).toMatch(/#1 +every call +any string +uuid → <REDACTED> +0 +it matches only what a clock or random read returned here, which a copy leaves as it is/);
    expect(preview.out).toContain('a clock or random read stays as recorded: a replay needs it');
    expect((await shadowlap(['pack', runId, 'goldens/ticket'])).code).toBe(0);
    const blobs = readdirSync(join(work, 'goldens', 'ticket', 'blobs')).map((f) => readFileSync(join(work, 'goldens', 'ticket', 'blobs', f), 'utf8')).join('\n');
    expect(blobs).not.toContain('<REDACTED>');
    // Where the pack is all there is, the agent reads the uuid it read when it was recorded, and files the same ticket.
    const ci = await shadowlap(['--db', ':memory:', 'test', 'goldens/ticket']);
    expect(ci.code, ci.out).toBe(0);
    expect(ci.out).toMatch(/ticket: 2\/2 replayed/);
  }, 120_000);
});
