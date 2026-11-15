// The `shadowlap mcp --listen` proxies of this user's, for the network guard (node-guard.mjs). A
// proxy records the tool calls it carries, so reaching one bypasses nothing. It registers while it
// runs, in the folder the command that started the agent names (SHADOWLAP_MCP_REGISTRY: `mcp` in
// shadowlap's home folder, ~/.shadowlap or SHADOWLAP_HOME), and the guard reads it when the agent
// connects, so a proxy started after the agent counts too. The CLI writes the files
// (src/mcp-proxies.ts), and the Python guard reads them as this does (_shadowlap_proxies.py).
//
// A registration counts only when it is this user's alone, in a folder that is too, names the process
// it is filed under, which runs, and a loopback address, and its proxy records the agent's run or
// each session's own. Even then, a connection goes through only once what answers at that address
// proves it holds the key in the registration, which its proxy alone keeps, or when nothing listens
// there, as when `localhost` names two addresses: then it fails, as it would. So one a killed proxy
// left lets no connection reach anything, even once another process has its id.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where a proxy answers a challenge (src/mcp-proxies.ts). */
const PROOF_PATH = '/.well-known/shadowlap-proxy';
/** How long a proxy, on this machine, has to answer one once connected. */
const PROOF_MS = 2_000;
/**
 * How long the connection to it may take. On this machine it is taken or refused at once, but
 * Windows tries again for about two seconds before it says refused.
 */
const CONNECT_MS = 5_000;
/** A proof's answer is a short HTTP response: more than this is not one. */
const ANSWER_MAX = 4096;

const ownUid = typeof process.getuid === 'function' ? process.getuid() : null;

/**
 * Whether a folder or file is this user's alone: of its kind, not a link, this user's, and no one
 * else's to read. Ownership and modes are POSIX ideas; Windows keeps home folders private.
 * @param {import('node:fs').Stats} st
 * @param {'dir' | 'file'} kind
 */
function alone(st, kind) {
  if (st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile())) return false;
  return ownUid === null || (st.uid === ownUid && (st.mode & 0o077) === 0);
}

/**
 * Whether a host is this machine: `localhost`, 127.0.0.0/8, or `::1`, also as an IPv4-mapped address
 * (src/loopback.ts).
 * @param {string} hostname
 */
export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return host.split('.').every((n) => Number(n) <= 255);
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host);
  return !!mapped && parseInt(/** @type {string} */ (mapped[1]), 16) >> 8 === 127;
}

/**
 * The run a sidecar's address and a run id name, as a registration names the run its proxy records
 * into (src/mcp-proxies.ts): a digest, which holds no session token.
 * @param {string} url
 * @param {string} runId
 */
export function runOf(url, runId) {
  return createHash('sha256').update(`${url.replace(/\/$/, '')}\n${runId}`).digest('hex');
}

/**
 * Whether a process with this id runs; one of another user's counts. A pid of 0 or below is none.
 * @param {number} pid
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * Whether a registration is one a proxy wrote, filed under `pid`.
 * @param {unknown} j
 * @param {number} pid
 * @returns {j is { v: 1; pid: number; host: string; port: number; key: string; run: string | null }}
 */
function registration(j, pid) {
  if (!j || typeof j !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (j);
  return r.v === 1 && r.pid === pid && typeof r.host === 'string' && isLoopbackHost(r.host) && Number.isInteger(r.port) && /** @type {number} */ (r.port) >= 1 && /** @type {number} */ (r.port) <= 65535 && typeof r.key === 'string' && /^[0-9a-f]{32}$/.test(r.key) && (r.run === null || typeof r.run === 'string');
}

/**
 * The keys of the proxies registered in `dir` that `target` (`host:port`, as the guard names a
 * connection) reaches: at each one's own address, or at `localhost` with its port. Only those
 * recording `run`, the agent's, or each session's own.
 * @param {string} dir
 * @param {string} run
 * @param {string} target
 * @returns {string[]}
 */
export function proxyKeys(dir, run, target) {
  /** @type {string[]} */
  const keys = [];
  /** @type {string[]} */
  let names;
  try {
    if (!alone(lstatSync(dir), 'dir')) return keys;
    names = readdirSync(dir);
  } catch {
    return keys;
  }
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    try {
      if (!alone(lstatSync(file), 'file')) continue;
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (!registration(j, Number(m[1])) || (j.run !== null && j.run !== run)) continue;
      if ((target === `${j.host}:${j.port}` || target === `localhost:${j.port}`) && alive(j.pid)) keys.push(j.key);
    } catch {
      // unreadable, or gone meanwhile
    }
  }
  return keys;
}

/**
 * What answers at `host:port`, asked with a challenge made for this once over a connection `connect`
 * opens (one the guard never checks): `proven` when it proves it holds one of `keys`, `nothing` when
 * nothing listens there (the connection is refused, as the agent's will be), else `unproven`.
 * @param {(options: { host: string; port: number }) => import('node:net').Socket} connect
 * @param {string} host
 * @param {number} port
 * @param {string[]} keys
 * @returns {Promise<'proven' | 'nothing' | 'unproven'>}
 */
export function proof(connect, host, port, keys) {
  const challenge = randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    /** @type {import('node:net').Socket} */
    let socket;
    try {
      socket = connect({ host, port });
    } catch {
      return resolve('unproven');
    }
    const connecting = setTimeout(() => done('unproven'), CONNECT_MS);
    /** @param {'proven' | 'nothing' | 'unproven'} answer */
    function done(answer) {
      clearTimeout(connecting);
      socket.destroy();
      resolve(answer);
    }
    socket.on('error', (/** @type {NodeJS.ErrnoException} */ err) => done(err.code === 'ECONNREFUSED' ? 'nothing' : 'unproven'));
    socket.on('data', (/** @type {Buffer} */ chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > ANSWER_MAX) done('unproven');
    });
    socket.on('end', () => done(answered(Buffer.concat(chunks).toString('latin1'), keys, challenge) ? 'proven' : 'unproven'));
    socket.on('connect', () => {
      clearTimeout(connecting);
      socket.setTimeout(PROOF_MS, () => done('unproven'));
      socket.write(`GET ${PROOF_PATH}?challenge=${challenge} HTTP/1.1\r\nHost: ${host.includes(':') ? `[${host}]` : host}:${port}\r\nConnection: close\r\n\r\n`);
    });
  });
}

/**
 * Whether an HTTP answer to `challenge` proves its sender holds one of `keys`: a 200 whose body is
 * the challenge's HMAC-SHA256 under that key (src/mcp-proxies.ts).
 * @param {string} text
 * @param {string[]} keys
 * @param {string} challenge
 */
function answered(text, keys, challenge) {
  const body = text.indexOf('\r\n\r\n');
  if (body < 0 || !/^HTTP\/1\.[01] 200 /.test(text)) return false;
  const proof = text.slice(body + 4).trim();
  return keys.some((key) => proof === createHmac('sha256', Buffer.from(key, 'hex')).update(challenge).digest('hex'));
}
