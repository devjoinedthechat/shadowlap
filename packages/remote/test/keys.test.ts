import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { INDEX_FORMAT, LAYOUT_VERSION, objectKey, openObjectStore, parseStoreUrl, pull, StoreUrlError, type ObjectStore } from '@shadowlap/remote';
import { startFakeS3, type FakeS3 } from './fakes/s3.js';

/**
 * Object keys in a shared bucket: anyone who can write to the store's folder names objects there,
 * and a URL resolves `.` and `..`, so a key that holds one would reach outside the folder, read or
 * written with this machine's credentials. No such key is ever sent.
 */

const KEY = 'AKIDTESTEXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const env = { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET } as NodeJS.ProcessEnv;

let fake: FakeS3;
let remote: ObjectStore;
beforeAll(async () => {
  fake = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'agent-runs' });
  remote = openObjectStore(parseStoreUrl(`s3://agent-runs/team?endpoint=${fake.url}`), { env, retryDelayMs: 1 });
});
afterAll(() => fake.close());

const segment = (runId: string) => Buffer.from(JSON.stringify({ format: INDEX_FORMAT, version: LAYOUT_VERSION, at: 1, by: 'x', runs: [{ runId, parentRunId: null, startedAt: 1, metaHash: 'a'.repeat(64) }] }));
const plant = (key: string, body: Buffer) => fake.objects.set(key, { body, etag: '"x"', contentType: 'application/json', modified: 1, versionId: null });

describe('object keys', () => {
  it('never hold a "." or ".." part', () => {
    const loc = parseStoreUrl('s3://agent-runs/team');
    expect(objectKey(loc, 'runs/01K0000000000000000000000/run.json')).toBe('team/runs/01K0000000000000000000000/run.json');
    expect(objectKey(loc, '.shadowlap-check/01K0000000000000000000000')).toBe('team/.shadowlap-check/01K0000000000000000000000');
    expect(objectKey(loc, 'index/')).toBe('team/index/');
    for (const key of ['index/../../other/x.json', '../x', 'a/./b', '..', 'runs/..']) expect(() => objectKey(loc, key), key).toThrow(StoreUrlError);
    // A part that only starts with dots is a name like any other: a URL leaves it as it is.
    expect(objectKey(loc, 'runs/..x/...')).toBe('team/runs/..x/...');
  });

  it('a driver sends no request for one', async () => {
    const before = fake.requests.length;
    await expect(remote.get('index/../../other/secret.json')).rejects.toThrow(/isn't a key in the store's folder/);
    await expect(remote.put('runs/../../other/x', Buffer.from('x'))).rejects.toThrow(StoreUrlError);
    await expect(remote.presign('shares/../../other/x.html', 60)).rejects.toThrow(StoreUrlError);
    expect(fake.requests.length).toBe(before);
  });
});

describe('a pull', () => {
  it('reads no index segment named outside what a push names one, so nothing outside the folder is read', async () => {
    // Another folder in the same bucket, which this machine's credentials can read.
    plant('other/secret.json', segment('01K1111111111111111111111A'));
    // Named by someone with write access to the store's folder.
    plant('team/index/../../other/secret.json', segment('01K1111111111111111111111A'));
    plant('team/index/01K2222222222222222222222B.json', segment('01K2222222222222222222222B'));
    const store = Store.open(':memory:');
    try {
      const result = await pull({ store, remote, actor: 'sam' });
      // Listing the bucket asks for its root, with the folder as the prefix; every object read is in the folder.
      expect(fake.requests.filter((r) => r.path !== '/agent-runs/' && !r.path.startsWith('/agent-runs/team/')).map((r) => r.path)).toEqual([]);
      expect(fake.requests.filter((r) => r.path === '/agent-runs/').every((r) => /(^|&)prefix=team%2F/.test(r.query))).toBe(true);
      expect(result.skippedSegments).toEqual([{ key: 'index/../../other/secret.json', reason: expect.stringContaining("isn't the name a push gives an index segment") }]);
      // The segment named as a push names one was read: its run is listed (and missing from the bucket).
      expect(result.missing).toEqual(['01K2222222222222222222222B']);
      // Said once.
      expect((await pull({ store, remote, actor: 'sam' })).skippedSegments).toEqual([]);
    } finally {
      store.close();
    }
  });
});
