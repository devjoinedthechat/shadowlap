// Shadowlap network guard for Node agents. Preloaded by `shadowlap run` / `replay` / `test` through
// NODE_OPTIONS=--import so it needs no code change and no dependency. It intercepts every outbound
// TCP connection the agent process makes: the sidecar is allowed, everything else is a side effect
// Shadowlap cannot replay, so it is reported (SHADOWLAP_GUARD=warn) or refused (=block).
//
// SHADOWLAP_GUARD=off disables it; SHADOWLAP_GUARD_ALLOW=host:port,host:port whitelists targets.
import net from 'node:net';
import http from 'node:http';

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
  // its connections are not traffic that bypasses Shadowlap. It allows its server's host:port here.
  globalThis[Symbol.for('shadowlap.guard.allow')] = (key) => allowed.add(String(key));
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

  function report(key, action) {
    try {
      const req = http.request(`${url}/v1/guard`, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.SHADOWLAP_RUN_ID ? { 'x-shadowlap-run': process.env.SHADOWLAP_RUN_ID } : {}) } });
      req.on('error', () => {});
      req.on('socket', (s) => s.unref());
      req.end(JSON.stringify({ target: key, action, runtime: 'node' }));
    } catch {
      // never let the guard break the agent
    }
  }

  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = target(args);
    if (t && Number.isFinite(t.port)) {
      const key = `${t.host}:${t.port}`;
      if (!allowed.has(key)) {
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        const action = mode === 'block' ? 'blocked' : 'warned';
        if (n === 1) {
          process.stderr.write(
            mode === 'block'
              ? `[shadowlap] blocked an outbound connection to ${key}: it bypasses Shadowlap (SHADOWLAP_GUARD=block). Wrap the call as a tool, or allow it with SHADOWLAP_GUARD_ALLOW=${key}.\n`
              : `[shadowlap] warning: outbound connection to ${key} bypasses Shadowlap and is not recorded; it will run again on every replay. Wrap the call as a tool.\n`,
          );
        }
        report(key, action);
        if (mode === 'block') {
          const err = new Error(`shadowlap: blocked outbound connection to ${key} (SHADOWLAP_GUARD=block)`);
          err.code = 'ESHADOWLAP';
          process.nextTick(() => this.destroy(err));
          return this;
        }
      }
    }
    return original.apply(this, args);
  };
}
