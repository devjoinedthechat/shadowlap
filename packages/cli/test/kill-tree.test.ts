import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { killTree } from '../src/kill-tree.js';

/**
 * Stopping an agent and what it started: a process group on macOS and Linux, the process tree on
 * Windows (taskkill /T /F), since a signal there ends one process and leaves its children running.
 */

/** A child process as killTree sees it, recording what was done to it. */
function fake(o: { pid?: number; exited?: boolean } = {}): ChildProcess & { killed: string[] } {
  const killed: string[] = [];
  return { pid: o.pid ?? 4242, exitCode: o.exited ? 0 : null, signalCode: null, kill: (sig: string) => (killed.push(sig), true), killed } as unknown as ChildProcess & { killed: string[] };
}

describe('killTree', () => {
  it('ends the whole tree on Windows while the agent runs, and the agent alone when taskkill can’t', () => {
    const asked: number[] = [];
    const child = fake();
    killTree(child, 'SIGTERM', { platform: 'win32', taskkill: (pid) => (asked.push(pid), true) });
    expect(asked).toEqual([4242]);
    expect(child.killed).toEqual([]);
    // taskkill missing or refused: the process Node started, as before.
    const alone = fake();
    killTree(alone, 'SIGTERM', { platform: 'win32', taskkill: () => false });
    expect(alone.killed).toEqual(['SIGTERM']);
    // Once the agent has exited its children can't be found from it, and a process id may be reused: nothing is asked of taskkill.
    const gone = fake({ exited: true });
    killTree(gone, 'SIGKILL', { platform: 'win32', taskkill: (pid) => (asked.push(pid), true) });
    expect(asked).toEqual([4242]);
  });

  it('signals the process alone elsewhere when it has no group of its own', () => {
    const child = fake();
    killTree(child, 'SIGTERM', { platform: 'linux', taskkill: () => true });
    expect(child.killed).toEqual(['SIGTERM']);
  });

  it.skipIf(process.platform === 'win32')('signals the group an agent leads, which reaches what it started', async () => {
    // node starts a child of its own, in the group, that keeps running until it is killed.
    const agent = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); console.log('started'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve) => agent.stdout!.once('data', () => resolve()));
    const exited = new Promise<void>((resolve) => agent.once('exit', () => resolve()));
    killTree(agent, 'SIGKILL', { group: true });
    await exited;
    // Nothing is left in the group: signalling it soon finds no process (the system reaps the child Node didn't start).
    const empty = async () => {
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(-agent.pid!, 0);
        } catch (err) {
          return (err as NodeJS.ErrnoException).code;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return 'still running';
    };
    expect(await empty()).toBe('ESRCH');
  });

  it('never throws for a process that is already gone', () => {
    const child = { pid: 2 ** 22 - 7, exitCode: null, signalCode: null, kill: () => { throw new Error('ESRCH'); } } as unknown as ChildProcess;
    expect(() => killTree(child, 'SIGTERM', { group: true })).not.toThrow();
    expect(() => killTree(child, 'SIGTERM', { platform: 'win32', taskkill: () => false })).not.toThrow();
  });
});
