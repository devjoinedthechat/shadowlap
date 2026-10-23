import { request as httpRequest, STATUS_CODES, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

/**
 * WebSockets under a provider's prefix (OpenAI Realtime): tunnelled to the provider, byte for byte,
 * and never recorded. A replay can't serve one, so the run's summary names each, and an offline
 * replay refuses them (server.ts).
 */

/** Answers a WebSocket handshake with an HTTP error, in one line, and closes the connection. */
export function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = Buffer.from(`${message.replace(/[\r\n]+/g, ' ')}\n`, 'utf8');
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body.toString('utf8')}`);
}

/** The status line and headers of an upstream's answer, as it sent them (names in its own case). */
function head(res: IncomingMessage, drop: ReadonlySet<string> = new Set()): string {
  const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage || STATUS_CODES[res.statusCode ?? 502] || ''}`];
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) if (!drop.has(res.rawHeaders[i]!.toLowerCase())) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Sends the handshake the agent made to `target` (http: or https:, with its path and query) and,
 * once the upstream switches protocols, passes every byte both ways until either side closes. An
 * upstream that refuses gets its answer passed back as it came; one that can't be reached gets the
 * agent a 502. `opened` is told when the tunnel is up.
 */
export function tunnelWebSocket(client: Duplex, early: Buffer, target: URL, headers: Record<string, string>, opened?: () => void): void {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = send(target, { method: 'GET', headers: { ...headers, host: target.host } });
  let settled = false;
  const close = () => {
    if (!settled) req.destroy();
  };
  client.once('close', close);
  req.on('upgrade', (res, upstream, upstreamEarly) => {
    settled = true;
    client.off('close', close);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    if (client.destroyed) return upstream.destroy();
    client.write(Buffer.from(`${head(res)}\r\n`, 'latin1'));
    if (upstreamEarly.length) client.write(upstreamEarly);
    if (early.length) upstream.write(early);
    upstream.pipe(client);
    client.pipe(upstream);
    // A WebSocket is never half open: the side whose peer ends closes too, and the other with it.
    for (const side of [client, upstream]) side.on('end', () => side.end());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
    opened?.();
  });
  req.on('response', (res) => {
    // Refused: its answer goes back whole, with its length, and the connection closes.
    settled = true;
    client.off('close', close);
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('error', () => client.destroy());
    res.on('end', () => {
      if (client.destroyed) return;
      const body = Buffer.concat(chunks);
      client.end(Buffer.concat([Buffer.from(`${head(res, new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']))}content-length: ${body.length}\r\nconnection: close\r\n\r\n`, 'latin1'), body]));
    });
  });
  req.on('error', (err) => {
    if (settled) return;
    settled = true;
    client.off('close', close);
    refuseUpgrade(client, 502, `shadowlap could not reach ${target.host} for the WebSocket: ${err.message}`);
  });
  req.end();
}
