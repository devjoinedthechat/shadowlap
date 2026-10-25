import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkStore, isPrecondition, openObjectStore, parseStoreUrl, shareReport, type ObjectStore } from '@shadowlap/remote';
import { startFakeAzure, type FakeAzure } from './fakes/azure.js';
import { startFakeGcs, type FakeGcs } from './fakes/gcs.js';

/**
 * The Cloud Storage and Azure Blob drivers against in-process services that check what each cloud
 * checks: bearer tokens and a service account's signed JWT for Cloud Storage, with V4 signed URLs
 * verified against its public key; Shared Key, SAS and user delegation SAS signatures for Azure,
 * recomputed by the fake from the REST reference.
 */

async function keysOf(it: AsyncIterable<{ key: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const o of it) out.push(o.key);
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'sl-drivers-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('Google Cloud Storage, JSON API', () => {
  let gcs: FakeGcs;
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const email = 'shadowlap-ci@northwind.iam.gserviceaccount.com';
  let keyFile: string;

  beforeAll(async () => {
    gcs = await startFakeGcs({ bucket: 'agent-runs', tokens: ['ya29.user-token'], serviceAccounts: { [email]: sa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, versioning: false, pageSize: 2 });
    keyFile = join(tmp, 'sa.json');
    writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: email, private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), private_key_id: 'k1', token_uri: `${gcs.url}/token` }));
  });
  afterAll(() => gcs.close());

  const open = (env: NodeJS.ProcessEnv, url = `gs://agent-runs/team?endpoint=${gcs.url}`) => openObjectStore(parseStoreUrl(url), { env, home: join(tmp, 'no-home'), retryDelayMs: 1 });

  it('writes, reads, lists page by page and deletes with a user token', async () => {
    const s = open({ GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.user-token' });
    expect(await s.credentials()).toBe('GOOGLE_OAUTH_ACCESS_TOKEN');
    await s.put('runs/a.json', Buffer.from('{"a":1}'), { contentType: 'application/json' });
    await s.put('runs/b c.json', Buffer.from('two'));
    await s.put('runs/c.json', Buffer.from('three'));
    expect([...gcs.objects.keys()].sort()).toEqual(['team/runs/a.json', 'team/runs/b c.json', 'team/runs/c.json']);
    expect((await s.get('runs/b c.json'))!.body.toString()).toBe('two');
    expect(await s.get('runs/none.json')).toBeNull();
    expect((await s.head('runs/c.json'))!.size).toBe(5);
    expect(await s.head('runs/none')).toBeNull();
    expect(await keysOf(s.list('runs/'))).toEqual(['runs/a.json', 'runs/b c.json', 'runs/c.json']);
    await s.delete('runs/c.json');
    await s.delete('runs/c.json');
    expect(await keysOf(s.list('runs/'))).toEqual(['runs/a.json', 'runs/b c.json']);
  });

  it("sends a Google token only to Google's addresses, and none to an emulator", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const spy = async (input: string, init: RequestInit) => {
      seen.push({ url: input, auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ error: { message: 'No such object' } }), { status: 404 });
    };
    const elsewhere = openObjectStore(parseStoreUrl('gs://agent-runs/team?endpoint=https://storage.evil.example'), { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.user-token' }, fetch: spy, retryDelayMs: 1 });
    await expect(elsewhere.get('x')).rejects.toMatchObject({ code: 'credentials', message: expect.stringMatching(/isn't Google's: Shadowlap doesn't send your Google sign-in there/) });
    expect(seen).toEqual([]);
    const emulator = openObjectStore(parseStoreUrl('gs://agent-runs/team'), { env: { STORAGE_EMULATOR_HOST: '127.0.0.1:4443', GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.user-token' }, fetch: spy, retryDelayMs: 1 });
    expect(await emulator.credentials()).toBe('no credentials (STORAGE_EMULATOR_HOST)');
    expect(await emulator.get('x')).toBeNull();
    expect(seen).toEqual([{ url: 'http://127.0.0.1:4443/storage/v1/b/agent-runs/o/team%2Fx?alt=media', auth: null }]);
  });

  it('writes conditionally by generation', async () => {
    const s = open({ GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.user-token' });
    const first = await s.put('cond', Buffer.from('1'), { ifNoneMatch: true });
    await expect(s.put('cond', Buffer.from('2'), { ifNoneMatch: true })).rejects.toSatisfy(isPrecondition);
    await s.put('cond', Buffer.from('2'), { ifMatch: first.version! });
    await expect(s.put('cond', Buffer.from('3'), { ifMatch: first.version! })).rejects.toSatisfy(isPrecondition);
    expect((await s.get('cond'))!.body.toString()).toBe('2');
  });

  it("tells a missing object from a missing bucket, even when the bucket's name says bucket", async () => {
    const named = await startFakeGcs({ bucket: 'my-bucket', tokens: ['t'] });
    try {
      const s = open({ GOOGLE_OAUTH_ACCESS_TOKEN: 't' }, `gs://my-bucket?endpoint=${named.url}`);
      expect(await s.get('nothing-here')).toBeNull();
      const other = open({ GOOGLE_OAUTH_ACCESS_TOKEN: 't' }, `gs://no-such-bucket?endpoint=${named.url}`);
      await expect(other.get('x')).rejects.toMatchObject({ code: 'no-bucket' });
    } finally {
      await named.close();
    }
  });

  it('signs in as a service account and signs share links with its key', async () => {
    const s = open({ GOOGLE_APPLICATION_CREDENTIALS: keyFile });
    expect(await s.credentials()).toBe(`GOOGLE_APPLICATION_CREDENTIALS (service account ${email})`);
    await s.put('shares/r.html', Buffer.from('<p>report</p>'), { contentType: 'text/html; charset=utf-8' });
    const link = await s.presign('shares/r.html', 7 * 86400);
    expect(link.url).toContain('X-Goog-Algorithm=GOOG4-RSA-SHA256');
    expect(link.url).toContain('X-Goog-Expires=604800');
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>report</p>');
    expect((await fetch(link.url.replace('r.html', 's.html'))).status).toBe(403);
  });

  it('says a user sign-in has no key to sign a share link with, and leaves no report behind', async () => {
    const s = open({ GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.user-token' });
    await expect(s.presign('shares/r.html', 3600)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/auth=hmac/) });
    const before = [...gcs.objects.keys()].filter((k) => k.includes('/shares/'));
    await expect(shareReport(s, '01JAAAAAAAAAAAAAAAAAAAAAAA', '<p>report</p>')).rejects.toMatchObject({ code: 'unsupported' });
    expect([...gcs.objects.keys()].filter((k) => k.includes('/shares/'))).toEqual(before);
  });

  it('turns refusals into what to do about them', async () => {
    await expect(open({ GOOGLE_OAUTH_ACCESS_TOKEN: 'expired' }).get('x')).rejects.toMatchObject({ code: 'credentials', message: expect.stringMatching(/gcloud auth application-default login/) });
    const locked = await startFakeGcs({ bucket: 'agent-runs', tokens: ['t'], deny: ['put', 'bucket'] });
    try {
      const check = await checkStore(open({ GOOGLE_OAUTH_ACCESS_TOKEN: 't' }, `gs://agent-runs?endpoint=${locked.url}`));
      expect(check.ok).toBe(false);
      expect(check.steps.find((x) => x.name === 'write')!.detail).toMatch(/refused.*shadowlap store policy/);
      expect(check.notes.join(' ')).toMatch(/storage\.buckets\.get/);
    } finally {
      await locked.close();
    }
    const none = open({ CLOUDSDK_CONFIG: join(tmp, 'no-gcloud'), GCE_METADATA_HOST: '127.0.0.1:9' });
    await expect(none.get('x')).rejects.toThrow(/No Google credentials found/);
  });

  it('reports versioning and soft delete off with warnings, and Google-managed encryption', async () => {
    const check = await checkStore(open({ GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.user-token' }));
    expect(check.ok).toBe(true);
    expect(check.versioning).toBe('off');
    expect(check.objectLock.state).toBe('off');
    expect(check.encryption).toMatch(/Google-managed/);
    expect(check.warnings.join(' ')).toMatch(/gcloud storage buckets update gs:\/\/agent-runs --versioning/);
    expect(check.warnings.join(' ')).toMatch(/Object lock is off.*gcloud storage buckets update gs:\/\/agent-runs --soft-delete-duration=30d/);
    const kms = await startFakeGcs({ bucket: 'agent-runs', tokens: ['t'], versioning: true, softDeleteSeconds: 7 * 86_400, kmsKeyName: 'projects/p/locations/eu/keyRings/r/cryptoKeys/k' });
    try {
      const c = await checkStore(open({ GOOGLE_OAUTH_ACCESS_TOKEN: 't' }, `gs://agent-runs?endpoint=${kms.url}`));
      expect(c.versioning).toBe('on');
      expect(c.objectLock).toEqual({ state: 'on', detail: 'soft delete, 7 days' });
      expect(c.encryption).toBe('Cloud KMS (projects/p/locations/eu/keyRings/r/cryptoKeys/k)');
      expect(c.warnings).toEqual([]);
    } finally {
      await kms.close();
    }
    const locked = await startFakeGcs({ bucket: 'agent-runs', tokens: ['t'], versioning: true, retentionSeconds: 30 * 86_400 });
    try {
      const c = await checkStore(open({ GOOGLE_OAUTH_ACCESS_TOKEN: 't' }, `gs://agent-runs?endpoint=${locked.url}`));
      expect(c.objectLock).toEqual({ state: 'on', detail: 'retention policy, 30 days, locked' });
    } finally {
      await locked.close();
    }
  });
});

describe('Azure Blob Storage', () => {
  let az: FakeAzure;
  const key = randomBytes(64).toString('base64');

  beforeAll(async () => {
    az = await startFakeAzure({ account: 'northwindruns', key, container: 'agent-runs', tokens: ['entra-token'], versioning: true, pageSize: 2 });
  });
  afterAll(() => az.close());

  const url = () => `az://northwindruns/agent-runs/support agent?endpoint=${az.endpoint}`;
  const open = (env: NodeJS.ProcessEnv, azCli?: (args: string[]) => Promise<string>): ObjectStore =>
    openObjectStore(parseStoreUrl(url()), { env, retryDelayMs: 1, ...(azCli ? { azCli } : {}) });

  it('writes, reads, lists page by page and deletes with the account key', async () => {
    const s = open({ AZURE_STORAGE_KEY: key });
    expect(await s.credentials()).toBe('AZURE_STORAGE_KEY');
    await s.put('runs/a.json', Buffer.from('{"a":1}'), { contentType: 'application/json' });
    await s.put('runs/b+c=é.json', Buffer.from('two'));
    await s.put('runs/c.json', Buffer.from('three'));
    expect([...az.blobs.keys()].sort()).toEqual(['support agent/runs/a.json', 'support agent/runs/b+c=é.json', 'support agent/runs/c.json']);
    expect((await s.get('runs/b+c=é.json'))!.body.toString()).toBe('two');
    expect(await s.get('runs/none')).toBeNull();
    expect((await s.head('runs/c.json'))!.size).toBe(5);
    expect(await keysOf(s.list('runs/'))).toEqual(['runs/a.json', 'runs/b+c=é.json', 'runs/c.json']);
    await s.delete('runs/c.json');
    await s.delete('runs/c.json');
    expect(await keysOf(s.list('runs/'))).toEqual(['runs/a.json', 'runs/b+c=é.json']);
    expect(az.requests.every((r) => r.auth === 'key' && (r.status < 400 || r.status === 404))).toBe(true);
  });

  it('writes conditionally', async () => {
    const s = open({ AZURE_STORAGE_KEY: key });
    const first = await s.put('cond', Buffer.from('1'), { ifNoneMatch: true });
    await expect(s.put('cond', Buffer.from('2'), { ifNoneMatch: true })).rejects.toSatisfy(isPrecondition);
    await s.put('cond', Buffer.from('2'), { ifMatch: first.version! });
    await expect(s.put('cond', Buffer.from('3'), { ifMatch: first.version! })).rejects.toSatisfy(isPrecondition);
  });

  it('makes a SAS share link with the account key', async () => {
    const s = open({ AZURE_STORAGE_KEY: key });
    await s.put('shares/r.html', Buffer.from('<p>report</p>'), { contentType: 'text/html; charset=utf-8' });
    const link = await s.presign('shares/r.html', 7 * 86400);
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>report</p>');
    expect((await fetch(link.url.replace('sp=r', 'sp=rw'))).status).toBe(403);
  });

  it('works with a container SAS token, which can read and write but not sign a new link', async () => {
    const s = open({ AZURE_STORAGE_SAS_TOKEN: `?${az.containerSas('racwdl', Date.now() + 3600_000)}` });
    await s.put('sas/x', Buffer.from('via sas'));
    expect((await s.get('sas/x'))!.body.toString()).toBe('via sas');
    expect(await keysOf(s.list('sas/'))).toEqual(['sas/x']);
    await expect(s.presign('sas/x', 3600)).rejects.toMatchObject({ code: 'unsupported' });
    const readOnly = open({ AZURE_STORAGE_SAS_TOKEN: az.containerSas('rl', Date.now() + 3600_000) });
    await expect(readOnly.put('sas/y', Buffer.from('no'))).rejects.toMatchObject({ code: 'denied' });
  });

  it('signs in through the Azure CLI and makes a user delegation SAS link', async () => {
    const calls: string[][] = [];
    const s = open({}, async (args) => {
      calls.push(args);
      return JSON.stringify({ accessToken: 'entra-token', expiresOn: new Date(Date.now() + 3600_000).toISOString() });
    });
    expect(await s.credentials()).toBe('your Azure CLI sign-in');
    await s.put('shares/u.html', Buffer.from('<p>delegated</p>'));
    const link = await s.presign('shares/u.html', 7 * 86400);
    expect(link.url).toContain('skoid=');
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>delegated</p>');
    // One sign-in, reused until it nears its expiry.
    expect(calls).toEqual([['account', 'get-access-token', '--resource', 'https://storage.azure.com/', '--output', 'json']]);
  });

  it("ends a link from an Entra sign-in short of 7 days, so a clock here that runs fast doesn't fail it", async () => {
    // Azure's clock is 5 minutes behind this machine's.
    const behind = await startFakeAzure({ account: 'northwindruns', key, container: 'agent-runs', tokens: ['entra-token'], now: () => Date.now() - 5 * 60_000 });
    try {
      const s = openObjectStore(parseStoreUrl(`az://northwindruns/agent-runs?endpoint=${behind.endpoint}`), { env: {}, retryDelayMs: 1, azCli: async () => JSON.stringify({ accessToken: 'entra-token', expiresOn: new Date(Date.now() + 3600_000).toISOString() }) });
      await s.put('shares/skew.html', Buffer.from('<p>skew</p>'));
      const before = Date.now();
      const link = await s.presign('shares/skew.html', 7 * 86400);
      expect(link.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 15 * 60_000);
      expect(link.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 - 15 * 60_000);
      expect((await fetch(link.url)).status).toBe(200);
    } finally {
      await behind.close();
    }
  });

  it('names the role a share link from an Entra sign-in needs, when Azure refuses the delegation key', async () => {
    const containerOnly = await startFakeAzure({ account: 'northwindruns', key, container: 'agent-runs', tokens: ['entra-token'], delegator: false });
    try {
      const s = openObjectStore(parseStoreUrl(`az://northwindruns/agent-runs?endpoint=${containerOnly.endpoint}`), { env: {}, retryDelayMs: 1, azCli: async () => JSON.stringify({ accessToken: 'entra-token', expiresOn: new Date(Date.now() + 3600_000).toISOString() }) });
      await s.put('shares/x.html', Buffer.from('<p>x</p>'));
      await expect(s.presign('shares/x.html', 7 * 86400)).rejects.toMatchObject({ code: 'denied', message: expect.stringMatching(/Storage Blob Delegator .* on the storage account northwindruns itself/) });
    } finally {
      await containerOnly.close();
    }
  });

  it("uses Azure credentials only with Azure Storage's own addresses, or one given on this machine", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const spy = async (input: string, init: RequestInit) => {
      seen.push({ url: input, auth: new Headers(init.headers).get('authorization') });
      return new Response('', { status: 404, headers: { 'x-ms-error-code': 'BlobNotFound' } });
    };
    const elsewhere = parseStoreUrl('az://northwindruns/agent-runs?endpoint=https://storage.evil.example/northwindruns');
    const entra = openObjectStore(elsewhere, { env: {}, fetch: spy, retryDelayMs: 1, azCli: async () => JSON.stringify({ accessToken: 'entra-token', expiresOn: new Date(Date.now() + 3600_000).toISOString() }) });
    await expect(entra.get('x')).rejects.toMatchObject({ code: 'credentials', message: expect.stringMatching(/isn't an Azure Storage address/) });
    const sas = openObjectStore(elsewhere, { env: { AZURE_STORAGE_SAS_TOKEN: 'sv=2021-08-06&sig=secret' }, fetch: spy, retryDelayMs: 1 });
    await expect(sas.get('x')).rejects.toMatchObject({ code: 'credentials' });
    expect(seen).toEqual([]);
    // An account key's signature doesn't name the host: a request signed for this one could be
    // replayed against the account itself.
    const signed = openObjectStore(elsewhere, { env: { AZURE_STORAGE_KEY: key }, fetch: spy, retryDelayMs: 1 });
    await expect(signed.get('x')).rejects.toMatchObject({ code: 'credentials', message: expect.stringMatching(/AZURE_STORAGE_CONNECTION_STRING with BlobEndpoint=/) });
    expect(seen).toEqual([]);
    // The same address given on this machine, in the connection string, is the user's own choice.
    const local = openObjectStore(parseStoreUrl('az://northwindruns/agent-runs'), { env: { AZURE_STORAGE_CONNECTION_STRING: `AccountName=northwindruns;AccountKey=${key};BlobEndpoint=https://storage.evil.example/northwindruns` }, fetch: spy, retryDelayMs: 1 });
    expect(await local.get('x')).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/^https:\/\/storage\.evil\.example\/northwindruns\/agent-runs\/x/);
    expect(seen[0].auth).toMatch(/^SharedKey northwindruns:/);
  });

  it('reads the connection string Azurite and the Azure tools use', async () => {
    const s = openObjectStore(parseStoreUrl('az://northwindruns/agent-runs/cs'), { env: { AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=http;AccountName=northwindruns;AccountKey=${key};BlobEndpoint=${az.endpoint};` }, retryDelayMs: 1 });
    await s.put('x', Buffer.from('1'));
    expect(az.blobs.has('cs/x')).toBe(true);
  });

  it("checks access, sees versioning from the write, and reads the container's immutability", async () => {
    const check = await checkStore(open({ AZURE_STORAGE_KEY: key }));
    expect(check.ok).toBe(true);
    expect(check.versioning).toBe('on');
    expect(check.encryption).toMatch(/Microsoft-managed/);
    expect(check.objectLock.state).toBe('off');
    expect(check.warnings).toEqual([expect.stringMatching(/^Object lock is off: .*version-level immutability for the container/)]);
    const plain = await startFakeAzure({ account: 'northwindruns', key, container: 'agent-runs', versioning: false, immutability: { versionLevel: true, policy: true } });
    try {
      const c = await checkStore(openObjectStore(parseStoreUrl(`az://northwindruns/agent-runs?endpoint=${plain.endpoint}`), { env: { AZURE_STORAGE_KEY: key }, retryDelayMs: 1 }));
      expect(c.versioning).toBe('off');
      expect(c.objectLock).toEqual({ state: 'on', detail: 'version-level immutability, an immutability policy' });
      expect(c.warnings).toEqual([expect.stringMatching(/az storage account blob-service-properties update --account-name northwindruns --enable-versioning true/)]);
    } finally {
      await plain.close();
    }
  });

  it('turns refusals into what to do about them', async () => {
    await expect(open({ AZURE_STORAGE_KEY: randomBytes(64).toString('base64') }).get('x')).rejects.toMatchObject({ code: 'credentials' });
    const other = openObjectStore(parseStoreUrl(`az://northwindruns/no-container?endpoint=${az.endpoint}`), { env: { AZURE_STORAGE_KEY: key }, retryDelayMs: 1 });
    await expect(other.get('x')).rejects.toMatchObject({ code: 'no-bucket' });
    const noCli = open({}, async () => {
      throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' });
    });
    await expect(noCli.get('x')).rejects.toThrow(/No Azure credentials found/);
  });
});
