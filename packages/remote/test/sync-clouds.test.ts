import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, storeApiRequest, type RunRecord } from '@shadowlap/engine';
import { openObjectStore, parseStoreUrl, pull, push, shareReport, type ObjectStore } from '@shadowlap/remote';
import { startFakeAzure, type FakeAzure } from './fakes/azure.js';
import { startFakeGcs, type FakeGcs } from './fakes/gcs.js';

/**
 * Push, pull and share end to end on Cloud Storage and Azure Blob, through in-process services that
 * check every token, Shared Key signature and signed URL: two machines with different credentials
 * share runs, a fork with its lineage, and labels added on either side; a share link opens without
 * credentials. The S3 path is covered the same way by the CLI's tests.
 */

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

function record(store: Store, text: string, parent?: string): RunRecord {
  const run = store.createRun({ mode: parent ? 'replay' : 'record', command: cmd, ...(parent ? { parentRunId: parent } : {}) });
  const req = storeApiRequest(store, { model: 'm', system: 'You are a support agent with a long shared system prompt.', messages: [{ role: 'user', content: text }] });
  const res = store.putBlob(Buffer.from(`event: message_start\ndata: {"text":${JSON.stringify(text)}}\n\n`));
  const call = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: text.charCodeAt(0).toString(16).repeat(64).slice(0, 64), occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo: 1, ...call, origin: 'live', effect: null, requestRef: req, meta: { provider: 'anthropic' }, at: 1 });
  store.appendCallEnd(call, { runId: run.runId, callNo: 1, attempt: 0, responseRef: res, outcome: 'ok', meta: { status: 200 }, at: 2 });
  store.endRun(run.runId, 'completed');
  return store.getRun(run.runId)!;
}

/** Two machines, each with its own credentials for the same store, push and pull and share. */
async function roundTrip(dana: ObjectStore, maya: ObjectStore): Promise<void> {
  const a = { store: Store.open(':memory:'), remote: dana, actor: 'dana@northwind.example', now: () => Date.now() };
  const b = { store: Store.open(':memory:'), remote: maya, actor: 'maya@northwind.example', now: () => Date.now() };
  const parent = record(a.store, 'refund order 1');
  const fork = record(a.store, 'refund order 1, forked', parent.runId);
  a.store.updateRunMeta(parent.runId, { labels: ['refund-flow'] });
  const pushed = await push(a, { all: true });
  expect(pushed.pushed).toEqual([parent.runId, fork.runId]);
  expect(pushed.refused).toEqual([]);

  const pulled = await pull(b);
  expect(pulled.pulled).toEqual([parent.runId, fork.runId]);
  expect(pulled.failed).toEqual([]);
  expect(b.store.getRun(fork.runId)!.parentRunId).toBe(parent.runId);
  expect(b.store.getCalls(fork.runId)).toEqual(a.store.getCalls(fork.runId));
  expect(b.store.getRun(parent.runId)!.meta).toMatchObject({ labels: ['refund-flow'], author: 'dana@northwind.example' });

  // Maya labels the run; her push writes the run document conditionally, and Dana's pull merges it.
  b.store.updateRunMeta(parent.runId, { labels: ['refund-flow', 'triaged'] });
  expect((await push(b, { all: true })).updated).toEqual([parent.runId]);
  const merged = await pull(a);
  expect(merged.merged).toEqual([parent.runId]);
  expect(a.store.getRun(parent.runId)!.meta?.labels).toEqual(['refund-flow', 'triaged']);

  // A share link opens for anyone who has it, without credentials, and nowhere else.
  const share = await shareReport(dana, parent.runId, '<p>refund order 1</p>');
  const res = await fetch(share.link.url);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('<p>refund order 1</p>');
  expect((await fetch(share.link.url.replace(share.key.split('/').pop()!, 'other.html'))).status).toBe(403);
  a.store.close();
  b.store.close();
}

const tmp = mkdtempSync(join(tmpdir(), 'sl-sync-clouds-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('a team store on Cloud Storage', () => {
  let gcs: FakeGcs;
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const email = 'shadowlap-ci@northwind.iam.gserviceaccount.com';

  beforeAll(async () => {
    gcs = await startFakeGcs({ bucket: 'agent-runs', tokens: ['ya29.maya'], serviceAccounts: { [email]: sa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, versioning: true, pageSize: 2 });
  });
  afterAll(() => gcs.close());

  it('takes runs, labels and a share link between a service account and a user sign-in', async () => {
    const keyFile = join(tmp, 'sa.json');
    writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: email, private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), private_key_id: 'k1', token_uri: `${gcs.url}/token` }));
    const loc = parseStoreUrl(`gs://agent-runs/support-agent?endpoint=${gcs.url}`);
    const home = join(tmp, 'no-home');
    await roundTrip(openObjectStore(loc, { env: { GOOGLE_APPLICATION_CREDENTIALS: keyFile }, home, retryDelayMs: 1 }), openObjectStore(loc, { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.maya' }, home, retryDelayMs: 1 }));
    expect([...gcs.objects.keys()].every((k) => k.startsWith('support-agent/'))).toBe(true);
    expect(gcs.requests.filter((r) => r.status === 401 || r.status === 403).map((r) => r.path)).toEqual([expect.stringMatching(/other\.html/)]);
  });
});

describe('a team store on Azure Blob', () => {
  let az: FakeAzure;
  const key = randomBytes(64).toString('base64');

  beforeAll(async () => {
    az = await startFakeAzure({ account: 'northwindruns', key, container: 'agent-runs', tokens: ['entra-maya'], versioning: true, pageSize: 2 });
  });
  afterAll(() => az.close());

  it('takes runs, labels and a share link between an account key and an Entra sign-in', async () => {
    const loc = parseStoreUrl(`az://northwindruns/agent-runs/support-agent?endpoint=${az.endpoint}`);
    const azCli = async () => JSON.stringify({ accessToken: 'entra-maya', expiresOn: new Date(Date.now() + 3600_000).toISOString() });
    await roundTrip(openObjectStore(loc, { env: { AZURE_STORAGE_KEY: key }, retryDelayMs: 1 }), openObjectStore(loc, { env: {}, azCli, retryDelayMs: 1 }));
    expect([...az.blobs.keys()].every((k) => k.startsWith('support-agent/'))).toBe(true);
    expect(new Set(az.requests.map((r) => r.auth))).toEqual(new Set(['key', 'bearer', 'sas']));
  });

  it('shares from an Entra sign-in with a user delegation key', async () => {
    const loc = parseStoreUrl(`az://northwindruns/agent-runs/entra?endpoint=${az.endpoint}`);
    const maya = openObjectStore(loc, { env: {}, azCli: async () => JSON.stringify({ accessToken: 'entra-maya', expiresOn: new Date(Date.now() + 3600_000).toISOString() }), retryDelayMs: 1 });
    const share = await shareReport(maya, '01JAAAAAAAAAAAAAAAAAAAAAAA', '<p>from maya</p>');
    expect(share.link.url).toContain('skoid=');
    const res = await fetch(share.link.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>from maya</p>');
  });
});
