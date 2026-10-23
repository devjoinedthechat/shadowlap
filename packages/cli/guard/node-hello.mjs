// Shadowlap's Node preload says it loaded: one `POST /v1/hello` per process (and per worker thread,
// which the sidecar counts as its process), after capture and the network guard have set
// themselves up. A run that made calls with no hello from any process is one the guard never
// watched, which the run's summary says, and which `--guard block` fails.
import http from 'node:http';

const url = process.env.SHADOWLAP_URL;
const HELLO = Symbol.for('shadowlap.hello');

if (url && !globalThis[HELLO]) {
  globalThis[HELLO] = true;
  const mode = process.env.SHADOWLAP_GUARD ?? 'warn';
  const body = JSON.stringify({
    runtime: 'node',
    runtimeVersion: process.versions.node,
    pid: process.pid,
    ppid: process.ppid,
    guard: globalThis.__shadowlapGuard ? mode : 'off',
    capture: globalThis.__shadowlapCapture === true,
  });
  try {
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...(process.env.SHADOWLAP_RUN_ID ? { 'x-shadowlap-run': process.env.SHADOWLAP_RUN_ID } : {}) };
    // To the sidecar directly, with an agent of its own (and the request function capture found):
    // never through a proxy an agent set up, nor on a connection the agent's own calls share.
    const request = globalThis[Symbol.for('shadowlap.request')]?.['http:'] ?? http.request;
    const req = request(`${url.replace(/\/$/, '')}/v1/hello`, { method: 'POST', agent: new http.Agent(), headers }, (res) => res.resume());
    req.on('error', () => {});
    // Held until the sidecar has it, so a process that ends at once still says it loaded, but never
    // for long: a sidecar that doesn't answer keeps no process from ending.
    req.on('socket', (socket) => setTimeout(() => socket.unref(), 1_000).unref());
    req.end(body);
  } catch {
    // never let the preload break the agent
  }
}
