// A bucket for the demo's team store: the part of the S3 API that `shadowlap store`, `push`, `pull`
// and `share` use (list, get, head, conditional put, delete, and the bucket's versioning, encryption
// and Object Lock settings), served on 127.0.0.1 and kept in memory. Signatures aren't checked: it
// stands in for a bucket only while the demo is built, and holds nothing once it ends.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startBucket(name) {
  const objects = new Map();
  let versions = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://bucket');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const send = (status, body = '', headers = {}) => {
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
        res.writeHead(status, { 'content-length': String(bytes.length), ...headers });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      };
      const error = (status, code) => send(status, xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`), { 'content-type': 'application/xml' });
      if (parts[0] !== name) return error(404, 'NoSuchBucket');
      const key = parts.slice(1).join('/');
      if (!key) {
        if (req.method !== 'GET') return error(405, 'MethodNotAllowed');
        if (url.searchParams.has('versioning')) return send(200, xml('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'), { 'content-type': 'application/xml' });
        if (url.searchParams.has('encryption')) return send(200, xml('<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>'), { 'content-type': 'application/xml' });
        if (url.searchParams.has('object-lock')) return error(404, 'ObjectLockConfigurationNotFoundError');
        const prefix = url.searchParams.get('prefix') ?? '';
        const after = url.searchParams.get('continuation-token') ?? '';
        const max = Math.min(1000, Number(url.searchParams.get('max-keys') ?? 1000));
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = keys.slice(0, max);
        const truncated = keys.length > page.length;
        const contents = page
          .map((k) => {
            const o = objects.get(k);
            return `<Contents><Key>${esc(k)}</Key><LastModified>${new Date(o.modified).toISOString()}</LastModified><ETag>${o.etag}</ETag><Size>${o.body.length}</Size></Contents>`;
          })
          .join('');
        const next = truncated ? `<NextContinuationToken>${esc(page.at(-1))}</NextContinuationToken>` : '';
        return send(200, xml(`<ListBucketResult><Name>${name}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`), { 'content-type': 'application/xml' });
      }
      const found = objects.get(key);
      switch (req.method) {
        case 'GET':
        case 'HEAD':
          if (!found) return error(404, 'NoSuchKey');
          return send(200, found.body, { 'content-type': found.type, etag: found.etag, 'last-modified': new Date(found.modified).toUTCString() });
        case 'PUT': {
          if (req.headers['if-none-match'] === '*' && found) return error(412, 'PreconditionFailed');
          if (req.headers['if-match'] && req.headers['if-match'] !== found?.etag) return error(412, 'PreconditionFailed');
          const body = Buffer.concat(chunks);
          const etag = `"${createHash('md5').update(body).digest('hex')}"`;
          objects.set(key, { body, etag, type: req.headers['content-type'] ?? 'application/octet-stream', modified: Date.now() });
          return send(200, '', { etag, 'x-amz-version-id': `v${++versions}`, 'x-amz-server-side-encryption': 'AES256' });
        }
        case 'DELETE':
          objects.delete(key);
          return send(204);
        default:
          return error(405, 'MethodNotAllowed');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint,
    objects,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
