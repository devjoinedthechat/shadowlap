import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { publish, safeHome, type SidecarTarget } from './agent-registry.js';

/**
 * The `shadowlap mcp --listen` proxies running for this user, for the network guard of the agents
 * Shadowlap commands start. A proxy records the tool calls it carries, so a connection to one bypasses
 * nothing; yet the guard lets an agent reach only what it is told, and `shadowlap test` blocks the
 * rest. So a proxy registers its address while it runs, in `~/.shadowlap/mcp/<pid>.json`, owner-only
 * and under the folder's lock as an agent's registration is (agent-registry.ts). Every agent a
 * Shadowlap command starts is told the folder (SHADOWLAP_MCP_REGISTRY), and its guard reads it when the
 * agent connects (guard/node-proxies.mjs, guard/_shadowlap_proxies.py), so a proxy started after the
 * agent, by the agent's own command say, counts too.
 *
 * A registration counts only while its proxy is there to prove it: it holds a key the proxy keeps, and
 * the guard lets a connection through once what answers at the address it names proves it holds that
 * key (PROOF_PATH), or when nothing listens there, so the connection fails as it would. So one a killed
 * proxy left lets no connection reach anything, even after its process id is given to another process.
 * A proxy started on its own records each session into its client's run, so it lets every agent
 * through; one started under a Shadowlap command records into that command's run, so it lets only that
 * run's agents through (`run`).
 */

const FOLDER = join('.shadowlap', 'mcp');

/** Where a proxy answers a guard's challenge with proofOf, `?challenge=<hex>`. */
export const PROOF_PATH = '/.well-known/shadowlap-proxy';

interface ProxyRegistration {
  v: 1;
  /** The proxy's process id: the file's name. */
  pid: number;
  /** The loopback address it serves on, as `--listen` named it, and its port. */
  host: string;
  port: number;
  /** What it proves it holds (proofOf): 32 hex digits, in its registration and its memory alone. */
  key: string;
  /** The run it records every session into, as runOf names it; null when each session's is its client's. */
  run: string | null;
}

/** The folder this user's proxies register in: the home folder's `.shadowlap/mcp`, or null without a home folder. */
export function proxyFolder(o: { home?: string | null } = {}): string | null {
  const home = o.home === undefined ? safeHome() : o.home;
  return home ? join(home, FOLDER) : null;
}

/** A key for a proxy to prove itself with: its registration's, kept in the proxy's memory too. */
export function proxyKey(): string {
  return randomBytes(16).toString('hex');
}

/** A proxy's answer to a guard's `challenge`: its HMAC-SHA256 under the proxy's key, in hex. */
export function proofOf(key: string, challenge: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(challenge).digest('hex');
}

/** The run a sidecar's address and a run id name, as a registration and the guard name it: a digest, which holds no session token. */
export function runOf(target: SidecarTarget): string {
  return createHash('sha256').update(`${target.url.replace(/\/$/, '')}\n${target.runId}`).digest('hex');
}

/**
 * Registers this process as a proxy serving on `at` that proves itself with `key`, recording into
 * `run` or, with null, each session's own, until the returned function is called; `file` is null when
 * the home folder can't take it.
 */
export function registerProxy(at: { host: string; port: number }, o: { key: string; run: SidecarTarget | null; home?: string | null }): { unregister: () => void; file: string | null } {
  const dir = proxyFolder(o);
  const body: ProxyRegistration = { v: 1, pid: process.pid, host: at.host, port: at.port, key: o.key, run: o.run ? runOf(o.run) : null };
  return publish(dir ? [dir] : [], process.pid, JSON.stringify(body) + '\n');
}
