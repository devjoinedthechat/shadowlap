// A scripted stand-in for the cloud model APIs Shadowlap captures in-process: Amazon Bedrock
// (InvokeModel, InvokeModelWithResponseStream, Converse, ConverseStream, with AWS event streams),
// Vertex AI (Anthropic rawPredict/streamRawPredict, Gemini generateContent) and Azure OpenAI (chat
// completions, JSON and SSE). Replies echo the last user message, so a changed prompt changes the answer.
//
// Bedrock requests must carry a valid AWS Signature Version 4 for the host the client signed for
// (bedrock-runtime.<region>.amazonaws.com), checked with the test secret: the proof that capture
// forwards a signed request unchanged. Failures are counted and answered with 403.
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import { createServer as createTcpServer } from 'node:net';
import { crc32 } from 'node:zlib';

export const AWS = { accessKeyId: 'AKIDSHADOWLAPTEST', secretAccessKey: 'shadowlap-test-secret', region: 'us-east-1' };
export const SIGNED_HOST = `bedrock-runtime.${AWS.region}.amazonaws.com`;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** SigV4 verification of a request as received, against the host it was signed for. */
function verifySigV4(req, path, query, body) {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return `no SigV4 authorization header (${auth.slice(0, 40)})`;
  const [, keyId, date, region, service, signedHeaders, signature] = m;
  if (keyId !== AWS.accessKeyId) return `unexpected access key ${keyId}`;
  const amzDate = req.headers['x-amz-date'];
  // Non-S3 services URI-encode the path as it is sent: a raw ":" signs as %3A, an already-encoded %3A as %253A.
  const canonicalUri = path.split('/').map((segment) => rfc3986(segment)).join('/');
  const canonicalQuery = [...new URLSearchParams(query)].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const names = signedHeaders.split(';');
  const canonicalHeaders = names
    .map((name) => {
      // Over HTTP/1.1 the signed host is Host; over HTTP/2 the client signs :authority, which arrives as sent.
      const value = name === 'host' ? SIGNED_HOST : name === 'content-length' ? String(body.length) : String(req.headers[name] ?? '');
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const payloadHash = req.headers['x-amz-content-sha256'] && req.headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD' ? req.headers['x-amz-content-sha256'] : sha256(body);
  if (req.headers['x-amz-content-sha256'] && req.headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD' && req.headers['x-amz-content-sha256'] !== sha256(body)) return 'the body does not match x-amz-content-sha256';
  const canonical = [req.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${AWS.secretAccessKey}`, date), region), service), 'aws4_request');
  const expected = createHmac('sha256', key).update(toSign).digest('hex');
  return expected === signature ? null : `signature mismatch\n${canonical}`;
}

/** One AWS event stream message, with its prelude and message CRCs. */
function eventFrame(headers, payload) {
  const parts = Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name);
    const v = Buffer.from(value);
    const b = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    b.writeUInt8(n.length, 0);
    n.copy(b, 1);
    b.writeUInt8(7, 1 + n.length);
    b.writeUInt16BE(v.length, 2 + n.length);
    v.copy(b, 4 + n.length);
    return b;
  });
  const headerBytes = Buffer.concat(parts);
  const body = Buffer.from(payload);
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(12 + headerBytes.length + body.length + 4, 0);
  prelude.writeUInt32BE(headerBytes.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude), 0);
  const message = Buffer.concat([prelude, preludeCrc, headerBytes, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(message), 0);
  return Buffer.concat([message, messageCrc]);
}

function lastUserText(body) {
  const messages = body.messages ?? body.contents ?? [];
  const last = [...messages].reverse().find((m) => m.role === 'user') ?? {};
  const content = last.content ?? last.parts ?? '';
  if (typeof content === 'string') return content;
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join('');
}

const anthropicEvents = (text) => [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...text.match(/.{1,6}/g).map((chunk) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];
const anthropicMessage = (text) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 5 } });

export async function startCloudMock() {
  // `seen`: each request's method and URL (path and query), for a test to say where a request went.
  const stats = { requests: 0, http2Requests: 0, signaturesOk: 0, signatureFailures: [], seen: [] };
  const handler = (req, res) => {
    if (req.httpVersionMajor === 2) stats.http2Requests++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      stats.requests++;
      stats.seen.push({ method: req.method, url: req.url });
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://mock');
      const path = req.url.split('?')[0];
      let body = {};
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        // not JSON
      }
      const reply = `echo: ${lastUserText(body)}`;
      const json = (status, value, extra = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify(value));
      };

      // ---- Bedrock ----
      const bedrock = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|converse|converse-stream)$/.exec(path);
      if (bedrock) {
        const problem = verifySigV4(req, path, url.search.slice(1), raw);
        if (problem) {
          stats.signatureFailures.push(problem);
          return json(403, { message: `The request signature we calculated does not match the signature you provided: ${problem.split('\n')[0]}` });
        }
        stats.signaturesOk++;
        const op = bedrock[2];
        const stream = { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'req-1' };
        if (op === 'invoke') return json(200, anthropicMessage(reply), { 'x-amzn-requestid': 'req-1' });
        if (op === 'converse') return json(200, { output: { message: { role: 'assistant', content: [{ text: reply }] } }, stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 }, metrics: { latencyMs: 10 } });
        res.writeHead(200, stream);
        if (op === 'invoke-with-response-stream') {
          for (const event of anthropicEvents(reply)) res.write(eventFrame({ ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' }, JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') })));
        } else {
          const events = [
            ['messageStart', { role: 'assistant' }],
            ...reply.match(/.{1,6}/g).map((t) => ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: t } }]),
            ['contentBlockStop', { contentBlockIndex: 0 }],
            ['messageStop', { stopReason: 'end_turn' }],
            ['metadata', { usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 }, metrics: { latencyMs: 10 } }],
          ];
          for (const [type, payload] of events) res.write(eventFrame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, JSON.stringify(payload)));
        }
        return res.end();
      }

      // ---- Vertex AI ----
      const vertexAnthropic = /\/publishers\/anthropic\/models\/([^/:]+):(rawPredict|streamRawPredict)$/.exec(path);
      if (vertexAnthropic) {
        if (!/^Bearer /.test(req.headers.authorization ?? '')) return json(401, { error: { message: 'no bearer token' } });
        if (vertexAnthropic[2] === 'rawPredict') return json(200, anthropicMessage(reply));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of anthropicEvents(reply)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        return res.end();
      }
      const vertexGemini = /\/publishers\/google\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(path);
      if (vertexGemini) {
        if (!req.headers['x-goog-api-key'] && !/^Bearer /.test(req.headers.authorization ?? '')) return json(401, { error: { message: 'no credentials' } });
        return json(200, { candidates: [{ content: { role: 'model', parts: [{ text: reply }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 } });
      }

      // ---- Azure OpenAI, and plain OpenAI-compatible chat completions (a local model server) ----
      const azure = /^\/openai\/deployments\/([^/]+)\/chat\/completions$/.exec(path);
      const compatible = path === '/v1/chat/completions';
      if (azure || compatible) {
        if (azure && (!req.headers['api-key'] || !url.searchParams.get('api-version'))) return json(401, { error: { message: 'api-key and api-version are required' } });
        const base = { id: 'chatcmpl-1', created: 0, model: azure ? azure[1] : body.model };
        if (!body.stream) return json(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const t of reply.match(/.{1,6}/g)) res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\ndata: [DONE]\n\n`);
        return res.end();
      }

      json(404, { error: { message: `mock: no route for ${req.method} ${path}` } });
    });
  };
  // HTTP/1.1 and cleartext HTTP/2 on one port, told apart by the HTTP/2 connection preface.
  const h1 = createServer(handler);
  const h2 = createHttp2Server(handler);
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('readable', () => {
      const head = socket.read(3);
      if (!head) return h1.emit('connection', socket);
      socket.unshift(head);
      (head.toString('latin1') === 'PRI' ? h2 : h1).emit('connection', socket);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(r);
      }),
  };
}
