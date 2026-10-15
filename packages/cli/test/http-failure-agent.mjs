// An agent that reads a search service with fetch and with http.request, and reports how each call
// ended: what it got, or the error its client raised. The http.request call sets a timeout of its own,
// as a careful agent does, and raises its own error from it.
import http from 'node:http';

const base = process.env.SEARCH_URL;
const out = {};
try {
  const res = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'fetch' }) });
  out.fetch = { status: res.status };
} catch (err) {
  out.fetch = { error: err.name, message: err.message, cause: err.cause?.code ?? null, causeMessage: err.cause?.message ?? null };
}
out.request = await new Promise((resolve) => {
  const url = new URL(`${base}/query`);
  const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode }));
  });
  req.setTimeout(30_000, () => req.destroy(Object.assign(new Error('the search took too long'), { code: 'AGENT_TIMEOUT' })));
  req.on('error', (err) => resolve({ error: err.code, message: err.message }));
  req.end(JSON.stringify({ q: 'request' }));
});
console.log(JSON.stringify(out));
