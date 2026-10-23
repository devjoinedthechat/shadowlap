import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_NODE_MAYBE_TOO_OLD, AGENT_NODE_TOO_OLD, namesNode, nodeRefusesPreload, refusedPreload } from '../src/agent-node.js';

/**
 * An agent on a Node before 18.18 never starts under Shadowlap: that Node refuses `--import` in
 * NODE_OPTIONS, which loads the guard into it, and exits 9 before running any of the agent. Every
 * command that starts an agent says so in one line instead of a bare exit, or a summary that asks
 * whether the agent uses the Shadowlap environment. The Node here is a stand-in that refuses the
 * preload in Node 18.17's words and runs anything else on this Node.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const TS_SDK = new URL('../../sdk/dist/index.js', import.meta.url).href;
/** An agent that reads the clock through the SDK: one call to record, and to replay. */
const AGENT = `const { now } = await import(${JSON.stringify(TS_SDK)});\nconsole.log('the agent ran at', await now());\n`;
const dirs: string[] = [];
const fresh = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sl-agent-node-')));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
const home = fresh();

/** A folder holding `node`, a Node 18.17 as far as the preload goes. */
function oldNodeBin(): string {
  const bin = join(fresh(), 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), `#!/bin/sh\ncase "$NODE_OPTIONS" in *--import=*) echo "$0: --import= is not allowed in NODE_OPTIONS" >&2; exit 9;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  return bin;
}

function shadowlap(cwd: string, args: string[], path?: string): { code: number | null; out: string; stdout: string; stderr: string } {
  const env = { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: home, ...(path ? { PATH: path } : {}) };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env, timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}
const runs = (cwd: string) => JSON.parse(shadowlap(cwd, ['ls', '--json']).stdout) as Array<{ runId: string; mode: string }>;

describe("Node's refusal of the preload", () => {
  it('is read in its own words, from any Node before 18.18, and nothing else', () => {
    expect(refusedPreload('/usr/local/bin/node: --import= is not allowed in NODE_OPTIONS\n')).toBe(true);
    expect(refusedPreload('C:\\Program Files\\nodejs\\node.exe: --import= is not allowed in NODE_OPTIONS\r\n')).toBe(true);
    expect(refusedPreload('npm start\n> node agent.js\nnode: --import is not allowed in NODE_OPTIONS\n')).toBe(true);
    expect(refusedPreload('node: --max-old-space-size-x is not allowed in NODE_OPTIONS\n')).toBe(false);
    expect(refusedPreload("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/node-preload.mjs'\n")).toBe(false);
  });

  it('is asked of the Node an agent runs again, which a Node that takes the preload never loads', () => {
    const env = { ...process.env, NODE_OPTIONS: '--import=file:///nonexistent/node-preload.mjs' };
    expect(nodeRefusesPreload(process.execPath, env, tmpdir())).toBe(false);
    expect(nodeRefusesPreload('shadowlap-no-such-node', env, tmpdir())).toBe(false);
  });

  it("is the agent's own Node's answer only when the command names a Node", () => {
    expect(namesNode('node')).toBe(true);
    expect(namesNode('/opt/node18/bin/node')).toBe(true);
    expect(namesNode('C:\\Program Files\\nodejs\\node.exe')).toBe(true);
    for (const launcher of ['npx', 'npm', 'volta', './launch.sh', 'nodemon', 'python3']) expect(namesNode(launcher)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('is asked of the command when it names a Node, else of the node on its PATH', () => {
    const bin = oldNodeBin();
    const env = { ...process.env, NODE_OPTIONS: '--import=file:///x/node-preload.mjs', PATH: `${bin}${delimiter}${process.env.PATH}` };
    expect(nodeRefusesPreload(join(bin, 'node'), env, tmpdir())).toBe(true);
    expect(nodeRefusesPreload('npm', env, tmpdir())).toBe(true);
    expect(nodeRefusesPreload(process.execPath, env, tmpdir())).toBe(false);
    expect(nodeRefusesPreload('node', { ...env, NODE_OPTIONS: '' }, tmpdir())).toBe(false);
  });
});

// A stand-in Node is a shell script: Windows starts no such file by name.
describe.skipIf(process.platform === 'win32')('an agent whose Node refuses the preload', () => {
  const bin = oldNodeBin();
  const oldPath = `${bin}${delimiter}${process.env.PATH}`;
  const project = (): { dir: string; runId: string } => {
    const dir = fresh();
    writeFileSync(join(dir, 'agent.mjs'), AGENT);
    expect(shadowlap(dir, ['run', '--', 'node', 'agent.mjs']).code).toBe(0);
    return { dir, runId: runs(dir)[0]!.runId };
  };

  it('never started under run, which says why in a line, keeps no run and exits as the agent did', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'agent.mjs'), AGENT);
    const r = shadowlap(dir, ['run', '--', 'node', 'agent.mjs'], oldPath);
    expect(r.code).toBe(9);
    expect(r.stderr).toContain('--import= is not allowed in NODE_OPTIONS');
    expect(r.stderr).toContain(`✗ ${AGENT_NODE_TOO_OLD}\n`);
    expect(r.stderr).toMatch(/nothing ran, so run \w{10} is not kept/);
    expect(r.out).not.toContain('no calls were made');
    expect(r.out).not.toContain('the agent ran');
    expect(runs(dir)).toEqual([]);
  });

  it('says so under replay, and under replay --repeat, which keeps none of its attempts', () => {
    const { dir, runId } = project();
    const once = shadowlap(dir, ['replay', runId], oldPath);
    expect(once.code).toBe(9);
    expect(once.stderr).toContain(`✗ ${AGENT_NODE_TOO_OLD}\n`);
    expect(once.out).not.toContain('no calls were made');
    for (const concurrency of ['1', '2']) {
      const repeated = shadowlap(dir, ['replay', runId, '--repeat', '3', '--concurrency', concurrency], oldPath);
      expect(repeated.code).toBe(2);
      expect(repeated.stderr).toContain(`shadowlap: ${AGENT_NODE_TOO_OLD}\n`);
      expect(repeated.stderr).not.toContain('attempt 2 of 3');
    }
    expect(runs(dir).map((x) => x.runId)).toEqual([runId]);
  });

  it('fails a golden under test for that reason', () => {
    const { dir, runId } = project();
    expect(shadowlap(dir, ['pack', runId, 'goldens/hello']).code).toBe(0);
    const r = shadowlap(dir, ['test', 'goldens/hello'], oldPath);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`✗ hello: ${AGENT_NODE_TOO_OLD}\n`);
    // On a Node that takes the preload, the same golden replays and passes.
    expect(shadowlap(dir, ['test', 'goldens/hello']).code).toBe(0);
  });

  it('stops verify, which replays through the attempt runner as blame and repair do, with that line', () => {
    const { dir, runId } = project();
    const r = shadowlap(dir, ['verify', '--keeps', runId, '--attempts', '2', '--', 'node', 'agent.mjs'], oldPath);
    expect(r.code).toBe(2);
    expect(r.stderr.trimEnd().split('\n').at(-1)).toBe(`shadowlap: ${AGENT_NODE_TOO_OLD}`);
    expect(runs(dir).map((x) => x.runId)).toEqual([runId]);
  });

  it('started by a launcher that runs that Node by its path, keeps its run, and the summary says what Node printed means', () => {
    const { dir, runId } = project();
    // As `npx node@18.17.0`, `volta run` or a script would: the node on PATH takes the preload, so the one the agent got can't be asked.
    writeFileSync(join(dir, 'launch.sh'), `#!/bin/sh\nexec ${JSON.stringify(join(bin, 'node'))} "$@"\n`);
    chmodSync(join(dir, 'launch.sh'), 0o755);
    const r = shadowlap(dir, ['run', '--', './launch.sh', 'agent.mjs']);
    expect(r.code).toBe(9);
    expect(r.stderr).toContain('--import= is not allowed in NODE_OPTIONS');
    expect(r.stderr).toContain('no calls were made');
    expect(r.stderr).toContain(`  ! ${AGENT_NODE_MAYBE_TOO_OLD}\n`);
    expect(r.out).not.toContain('the agent ran');
    const once = shadowlap(dir, ['replay', runId, '--', './launch.sh', 'agent.mjs']);
    expect(once.code).toBe(9);
    expect(once.stderr).toContain(`  ! ${AGENT_NODE_MAYBE_TOO_OLD}\n`);
    // One attempt at a time, each streams to the terminal: the line comes once, under the first.
    const repeated = shadowlap(dir, ['replay', runId, '--repeat', '2', '--', './launch.sh', 'agent.mjs']);
    expect(repeated.code).toBe(1);
    expect(repeated.stderr.split(AGENT_NODE_MAYBE_TOO_OLD)).toHaveLength(2);
    expect(repeated.stderr).toContain('attempt 2 of 2');
    // An agent that exits 9 for a reason of its own looks the same: every run is kept.
    expect(runs(dir)).toHaveLength(5);
  });

  it('gets no such line when the Node asked is the one the command names', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'agent.mjs'), AGENT);
    // This Node takes the preload, and exits 9 on an option it doesn't know.
    const r = shadowlap(dir, ['run', '--', 'node', '--no-such-option', 'agent.mjs']);
    expect(r.code).toBe(9);
    expect(r.stderr).toContain('no calls were made');
    expect(r.out).not.toContain('NODE_OPTIONS');
    expect(r.out).not.toContain('too old');
  });
});
