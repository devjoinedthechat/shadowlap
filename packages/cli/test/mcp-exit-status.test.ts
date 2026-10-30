import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/mcp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mcp.js')>();
  return { ...real, runMcp: vi.fn(real.runMcp) };
});

const { main } = await import('../src/index.js');
const { exitCodeOf } = await import('../src/exit-codes.js');
const { runMcp, startMcpProxy } = await import('../src/mcp.js');

/**
 * `shadowlap mcp` ends as every command does (docs/cli.md, Exit status): 2 for what the person has
 * to fix, 1 for a host that didn't answer, and 70 for a bug, which it once reported as a bad flag.
 */
async function statusOf(args: string[]): Promise<number> {
  try {
    await main(['node', 'shadowlap', 'mcp', ...args]);
    return 0;
  } catch (err) {
    return exitCodeOf(err);
  }
}

afterEach(() => vi.mocked(runMcp).mockReset());

describe('shadowlap mcp, as an exit status', () => {
  it('exits 70 for a bug, 1 for a host that did not answer, and 2 for a usage error', async () => {
    vi.mocked(runMcp).mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'tools')"));
    expect(await statusOf(['--url', 'https://mcp.example.com/mcp'])).toBe(70);
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
    vi.mocked(runMcp).mockRejectedValueOnce(refused);
    expect(await statusOf(['--url', 'https://mcp.example.com/mcp'])).toBe(1);
    // The flags themselves, as runMcp reads them.
    const real = (await vi.importActual<typeof import('../src/mcp.js')>('../src/mcp.js')).runMcp;
    vi.mocked(runMcp).mockImplementation(real);
    expect(await statusOf(['--url', 'https://mcp.example.com/mcp', '--', 'node', 'server.js'])).toBe(2);
    expect(await statusOf(['--effect', 'send=maybe', '--', 'node', 'server.js'])).toBe(2);
  });

  // A signal Windows can't send a process: its server ends with an exit code there, not a signal.
  it.skipIf(process.platform === 'win32')('ends 128 + n when its server is killed by a signal it never got itself, as a shell reports one', async () => {
    const killed = (signal: string) => {
      const clientIn = new PassThrough();
      const { done } = startMcpProxy({ clientIn, clientOut: new PassThrough(), server: { command: process.execPath, args: ['-e', `process.kill(process.pid, '${signal}')`] }, sidecar: null });
      return done.finally(() => clientIn.end());
    };
    expect(await killed('SIGKILL')).toBe(137);
    expect(await killed('SIGTERM')).toBe(143);
    expect(await killed('SIGSEGV')).toBe(139);
  });
});
