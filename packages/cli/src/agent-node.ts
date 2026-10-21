import { spawnSync } from 'node:child_process';

/**
 * An agent on a Node before 18.18. Shadowlap loads the guard, in-process capture and recorded input
 * into a Node agent through `--import` in NODE_OPTIONS (guardEnv), which Node takes from 18.18 on.
 * An older one refuses it before running any of the agent: it prints `node: --import= is not
 * allowed in NODE_OPTIONS` and exits 9, Node's code for an option it refuses.
 */
export const AGENT_NODE_TOO_OLD = "the agent's Node is too old for Shadowlap's guard, which needs Node 18.18 or later";

/** Whether what an agent printed holds Node's refusal of the preload. */
export function refusedPreload(output: string): boolean {
  return /--import=? is not allowed in NODE_OPTIONS/.test(output);
}

/**
 * Whether the Node an agent's command runs refuses the preload, asked of it again: for an agent
 * whose output went to the terminal, where it can't be read. `env` is the agent's, with the preload
 * in NODE_OPTIONS. The Node is the command's own when it names one (`/opt/node18/bin/node agent.js`),
 * else the `node` the agent's PATH finds from its folder, as `npm start`, `npx tsx` or a version
 * manager's shim would. `--version` starts no code, so a Node that takes the preload loads nothing.
 */
export function nodeRefusesPreload(argv0: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const node = /^node(\.exe)?$/i.test(argv0.split(/[\\/]/).pop() ?? '') ? argv0 : 'node';
  try {
    const r = spawnSync(node, ['--version'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, windowsHide: true });
    return r.status === 9 && refusedPreload(r.stderr ?? '');
  } catch {
    return false;
  }
}
