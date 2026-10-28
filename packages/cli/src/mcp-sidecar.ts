import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Whether a process runs, as every command asks it (liveness.ts): a pid of 0 or below is none.
import { processAlive } from '@shadowlap/engine';
import { isLoopbackUrl, lookupRegistration, parentRegistration, processAncestors, type SidecarLookup, type SidecarTarget } from './agent-registry.js';

/**
 * Which sidecar a `shadowlap mcp` proxy records into: the run it was started under, found from its
 * environment, its process tree or the working directory.
 */

export type DiscoverySkip = (reason: string) => void;

/**
 * The sidecar named by the environment (set by `shadowlap run` and the commands that replay), else
 * by the file `shadowlap run` leaves in the working directory while it is active. The file lives
 * in a directory a cloned repository could have committed, so it is trusted only when it points at
 * loopback, belongs to this user, is not a symbolic link, and names a process that is still running
 * (one of this process's ancestors, when `ancestors` is known).
 */
export function discoverSidecar(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), skip: DiscoverySkip = () => {}, ancestors?: readonly number[]): SidecarTarget | null {
  if (env.SHADOWLAP_URL && env.SHADOWLAP_RUN_ID) {
    if (isLoopbackUrl(env.SHADOWLAP_URL)) return { url: env.SHADOWLAP_URL.replace(/\/$/, ''), runId: env.SHADOWLAP_RUN_ID };
    skip(`SHADOWLAP_URL ${env.SHADOWLAP_URL} is not a loopback address; ignoring it`);
  }
  const file = join(cwd, '.shadowlap', 'active.json');
  if (!existsSync(file)) return null;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return (skip(`${file} is not a regular file; ignoring it`), null);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return (skip(`${file} belongs to another user; ignoring it`), null);
    const j = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown; runId?: unknown; pid?: unknown };
    if (typeof j.url !== 'string' || typeof j.runId !== 'string' || typeof j.pid !== 'number') return (skip(`${file} is incomplete; ignoring it`), null);
    if (!isLoopbackUrl(j.url)) return (skip(`${file} points at ${j.url}, which is not loopback; ignoring it`), null);
    if (!processAlive(j.pid)) return (skip(`${file} is left over from a run that has ended; ignoring it`), null);
    if (ancestors && !ancestors.includes(j.pid)) return (skip(`${file} belongs to a run this process was not started by; ignoring it`), null);
    return { url: j.url.replace(/\/$/, ''), runId: j.runId };
  } catch {
    return (skip(`${file} is unreadable; ignoring it`), null);
  }
}

/**
 * The run this proxy records into. The environment, when the client passed it on; else the
 * registration of the nearest ancestor Shadowlap started (see agent-registry.ts), which is how a
 * proxy started with a minimal environment under `shadowlap test`, `blame`, `verify` or
 * `replay --repeat` finds its run; else, where the process tree can't be read, the active run's
 * file in the working directory. On Windows, where the tree takes PowerShell (seconds on a busy
 * machine), the parent's registration is looked for first: an agent whose own MCP client started
 * the proxy is found without the tree.
 */
export async function findSidecar(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), skip: DiscoverySkip = () => {}, o: { home?: string | null; waitMs?: number; platform?: NodeJS.Platform } = {}): Promise<SidecarLookup> {
  if (env.SHADOWLAP_URL) {
    // Without a run id, as a test runner's host sets it (a slot's URL), the URL itself picks the run, as for the SDKs.
    if (isLoopbackUrl(env.SHADOWLAP_URL)) return { kind: 'sidecar', target: { url: env.SHADOWLAP_URL.replace(/\/$/, ''), runId: env.SHADOWLAP_RUN_ID ?? '' }, from: 'SHADOWLAP_URL' };
    skip(`SHADOWLAP_URL ${env.SHADOWLAP_URL} is not a loopback address; ignoring it`);
  }
  if ((o.platform ?? process.platform) === 'win32') {
    const direct = parentRegistration({ cwd, skip, ...(o.home !== undefined ? { home: o.home } : {}) });
    if (direct) return direct;
  }
  const chain = processAncestors(skip);
  const registered = await lookupRegistration({ cwd, chain, skip, ...(o.home !== undefined ? { home: o.home } : {}), ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}) });
  if (registered.kind !== 'none' || chain) return registered;
  const active = discoverSidecar({}, cwd, skip);
  return active ? { kind: 'sidecar', target: active, from: join(cwd, '.shadowlap', 'active.json') } : { kind: 'none' };
}
