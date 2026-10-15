import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkStore, isPrecondition, openObjectStore, parseStoreUrl, StoreError, type ObjectStore } from '@shadowlap/remote';
import { startFakeS3, type FakeS3 } from './fakes/s3.js';

/**
 * The S3 driver against an S3 API in process that checks every signature: plain S3 with a custom
 * endpoint (MinIO and friends), Cloudflare R2, and Google Cloud Storage's HMAC interop, which all
 * speak it.
 */

const KEY = 'AKIDTESTEXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const env = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET } as NodeJS.ProcessEnv;

let fake: FakeS3;
let store: ObjectStore;

async function all(it: AsyncIterable<{ key: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const o of it) out.push(o.key);
  return out;
}

beforeAll(async () => {
  fake = await startFakeS3({ keys: { [KEY]: SECRET, R2KEY: 'r2secret', GOOG1EXAMPLE: 'hmacsecret' }, bucket: 'agent-runs', versioning: null, encryption: 'aws:kms', pageSize: 2 });
  store = openObjectStore(parseStoreUrl(`s3://agent-runs/team/support agent?endpoint=${fake.url}`), { env, retryDelayMs: 1 });
});
afterAll(() => fake.close());

describe('S3 with a custom endpoint', () => {
  it('writes, reads, lists page by page and deletes, inside the store folder only', async () => {
    await store.put('runs/a.json', Buffer.from('{"a":1}'), { contentType: 'application/json' });
    await store.put('runs/b c+d=é.json', Buffer.from('two'));
    await store.put('runs/c.json', Buffer.from('three'));
    await store.put('blobs/x', Buffer.from('blob'));
    expect([...fake.objects.keys()].sort()).toEqual(['team/support agent/blobs/x', 'team/support agent/runs/a.json', 'team/support agent/runs/b c+d=é.json', 'team/support agent/runs/c.json']);
    expect((await store.get('runs/b c+d=é.json'))!.body.toString()).toBe('two');
    expect(await store.get('runs/none.json')).toBeNull();
    expect((await store.head('runs/c.json'))!.size).toBe(5);
    expect(await store.head('runs/none.json')).toBeNull();
    // Three objects under runs/, two per page: the listing follows the continuation token.
    expect(await all(store.list('runs/'))).toEqual(['runs/a.json', 'runs/b c+d=é.json', 'runs/c.json']);
    await store.delete('runs/c.json');
    await store.delete('runs/c.json'); // gone already: not an error
    expect(await all(store.list('runs/'))).toEqual(['runs/a.json', 'runs/b c+d=é.json']);
    expect(fake.requests.every((r) => r.status < 400 || r.status === 404)).toBe(true);
  });

  it('writes conditionally: only if absent, or only if unchanged', async () => {
    const first = await store.put('cond.json', Buffer.from('1'), { ifNoneMatch: true });
    await expect(store.put('cond.json', Buffer.from('2'), { ifNoneMatch: true })).rejects.toSatisfy(isPrecondition);
    const second = await store.put('cond.json', Buffer.from('2'), { ifMatch: first.version! });
    await expect(store.put('cond.json', Buffer.from('3'), { ifMatch: first.version! })).rejects.toSatisfy(isPrecondition);
    expect(second.version).not.toBe(first.version);
    expect((await store.get('cond.json'))!.body.toString()).toBe('2');
  });

  it('writes anyway where the store has no conditional writes', async () => {
    const plain = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'b1', noConditional: true });
    try {
      const s = openObjectStore(parseStoreUrl(`s3://b1?endpoint=${plain.url}`), { env, retryDelayMs: 1 });
      await s.put('x', Buffer.from('1'), { ifNoneMatch: true });
      await s.put('x', Buffer.from('2'), { ifNoneMatch: true });
      expect((await s.get('x'))!.body.toString()).toBe('2');
    } finally {
      await plain.close();
    }
  });

  it('makes a presigned link anyone can open until it expires', async () => {
    await store.put('shares/r.html', Buffer.from('<p>report</p>'), { contentType: 'text/html; charset=utf-8' });
    const link = await store.presign('shares/r.html', 7 * 86400);
    expect(link.url).toContain('X-Amz-Expires=604800');
    expect(link.note).toBeNull();
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<p>report</p>');
    // A tampered link fails the signature check.
    expect((await fetch(link.url.replace('r.html', 's.html'))).status).toBe(403);
    // An expired one too.
    const past = openObjectStore(parseStoreUrl(`s3://agent-runs/team/support agent?endpoint=${fake.url}`), { env, retryDelayMs: 1, now: () => Date.now() - 8 * 86400_000 });
    const old = await past.presign('shares/r.html', 7 * 86400);
    expect((await fetch(old.url)).status).toBe(403);
  });

  it('says a link signed with temporary credentials ends with them', async () => {
    const tmp = await startFakeS3({ keys: { ASIATEMP: 'tempsecret' }, tokens: { ASIATEMP: 'session-token' }, bucket: 'b2' });
    try {
      const expires = new Date(Date.now() + 3600_000).toISOString();
      const s = openObjectStore(parseStoreUrl(`s3://b2?endpoint=${tmp.url}`), { env: { AWS_ACCESS_KEY_ID: 'ASIATEMP', AWS_SECRET_ACCESS_KEY: 'tempsecret', AWS_SESSION_TOKEN: 'session-token', AWS_CREDENTIAL_EXPIRATION: expires }, retryDelayMs: 1 });
      await s.put('f.html', Buffer.from('x'));
      const link = await s.presign('f.html', 7 * 86400);
      expect(link.note).toMatch(/temporary credentials/);
      expect(link.expiresAt).toBe(Date.parse(expires));
      expect(link.url).toContain('X-Amz-Security-Token=session-token');
    } finally {
      await tmp.close();
    }
  });

  it('turns S3 errors into what to do about them', async () => {
    const wrong = openObjectStore(parseStoreUrl(`s3://agent-runs?endpoint=${fake.url}`), { env: { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: 'not-the-secret' }, retryDelayMs: 1 });
    await expect(wrong.get('x')).rejects.toThrow(/secret key doesn't match/);
    const unknown = openObjectStore(parseStoreUrl(`s3://agent-runs?endpoint=${fake.url}`), { env: { AWS_ACCESS_KEY_ID: 'NOPE', AWS_SECRET_ACCESS_KEY: 'x' }, retryDelayMs: 1 });
    await expect(unknown.get('x')).rejects.toMatchObject({ code: 'credentials' });
    const other = openObjectStore(parseStoreUrl(`s3://no-such-bucket?endpoint=${fake.url}`), { env, retryDelayMs: 1 });
    await expect(other.get('x')).rejects.toMatchObject({ code: 'no-bucket' });
    const none = openObjectStore(parseStoreUrl(`s3://agent-runs?endpoint=${fake.url}`), { env: {}, home: '/nonexistent-home', retryDelayMs: 1 });
    await expect(none.get('x')).rejects.toThrow(/No AWS credentials found/);
  });

  it('reports encryption and versioning, and warns when versioning is off', async () => {
    const check = await checkStore(store);
    expect(check.ok).toBe(true);
    expect(check.steps.map((s) => [s.name, s.ok])).toEqual([
      ['list', true],
      ['write', true],
      ['read', true],
      ['delete', true],
    ]);
    expect(check.credentials).toBe('AWS_ACCESS_KEY_ID');
    expect(check.encryption).toBe('aws:kms');
    expect(check.versioning).toBe('off');
    expect(check.warnings.join(' ')).toMatch(/Versioning is off/);
    expect([...fake.objects.keys()].some((k) => k.includes('.shadowlap-check'))).toBe(false);
  });

  it('fails the check step by step when access is denied', async () => {
    const locked = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'locked', versioning: 'Enabled', deny: ['put', 'versioning'] });
    try {
      const s = openObjectStore(parseStoreUrl(`s3://locked?endpoint=${locked.url}`), { env, retryDelayMs: 1 });
      const check = await checkStore(s);
      expect(check.ok).toBe(false);
      expect(check.steps.find((x) => x.name === 'list')!.ok).toBe(true);
      expect(check.steps.find((x) => x.name === 'write')!.detail).toMatch(/access denied.*shadowlap store policy/);
      expect(check.steps.find((x) => x.name === 'read')!.detail).toMatch(/not tried/);
      expect(check.notes.join(' ')).toMatch(/GetBucketVersioning/);
    } finally {
      await locked.close();
    }
  });

  it('sees versioning and an Object Lock with a default retention, without a warning', async () => {
    // A bucket with a default retention refuses a write without Content-MD5, as S3 does: every write sends it.
    const locked = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'v', versioning: 'Enabled', objectLock: { mode: 'GOVERNANCE', days: 30 } });
    try {
      const s = openObjectStore(parseStoreUrl(`s3://v/team?endpoint=${locked.url}`), { env, retryDelayMs: 1 });
      const check = await checkStore(s);
      expect(check.ok).toBe(true);
      expect(check.versioning).toBe('on');
      expect(check.objectLock).toEqual({ state: 'on', detail: 'governance mode, 30 days' });
      expect(check.warnings).toEqual([]);
      await s.put('runs/a/run.json', Buffer.from('{}'), { ifNoneMatch: true });
      expect(locked.objects.has('team/runs/a/run.json')).toBe(true);
      expect(locked.requests.filter((r) => r.status === 400)).toEqual([]);
    } finally {
      await locked.close();
    }
  });

  it('warns when Object Lock is off, or on without a default retention, and says how to turn it on', async () => {
    for (const objectLock of [null, 'no-default'] as const) {
      const bucket = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'v', versioning: 'Enabled', objectLock });
      try {
        const check = await checkStore(openObjectStore(parseStoreUrl(`s3://v?endpoint=${bucket.url}`), { env, retryDelayMs: 1 }));
        expect(check.versioning).toBe('on');
        expect(check.objectLock.state).toBe('off');
        expect(check.warnings).toHaveLength(1);
        expect(check.warnings[0]).toMatch(/^Object lock is off.*: anyone allowed to delete in the bucket can remove a run's earlier versions for good\. Turn it on in the store's own settings/);
        if (objectLock === 'no-default') expect(check.warnings[0]).toContain('no default retention');
      } finally {
        await bucket.close();
      }
    }
  });

  it("says when these credentials can't read the Object Lock setting", async () => {
    const bucket = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'v', versioning: 'Enabled', deny: ['object-lock'] });
    try {
      const check = await checkStore(openObjectStore(parseStoreUrl(`s3://v?endpoint=${bucket.url}`), { env, retryDelayMs: 1 }));
      expect(check.objectLock.state).toBe('unknown');
      expect(check.warnings).toEqual([]);
      expect(check.notes.join(' ')).toMatch(/s3:GetBucketObjectLockConfiguration/);
    } finally {
      await bucket.close();
    }
  });
});

describe('Cloudflare R2 and Cloud Storage HMAC, through the same API', () => {
  it('uses the R2 token keys, region auto, and says R2 keeps no versions', async () => {
    const r2 = await startFakeS3({ keys: { R2KEY: 'r2secret' }, bucket: 'agent-runs' });
    try {
      const s = openObjectStore(parseStoreUrl(`r2://0123456789abcdef/agent-runs/team?endpoint=${r2.url}`), { env: { R2_ACCESS_KEY_ID: 'R2KEY', R2_SECRET_ACCESS_KEY: 'r2secret' }, retryDelayMs: 1 });
      await s.put('a', Buffer.from('1'));
      expect([...r2.objects.keys()]).toEqual(['team/a']);
      const check = await checkStore(s);
      expect(check.ok).toBe(true);
      expect(check.versioning).toBe('unavailable');
      expect(check.objectLock.state).toBe('unavailable');
      expect(check.encryption).toMatch(/R2 encrypts every object/);
      expect(check.warnings.join(' ')).toMatch(/no object versioning/);
      // R2 has neither: it isn't asked.
      expect(r2.requests.some((r) => /versioning|object-lock/.test(r.query))).toBe(false);
    } finally {
      await r2.close();
    }
  });

  it('uses HMAC keys for gs://…?auth=hmac', async () => {
    const gcs = await startFakeS3({ keys: { GOOG1EXAMPLE: 'hmacsecret' }, bucket: 'agent-runs' });
    try {
      const s = openObjectStore(parseStoreUrl(`gs://agent-runs/team?auth=hmac&endpoint=${gcs.url}`), { env: { GCS_HMAC_ACCESS_KEY_ID: 'GOOG1EXAMPLE', GCS_HMAC_SECRET_ACCESS_KEY: 'hmacsecret' }, retryDelayMs: 1 });
      await s.put('shares/x.html', Buffer.from('hi'));
      const link = await s.presign('shares/x.html', 3600);
      expect(await (await fetch(link.url)).text()).toBe('hi');
      const missing = openObjectStore(parseStoreUrl(`gs://agent-runs/team?auth=hmac&endpoint=${gcs.url}`), { env: {}, retryDelayMs: 1 });
      await expect(missing.get('x')).rejects.toThrow(/GCS_HMAC_ACCESS_KEY_ID/);
    } finally {
      await gcs.close();
    }
  });
});

describe('addressing Amazon S3 itself', () => {
  it('uses the virtual-hosted name in the bucket region, path-style for dotted buckets', async () => {
    const seen: string[] = [];
    const fetchSpy = async (input: string) => {
      seen.push(input);
      return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    };
    const s = openObjectStore(parseStoreUrl('s3://northwind-agent-runs/support-agent?region=eu-central-1'), { env, fetch: fetchSpy, retryDelayMs: 1 });
    await s.get('runs/x/run.json');
    expect(seen[0]).toBe('https://northwind-agent-runs.s3.eu-central-1.amazonaws.com/support-agent/runs/x/run.json');
    const dotted = openObjectStore(parseStoreUrl('s3://runs.northwind.example?region=us-west-2'), { env, fetch: fetchSpy, retryDelayMs: 1 });
    await dotted.get('a');
    expect(seen[1]).toBe('https://s3.us-west-2.amazonaws.com/runs.northwind.example/a');
  });

  it('finds the bucket region when nothing names it, and follows S3 to the right one', async () => {
    const seen: string[] = [];
    const fetchSpy = async (input: string, init: RequestInit) => {
      seen.push(`${init.method} ${input}`);
      if (init.method === 'HEAD') return new Response(null, { status: 403, headers: { 'x-amz-bucket-region': 'eu-west-1' } });
      if (input.includes('eu-west-1')) return new Response('<Error><Code>PermanentRedirect</Code><Region>ap-south-1</Region></Error>', { status: 301, headers: { 'x-amz-bucket-region': 'ap-south-1' } });
      return new Response('ok', { status: 200 });
    };
    const s = openObjectStore(parseStoreUrl('s3://somebucket'), { env, home: '/nonexistent-home', fetch: fetchSpy, retryDelayMs: 1 });
    const got = await s.get('k');
    expect(got!.body.toString()).toBe('ok');
    expect(seen).toEqual(['HEAD https://somebucket.s3.amazonaws.com/', 'GET https://somebucket.s3.eu-west-1.amazonaws.com/k', 'GET https://somebucket.s3.ap-south-1.amazonaws.com/k']);
  });

  it('retries a dropped connection and a 503, then gives up with the reason', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      if (calls === 2) return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 });
      return new Response('done', { status: 200 });
    };
    const s = openObjectStore(parseStoreUrl('s3://b-retry?region=us-east-1'), { env, fetch: flaky, retryDelayMs: 1 });
    expect((await s.get('k'))!.body.toString()).toBe('done');
    const down = openObjectStore(parseStoreUrl('s3://b-retry?region=us-east-1'), { env, fetch: async () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), retryDelayMs: 1 });
    await expect(down.get('k')).rejects.toThrow(StoreError);
    await expect(down.get('k')).rejects.toThrow(/ENOTFOUND/);
  });
});
