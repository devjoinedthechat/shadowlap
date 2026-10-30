import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { processAlive } from '@shadowlap/engine';
import { registerAgent } from '../src/agent-registry.js';
import { runDoctor } from '../src/doctor.js';
import { discoverSidecar } from '../src/mcp.js';

/**
 * Whether a process runs, asked one way by every command (the engine's liveness.ts): a pid of 0 or
 * below is no process. process.kill(0, 0) signals the caller's own process group and kill(-1, 0)
 * every process it may signal, so both "succeed": the copies in mcp, doctor and the agent registry
 * took an active.json naming pid 0, which a cloned repository could commit, for a running sidecar.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('whether a process runs', () => {
  it('is never so for a pid of 0 or below, or one that is no whole number', () => {
    for (const pid of [0, -1, -process.pid, Number.NaN, 1.5]) expect(processAlive(pid), String(pid)).toBe(false);
    expect(processAlive(process.pid)).toBe(true);
  });

  it('is not so for a process that has ended', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    expect(processAlive(child.pid!)).toBe(false);
  });

  it('is what mcp, doctor and the agent registry go by: a file naming pid 0 is left over', () => {
    const cwd = temp('sl-alive-');
    mkdirSync(join(cwd, '.shadowlap'));
    const active = join(cwd, '.shadowlap', 'active.json');
    writeFileSync(active, JSON.stringify({ url: 'http://127.0.0.1:9/t', runId: '01ACTIVE000000000000000000', pid: 0 }));
    const skipped: string[] = [];
    expect(discoverSidecar({}, cwd, (reason) => skipped.push(reason))).toBeNull();
    expect(skipped).toEqual([`${active} is left over from a run that has ended; ignoring it`]);
    const check = runDoctor({ cwd, env: {}, version: '0.1.0', python: () => 'Python 3.12.1' }).find((c) => c.name === 'active run');
    expect(check).toMatchObject({ verdict: 'warn', detail: `${active} points at run 01ACTIVE00 from a process that is gone` });
    // An agent's registration named 0 is pruned by the next agent's, as one whose process is gone.
    const home = temp('sl-alive-home-');
    const agents = join(home, 'agents');
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    writeFileSync(join(agents, '0.json'), '{}', { mode: 0o600 });
    const registered = registerAgent(process.pid, { url: 'http://127.0.0.1:9/t', runId: '01ACTIVE000000000000000000' }, { cwd, home });
    try {
      expect(registered.file).toBe(join(agents, `${process.pid}.json`));
      expect(readdirSync(agents)).toEqual([`${process.pid}.json`]);
    } finally {
      registered.unregister();
    }
  });

  it('is asked one way: no package keeps a check of its own', () => {
    const copies: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(e.name) && /process\.kill\([^,()]+,\s*0\)/.test(readFileSync(path, 'utf8'))) copies.push(relative(ROOT, path));
      }
    };
    for (const pkg of readdirSync(join(ROOT, 'packages'))) if (existsSync(join(ROOT, 'packages', pkg, 'src'))) walk(join(ROOT, 'packages', pkg, 'src'));
    expect(copies).toEqual(['packages/engine/src/liveness.ts']);
  });
});
