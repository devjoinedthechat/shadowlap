import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/** `shadowlap calibrate` through the CLI, on an agent that sends a new UUID and a random temp path every run. */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./volatile-agent.mjs', import.meta.url));

let mock: MockServer;
let cwd: string;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('triaged')]) }) });
  cwd = mkdtempSync(join(tmpdir(), 'fp-calibrate-'));
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('shadowlap calibrate', () => {
  it('finds the values an agent generates on every run, proposes normalizers, and saves them with --write', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;

    const before = await shadowlap(['replay', runId, '--strict']);
    expect(before.code, 'the replay forks before calibration').toBe(1);

    const hits = mock.requests.length;
    const proposed = await shadowlap(['calibrate']);
    expect(proposed.code, proposed.out).toBe(0);
    expect(mock.requests.length, 'calibration makes no model calls').toBe(hits);
    expect(proposed.out).toMatch(/round 1 {2}diverged at call 1 \(api POST \/v1\/messages\)/);
    expect(proposed.out).toMatch(/\+ \$\.metadata\.user_id: this looks like a UUID/);
    expect(proposed.out).toMatch(/\+ \$\.system: a value generated on each run/);
    expect(proposed.out).toMatch(/diverged at call 2 \(tool save_report\)/);
    expect(proposed.out).toMatch(/clean: 2\/2 calls replayed/);
    expect(proposed.out).toMatch(/3 normalizers make this recording replay clean/);
    expect(proposed.out).toContain("shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'");

    const written = await shadowlap(['calibrate', runId, '--write']);
    expect(written.code, written.out).toBe(0);
    const config = JSON.parse(readFileSync(join(cwd, 'shadowlap.config.json'), 'utf8')) as { normalize: Array<{ kind?: string; name?: string; path: string }> };
    expect(config.normalize.map((n) => [n.kind, n.name, n.path])).toEqual([
      ['api', undefined, '$.metadata.user_id'],
      ['api', undefined, '$.system'],
      ['tool', 'save_report', '$.args.path'],
    ]);

    const after = await shadowlap(['replay', runId, '--strict']);
    expect(after.code, after.out).toBe(0);
    expect(after.out).toMatch(/Replay clean: 2\/2 calls replayed/);
    expect((await shadowlap(['calibrate', runId])).out).toMatch(/Replays clean as it is: nothing to calibrate/);
    const json = JSON.parse((await shadowlap(['calibrate', runId, '--json'])).out) as { clean: boolean; rounds: unknown[]; normalizers: unknown[]; stopped: unknown };
    expect(json).toMatchObject({ clean: true, normalizers: [], stopped: null });
    expect(json.rounds).toHaveLength(1);

    const summaryFile = join(cwd, 'summary.json');
    const replayed = await shadowlap(['replay', runId, '--strict', '--summary-json', summaryFile]);
    expect(replayed.code, replayed.out).toBe(0);
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as { exitCode: number; summary: { divergence: unknown; byOrigin: { replayed: number } } };
    expect(summary).toMatchObject({ exitCode: 0, summary: { divergence: null, byOrigin: { replayed: 2 } } });
    const listed = JSON.parse((await shadowlap(['ls', '--json'])).out) as Array<{ runId: string; mode: string; forkedAt: unknown }>;
    expect(listed.find((r) => r.runId === runId)).toMatchObject({ mode: 'record', forkedAt: null });

    // Each search match names the command that opens it in the terminal UI.
    const found = await shadowlap(['search', 'triaged', '--run', runId]);
    expect(found.out).toMatch(new RegExp(`#(\\d+) api POST /v1/messages .*shadowlap ui ${runId} --call \\1\\n`));
    expect((await shadowlap(['ui', '--call', '2'])).out).toContain('--call needs a run');
  });
});
