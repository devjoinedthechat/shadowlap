import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { emitJobEvent } from '../src/job-events.js';

describe('emitJobEvent', () => {
  it('does nothing outside a dashboard job', () => {
    expect(() => emitJobEvent({ type: 'run', runId: 'x' }, {})).not.toThrow();
    expect(() => emitJobEvent({ type: 'run', runId: 'x' }, { SHADOWLAP_EVENTS_FD: '1' })).not.toThrow();
    expect(() => emitJobEvent({ type: 'run', runId: 'x' }, { SHADOWLAP_EVENTS_FD: '99' })).not.toThrow();
  });

  it('writes one JSON line per event to the descriptor the dashboard names', async () => {
    const script = `
      import { emitJobEvent } from ${JSON.stringify(new URL('../src/job-events.ts', import.meta.url).pathname)};
      emitJobEvent({ type: 'run', runId: '01K5CQ4N7G0000000000000000', role: 'new' });
      emitJobEvent({ type: 'link', label: 'Open fix', href: '#/fixes/fx-1' });
      console.log('human output stays on stdout');
    `;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, SHADOWLAP_EVENTS_FD: '3' },
    });
    const chunks: Buffer[] = [];
    const out: Buffer[] = [];
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c));
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { type: 'run', runId: '01K5CQ4N7G0000000000000000', role: 'new' },
      { type: 'link', label: 'Open fix', href: '#/fixes/fx-1' },
    ]);
    expect(Buffer.concat(out).toString('utf8')).toContain('human output stays on stdout');
  });
});
