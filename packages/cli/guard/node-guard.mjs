// Shadowlap network guard for Node agents. Preloaded by `shadowlap run` / `replay` / `test` through
// NODE_OPTIONS=--import so it needs no code change and no dependency. It intercepts every outbound
// TCP connection the agent process makes, and every UDP datagram it sends: the sidecar is allowed,
// everything else is a side effect Shadowlap cannot replay, so it is reported (SHADOWLAP_GUARD=warn)
// or refused (=block). A DNS query (UDP to port 53) is left alone: a name lookup reads nothing of the
// agent's and changes nothing, and Node's dns.lookup never comes here at all.
//
// SHADOWLAP_GUARD=off disables it; SHADOWLAP_GUARD_ALLOW=host:port,host:port whitelists targets.
import dgram from 'node:dgram';
import { readFileSync, realpathSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { dirname, join } from 'node:path';

const url = process.env.SHADOWLAP_URL;
const mode = process.env.SHADOWLAP_GUARD ?? 'warn';

if (url && mode !== 'off' && !globalThis.__shadowlapGuard) {
  globalThis.__shadowlapGuard = true;
  const sidecar = new URL(url);
  const allowed = new Set([`${sidecar.hostname}:${sidecar.port || (sidecar.protocol === 'https:' ? 443 : 80)}`]);
  if (process.env.SHADOWLAP_HTTP2_URL) {
    const h2 = new URL(process.env.SHADOWLAP_HTTP2_URL);
    allowed.add(`${h2.hostname}:${h2.port}`);
  }
  for (const item of (process.env.SHADOWLAP_GUARD_ALLOW ?? '').split(',')) if (item.trim()) allowed.add(item.trim());
  // `shadowlap mcp --url` talks to its server for the agent and records the tool calls itself, so
  // its connections are not traffic that bypasses Shadowlap: that process alone may allow its
  // server's host:port. No other process gets the hook, so an agent's code can't lift the guard.
  if (isShadowlapMcp()) globalThis[Symbol.for('shadowlap.guard.allow')] = (key) => allowed.add(String(key));
  const seen = new Map();

  function target(args) {
    // net.connect() and tls.connect() pre-normalize their arguments into [options, callback] and pass
    // that array as the single argument to socket.connect().
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      if (first.path) return null; // unix socket / pipe: local IPC, allowed
      return { host: String(first.host ?? 'localhost'), port: Number(first.port) };
    }
    if (typeof first === 'number') return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
    if (typeof first === 'string' && /^\d+$/.test(first)) return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
    return null; // a path string
  }

  // Reports go to the sidecar directly, with an agent of the guard's own: an http.globalAgent a
  // proxy package replaced would send them through its proxy. The request function is taken now,
  // before the agent's own code runs, and is the one capture found (capture loads first).
  const direct = new http.Agent();
  const request = globalThis[Symbol.for('shadowlap.request')]?.['http:'] ?? http.request;
  function report(key, action) {
    try {
      const req = request(`${String(url)}/v1/guard`, { method: 'POST', agent: direct, headers: { 'content-type': 'application/json', ...(process.env.SHADOWLAP_RUN_ID ? { 'x-shadowlap-run': process.env.SHADOWLAP_RUN_ID } : {}) } }, (res) => res.resume());
      req.on('error', () => {});
      // Held until the sidecar has it, so a connection made just before the agent exits is still
      // listed, but never for long: a sidecar that doesn't answer keeps no agent from ending.
      req.on('socket', (s) => setTimeout(() => s.unref(), 1_000).unref());
      req.end(JSON.stringify({ target: key, action, runtime: 'node' }));
    } catch {
      // never let the guard break the agent
    }
  }

  /**
   * Whether the agent may reach host:port: a connection, or with `datagram` a UDP datagram, that
   * bypasses Shadowlap is reported, and under block refused (false). A datagram is reported once per
   * target: a client that sends one per metric would otherwise report every one.
   */
  function letThrough(host, port, datagram = false) {
    const key = `${host}:${port}`;
    if (allowed.has(key)) return true;
    const reported = datagram ? `udp://${key}` : key;
    const n = (seen.get(reported) ?? 0) + 1;
    seen.set(reported, n);
    const what = datagram ? 'a UDP datagram' : 'an outbound connection';
    if (n === 1) {
      process.stderr.write(
        mode === 'block'
          ? `[shadowlap] blocked ${what} to ${key}: it bypasses Shadowlap (SHADOWLAP_GUARD=block). Wrap the call as a tool, or allow it with SHADOWLAP_GUARD_ALLOW=${key}.\n`
          : `[shadowlap] warning: ${what} to ${key} bypasses Shadowlap and is not recorded; it will run again on every replay. Wrap the call as a tool.\n`,
      );
    }
    if (!datagram || n === 1) report(reported, mode === 'block' ? 'blocked' : 'warned');
    return mode !== 'block';
  }

  const refusal = (what, key) => Object.assign(new Error(`shadowlap: blocked ${what} to ${key} (SHADOWLAP_GUARD=block)`), { code: 'ESHADOWLAP' });

  // ---- TCP: net.Socket#connect, which net, tls, http(s), http2 and fetch open their connections with ----
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = target(args);
    if (t && Number.isFinite(t.port) && !letThrough(t.host, t.port)) {
      const err = refusal('outbound connection', `${t.host}:${t.port}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return original.apply(this, args);
  };

  // ---- UDP: dgram sockets ----
  /** Where a datagram goes, or null for a DNS query or a port dgram itself refuses; an address left out is this machine's. */
  function datagramTarget(socket, port, address) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535 || p === 53) return null;
    const host = typeof address === 'string' && address ? address : socket.type === 'udp6' ? '::1' : '127.0.0.1';
    return { host, port: p };
  }
  /** Fails a refused send or connect as dgram fails one: through its callback, else with 'error'. */
  function fail(socket, callback, err) {
    process.nextTick(() => (typeof callback === 'function' ? callback(err) : socket.emit('error', err)));
  }

  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedSend(...args) {
    // send(msg[, offset, length][, port][, address][, callback]), read as dgram reads it. A connected
    // socket sends to the peer its connect() was checked for.
    let connected = false;
    try {
      connected = Boolean(this.remoteAddress());
    } catch {
      // not connected
    }
    if (!connected) {
      let [, offset, length, port, address] = args;
      if (!(address || (port && typeof port !== 'function'))) {
        port = offset;
        address = length;
      }
      const t = datagramTarget(this, port, typeof address === 'function' ? undefined : address);
      if (t && !letThrough(t.host, t.port, true)) {
        fail(this, [...args].reverse().find((a) => typeof a === 'function'), refusal('UDP datagram', `${t.host}:${t.port}`));
        return;
      }
    }
    return send.apply(this, args);
  };

  const connectDatagram = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function guardedDatagramConnect(port, address, callback) {
    const t = datagramTarget(this, port, typeof address === 'function' ? undefined : address);
    if (t && !letThrough(t.host, t.port, true)) {
      fail(this, typeof address === 'function' ? address : callback, refusal('UDP datagram', `${t.host}:${t.port}`));
      return;
    }
    return connectDatagram.apply(this, arguments);
  };
}

/** Whether this process is the Shadowlap CLI running `shadowlap mcp`. */
function isShadowlapMcp() {
  try {
    const script = process.argv[1];
    if (!script) return false;
    const real = realpathSync(script);
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(real)), 'package.json'), 'utf8'));
    if (pkg.name !== 'shadowlap' || join(dirname(dirname(real)), pkg.bin?.shadowlap ?? '') !== real) return false;
    // The command is the first argument that isn't a global option (--db takes a value).
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--db') i++;
      else if (!args[i].startsWith('-')) return args[i] === 'mcp';
    }
  } catch {
    // not a script, or not one of ours
  }
  return false;
}
