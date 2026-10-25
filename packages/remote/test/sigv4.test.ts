import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, presignRequest, sha256Hex, signRequest, UNSIGNED_PAYLOAD, type AwsCredentials, type SignableRequest, type SigningScope } from '../src/sigv4.js';

/**
 * AWS Signature Version 4 against AWS's own published vectors: the signing test suite (29 cases,
 * header and query signing each, from the fixture), and the examples in the Amazon S3 reference,
 * which use S3's rules: the path as sent, no normalisation, the payload hash in a header.
 */

interface SuiteCase {
  name: string;
  context: {
    credentials: { access_key_id: string; secret_access_key: string; token?: string };
    region: string;
    service: string;
    timestamp: string;
    normalize: boolean;
    sign_body: boolean;
    expiration_in_seconds: number;
  };
  request: string;
  header: { canonicalRequest: string; stringToSign: string; signature: string };
  query: { canonicalRequest: string; stringToSign: string; signature: string };
}

const suite = JSON.parse(readFileSync(new URL('./fixtures/sigv4-suite.json', import.meta.url), 'utf8')) as { cases: SuiteCase[] };

/** `GET /path?query HTTP/1.1`, header lines, a blank line, the body. */
function parseRequest(text: string): { method: string; path: string; query: string; headers: Record<string, string[]>; body: string } {
  const [head, ...rest] = text.split('\n\n');
  const lines = head.split('\n');
  const first = lines.shift()!;
  const method = first.slice(0, first.indexOf(' '));
  const target = first.slice(method.length + 1, first.lastIndexOf(' HTTP/'));
  const q = target.indexOf('?');
  const headers: Record<string, string[]> = {};
  let last: string | null = null;
  for (const line of lines) {
    if (line === '') continue;
    if (/^\s/.test(line) && last) {
      headers[last][headers[last].length - 1] += `\n${line}`;
      continue;
    }
    const i = line.indexOf(':');
    const name = line.slice(0, i);
    (headers[name] ??= []).push(line.slice(i + 1));
    last = name;
  }
  return { method, path: q < 0 ? target : target.slice(0, q), query: q < 0 ? '' : target.slice(q + 1), headers, body: rest.join('\n\n') };
}

function scopeOf(c: SuiteCase): SigningScope {
  const credentials: AwsCredentials = { accessKeyId: c.context.credentials.access_key_id, secretAccessKey: c.context.credentials.secret_access_key, source: 'test' };
  if (c.context.credentials.token) credentials.sessionToken = c.context.credentials.token;
  return { region: c.context.region, service: c.context.service, date: new Date(c.context.timestamp), credentials, normalizePath: c.context.normalize };
}

describe('SigV4 against the AWS signing test suite', () => {
  it('has the cases', () => {
    expect(suite.cases.length).toBeGreaterThanOrEqual(25);
  });

  for (const c of suite.cases) {
    it(`${c.name}: header signing`, () => {
      const r = parseRequest(c.request);
      const payloadHash = sha256Hex(r.body);
      const headers: SignableRequest['headers'] = { ...r.headers, ...(c.context.sign_body ? { 'x-amz-content-sha256': payloadHash } : {}) };
      const signed = signRequest({ method: r.method, path: r.path, query: r.query, headers, payloadHash }, scopeOf(c));
      expect(signed.canonicalRequest).toBe(c.header.canonicalRequest);
      expect(signed.stringToSign).toBe(c.header.stringToSign);
      expect(signed.signature).toBe(c.header.signature);
    });

    it(`${c.name}: query signing`, () => {
      const r = parseRequest(c.request);
      const signed = presignRequest({ method: r.method, path: r.path, query: r.query, headers: r.headers, payloadHash: sha256Hex(r.body) }, scopeOf(c), c.context.expiration_in_seconds);
      expect(signed.canonicalRequest).toBe(c.query.canonicalRequest);
      expect(signed.stringToSign).toBe(c.query.stringToSign);
      expect(signed.signature).toBe(c.query.signature);
      expect(signed.query.endsWith(`X-Amz-Signature=${c.query.signature}`)).toBe(true);
    });
  }
});

describe('SigV4 with S3 rules, against the Amazon S3 reference examples', () => {
  // The example credentials and date every S3 example uses.
  const scope: SigningScope = {
    region: 'us-east-1',
    service: 's3',
    date: new Date('2013-05-24T00:00:00Z'),
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', source: 'test' },
  };

  it('GET Object, with a range', () => {
    const s = signRequest({ method: 'GET', path: '/test.txt', query: '', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 }, payloadHash: EMPTY_SHA256 }, scope);
    expect(s.add.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT Object, with a key that needs encoding', () => {
    const body = 'Welcome to Amazon S3.';
    const hash = sha256Hex(body);
    expect(hash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const s = signRequest(
      { method: 'PUT', path: '/test%24file.text', query: '', headers: { host: 'examplebucket.s3.amazonaws.com', date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': hash }, payloadHash: hash },
      scope,
    );
    expect(s.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET Bucket lifecycle: a sub-resource without a value', () => {
    const s = signRequest({ method: 'GET', path: '/', query: 'lifecycle', headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY_SHA256 }, payloadHash: EMPTY_SHA256 }, scope);
    expect(s.canonicalRequest.split('\n')[2]).toBe('lifecycle=');
    expect(s.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('GET Bucket (list objects): the query sorted', () => {
    const s = signRequest({ method: 'GET', path: '/', query: 'max-keys=2&prefix=J', headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY_SHA256 }, payloadHash: EMPTY_SHA256 }, scope);
    expect(s.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('a presigned URL', () => {
    const s = presignRequest({ method: 'GET', path: '/test.txt', query: '', headers: { host: 'examplebucket.s3.amazonaws.com' }, payloadHash: UNSIGNED_PAYLOAD }, scope, 86400);
    expect(s.signature).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(s.query).toBe(
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('the seed request of a chunked upload, path-style', () => {
    const s = signRequest(
      {
        method: 'PUT',
        path: '/examplebucket/chunkObject.txt',
        query: '',
        headers: {
          host: 's3.amazonaws.com',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
          'content-encoding': 'aws-chunked',
          'x-amz-decoded-content-length': '66560',
          'content-length': '66824',
          'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
        },
        payloadHash: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
      },
      scope,
    );
    expect(s.signature).toBe('4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9');
  });

  it('keeps an S3 path as sent: no dot segments resolved, no slashes merged', () => {
    const s = signRequest({ method: 'GET', path: '/a/./b//c', query: '', headers: { host: 'h' }, payloadHash: EMPTY_SHA256 }, scope);
    expect(s.canonicalRequest.split('\n')[1]).toBe('/a/./b//c');
  });
});
