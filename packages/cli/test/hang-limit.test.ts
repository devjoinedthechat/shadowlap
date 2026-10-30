import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HANG_MARGIN_MS, limitHangs, watch } from './hang-limit.js';

limitHangs();

describe('a command a test starts', () => {
  // A test given half a second more than the margin: its command counts as hung after half a second.
  it('is stopped as hung before its test would time out, and the test told what it printed', async () => {
    const child = spawn(process.execPath, ['-e', "console.log('waiting for nothing'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = once(child, 'exit');
    const err = await new Promise<Error>((resolve) => watch(child, 'node -e <script>', () => out, resolve));
    expect(err.message).toMatch(new RegExp(`^node -e <script> was still running after \\d+ s, ${HANG_MARGIN_MS / 1000} s before its test would time out, so it was stopped as hung\\. The end of what it printed:\\nwaiting for nothing\\n$`));
    // Stopped, not left running beside the tests after it.
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, HANG_MARGIN_MS + 500);

  it('is left alone while it runs inside its test’s time', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    let failed: Error | null = null;
    watch(child, 'node -e 0', () => '', (err) => (failed = err));
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(failed).toBeNull();
  });
});
