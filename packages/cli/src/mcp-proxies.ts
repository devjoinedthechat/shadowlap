import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from '@shadowlap/engine';
import { publish, safeHome, untrusted } from './agent-registry.js';
import { isLoopbackHost } from './loopback.js';

/**
 * The `shadowlap mcp --listen` proxies running for this user, for the network guard of the agents
 * Shadowlap commands start. A proxy started on its own records the tool calls of every command's
 * agents (each session into its client's run), so a connection to one bypasses nothing; yet the
 * guard lets an agent reach only what it is told, and `shadowlap test` blocks the rest. So such a
 * proxy registers its address while it runs, in `~/.shadowlap/mcp/<pid>.json`, owner-only and
 * under the folder's lock as an agent's registration is (agent-registry.ts), and a command that
 * starts agents lets them through to each it finds there (SHADOWLAP_MCP_PROXIES).
 *
 * Only a running proxy of this user's counts: a file is read only from the home folder, which no
 * repository can put one in, and only when it is the user's own, owner-only, not a link, in a folder
 * that is so too, names the process it is filed under, and that process is alive, with a loopback
 * address, the only kind a proxy serves on.
 */

const FOLDER = join('.shadowlap', 'mcp');

interface ProxyRegistration {
  v: 1;
  /** The proxy's process id: the file's name. */
  pid: number;
  /** The loopback address it serves on, as `--listen` named it, and its port. */
  host: string;
  port: number;
}

/** Registers this process as a proxy serving on `at`, until the returned function is called; `file` is null when the home folder can't take it. */
export function registerProxy(at: { host: string; port: number }, o: { home?: string | null } = {}): { unregister: () => void; file: string | null } {
  const home = o.home === undefined ? safeHome() : o.home;
  const body: ProxyRegistration = { v: 1, pid: process.pid, host: at.host, port: at.port };
  return publish(home ? [join(home, FOLDER)] : [], process.pid, JSON.stringify(body) + '\n');
}

/**
 * The addresses of this user's running proxies, as the guard names a connection (`host:port`): each
 * proxy's own, and `localhost` at its port, a name its clients reach it by too.
 */
export function liveProxies(o: { home?: string | null } = {}): string[] {
  const home = o.home === undefined ? safeHome() : o.home;
  if (!home) return [];
  const dir = join(home, FOLDER);
  let names: string[];
  try {
    if (untrusted(lstatSync(dir), dir, 'dir')) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    try {
      if (untrusted(lstatSync(file), file, 'file')) continue;
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProxyRegistration>;
      if (j.v !== 1 || j.pid !== Number(m[1]) || typeof j.host !== 'string' || !isLoopbackHost(j.host) || !Number.isInteger(j.port) || j.port! < 1 || j.port! > 65535 || !processAlive(j.pid)) continue;
      out.add(`${j.host}:${j.port!}`);
      out.add(`localhost:${j.port!}`);
    } catch {
      // unreadable, or gone meanwhile
    }
  }
  return [...out];
}
