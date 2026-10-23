import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `shadowlap demo`, as `npx shadowlap demo` runs it: no key, no clone, a folder of its own, a
 * scripted model it says is scripted, and the CLI's own commands telling the refund story, from the
 * recording to the fix applied, in under a minute.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dirs: string[] = [];
const fresh = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-demo-')));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

function demo(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  // This machine's own model keys and endpoints point nowhere the demo could use: it brings its own.
  const env = { ...process.env, NO_COLOR: '1', SHADOWLAP_HOME: fresh(), ANTHROPIC_API_KEY: 'sk-ant-not-for-the-demo', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9' };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'demo', ...args], { cwd: fresh(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out: `${out}${err}`, err }));
  });
}

describe('shadowlap demo', () => {
  it('records the refund bug, replays it with nothing sent, blames it, repairs it and applies the fix it proved, in under a minute', async () => {
    const r = await demo([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("The model is scripted, not a real one: a small server on 127.0.0.1:");
    // Recorded: the agent refunds $240 against its policy, on each of the three orders above the limit.
    expect(r.out).toContain('1. Record the agent on three $240 orders and one $60 order, and label them.');
    expect(r.out).toContain('$ shadowlap run -- node agent.mjs A-1042\n');
    expect(r.out).toContain('Refunded $240 for A-1042 and emailed the customer.');
    // Replayed: every call from the recording, nothing sent.
    expect(r.out).toMatch(/✓ Replay clean: 9\/9 calls replayed \(5 api, 4 tool\), 0 upstream requests/);
    // Blamed at the model call that refunded.
    expect(r.out).toContain('⑂ The run was lost at model call #5 (3 of 5)');
    // Repaired by the scripted repairer, and proven on the failing, held-out and good runs.
    expect(r.out).toContain('repairer: openai:scripted-repairer');
    expect(r.out).toContain('✓ Fixed: Escalate refunds above the policy limit');
    expect(r.out).toContain('+ You are a support agent. Follow the refund policy: escalate every refund above the limit.');
    expect(r.out).toContain('Verified: fixes 2 of 2 target runs, 1 of 1 held-out, keeps 1 of 1 good,');
    // Applied, with the fixed runs as goldens whose test runs offline.
    expect(r.out).toContain('3 passed, 0 failed · 0 upstream requests');
    expect(r.out).toMatch(/\$ shadowlap fix apply fx-\w{10}\n/);
    expect(r.out).toMatch(/✓ fx-\w{10} applied: the patch is in the working tree,/);
    const done = /✓ Done in (\d+) s, (\d+) requests to the scripted model, none to a real one\./.exec(r.out);
    expect(done, r.out).not.toBeNull();
    expect(Number(done![1])).toBeLessThan(60);
    // Its folder is gone with it.
    const dir = /Working in (.+), a git repository removed at the end/.exec(r.out)![1]!;
    expect(existsSync(dir)).toBe(false);
  }, 180_000);

  it('keeps its folder only where --keep names a new or an empty one', async () => {
    const full = fresh();
    writeFileSync(join(full, 'notes.txt'), 'mine');
    const r = await demo(['--keep', full]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`shadowlap: --keep: ${full} is not empty; name a new folder, or an empty one\n`);
  });
});
