import { createHash, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, Store, unpackRun, type RunMeta } from '@shadowlap/engine';
import { blameReport, EXPECT, repairReport } from '../../engine/test/fix-fixtures.js';
import { storeCheck, storeSetChecked, teamPull, teamPush, teamShare, type TeamEnv } from '../src/team.js';

/**
 * The team store against the real thing, where this machine runs one: an S3-compatible server
 * (SeaweedFS, MinIO, Ceph), Google's Cloud Storage emulator (fake-gcs-server) and Azure's (Azurite).
 * Each test runs only when its variable names the store, so the gate skips them:
 *
 *   SHADOWLAP_TEST_S3_URL=s3://bucket/folder?endpoint=http://127.0.0.1:8333  SHADOWLAP_TEST_S3_KEYS=<id>:<secret>
 *   SHADOWLAP_TEST_R2_URL=r2://account/bucket/folder?endpoint=http://127.0.0.1:8333  SHADOWLAP_TEST_R2_KEYS=<id>:<secret>
 *   SHADOWLAP_TEST_GCS_URL=gs://bucket/folder?endpoint=http://127.0.0.1:4443
 *   SHADOWLAP_TEST_AZURE_URL=az://devstoreaccount1/container/folder  SHADOWLAP_TEST_AZURITE=<connection string>
 *
 * The bucket or container must exist. On each, as two teammates: store set --check, push --all of
 * a run and its fix, a share link opened without credentials (and refused once tampered with,
 * where the store checks signatures), and a pull that brings the run, the fix and its patch.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GOLDEN = join(ROOT, 'testing', 'golden', 'reference-agent');
const UI = join(ROOT, 'packages', 'dashboard', 'dist', 'ui');
const env = process.env;
let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'sl-team-emulators-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface Machine extends TeamEnv {
  take(): { out: string; err: string };
}

function machine(name: string, author: string, extra: NodeJS.ProcessEnv): Machine {
  const cwd = join(work, name);
  mkdirSync(cwd, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    dbPath: join(cwd, '.shadowlap', 'shadowlap.db'),
    env: { SHADOWLAP_AUTHOR: author, NO_COLOR: '1', AWS_EC2_METADATA_DISABLED: 'true', ...extra },
    now: () => Date.now(),
    open: { home: join(work, 'no-home') },
    io: { out: (t) => void out.push(t), err: (t) => void err.push(t) },
    take() {
      const r = { out: out.join(''), err: err.join('') };
      out.length = 0;
      err.length = 0;
      return r;
    },
  };
}

/** A folder of its own in the store for each run of the tests. */
function fresh(url: string): string {
  const [base, query] = url.split('?');
  return `${base!.replace(/\/+$/, '')}/e2e-${Date.now().toString(36)}${query ? `?${query}` : ''}`;
}

/** A recording of the reference agent, as made here, failed and blamed, with a repair that fixed it. */
function runWithFix(m: Machine): { runId: string; fixId: string } {
  const store = Store.open(m.dbPath);
  try {
    const runId = unpackRun(store, GOLDEN).imported[0]!;
    store.updateRunMeta(runId, { imported: undefined, labels: ['refund-bug'] } as unknown as Partial<RunMeta>);
    const fixId = recordBlame(store, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund called 0 times', actor: 'dana@northwind.example' }).fix.fixId;
    recordRepair(store, { repairId: 'repair-e2e', dir: '.shadowlap/repairs/repair-e2e', report: repairReport({ targets: [runId], dir: '.shadowlap/repairs/repair-e2e' }), expect: EXPECT, command: `shadowlap repair --fixes ${runId}` });
    return { runId, fixId };
  } finally {
    store.close();
  }
}

/** The two teammates' story on one store; returns the share link's address for the caller to open. */
async function story(url: string, creds: NodeJS.ProcessEnv): Promise<{ link: string }> {
  const dana = machine(`dana-${url.slice(0, 2)}`, 'dana@northwind.example', creds);
  expect(await storeSetChecked(dana, url)).toBe(0);
  expect(dana.take().out).toMatch(/✓ list[\s\S]*✓ delete[\s\S]*✓ Store set/);
  const { runId, fixId } = runWithFix(dana);
  expect(await teamPush(dana, [], { all: true })).toBe(0);
  expect(dana.take().out).toMatch(/✓ 1 run pushed[\s\S]*1 fix sent/);
  expect(await teamShare(dana, runId, { ...(existsSync(UI) ? { uiDir: UI } : {}), json: true })).toBe(0);
  const share = JSON.parse(dana.take().out) as { url: string };

  const maya = machine(`maya-${url.slice(0, 2)}`, 'maya@northwind.example', creds);
  writeFileSync(join(maya.cwd, 'shadowlap.config.json'), readFileSync(join(dana.cwd, 'shadowlap.config.json')));
  expect(await teamPull(maya, [])).toBe(0);
  expect(maya.take().out).toMatch(/✓ 1 run pulled \(dana 1\)[\s\S]*1 fix pulled/);
  const store = Store.open(maya.dbPath);
  try {
    expect(store.getRun(runId)!.meta?.author).toBe('dana@northwind.example');
    expect(store.getFix(fixId)!.status).toBe('verified');
  } finally {
    store.close();
  }
  expect(existsSync(join(maya.cwd, '.shadowlap', 'repairs', 'repair-e2e', 'fix.patch'))).toBe(true);
  expect(await storeCheck(maya)).toBe(0);
  return { link: share.url };
}

describe.skipIf(!env.SHADOWLAP_TEST_S3_URL)('an S3-compatible server', () => {
  it('pushes, pulls, checks and shares, every request signed and checked by the server', async () => {
    const [id, secret] = (env.SHADOWLAP_TEST_S3_KEYS ?? ':').split(':');
    const { link } = await story(fresh(env.SHADOWLAP_TEST_S3_URL!), { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret });
    const res = await fetch(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect((await fetch(link.replace(/X-Amz-Signature=([0-9a-f])/, (_m, c: string) => `X-Amz-Signature=${c === '0' ? '1' : '0'}`))).status).toBe(403);
    expect((await fetch(link.split('?')[0]!)).status).toBe(403);
  }, 120_000);
});

describe.skipIf(!env.SHADOWLAP_TEST_R2_URL)('an r2:// store on an S3-compatible server', () => {
  it("pushes, pulls, checks and shares with an R2 token's keys", async () => {
    const [id, secret] = (env.SHADOWLAP_TEST_R2_KEYS ?? ':').split(':');
    const { link } = await story(fresh(env.SHADOWLAP_TEST_R2_URL!), { R2_ACCESS_KEY_ID: id, R2_SECRET_ACCESS_KEY: secret });
    expect((await fetch(link)).status).toBe(200);
  }, 120_000);
});

describe.skipIf(!env.SHADOWLAP_TEST_GCS_URL)("Google's Cloud Storage emulator", () => {
  let server: Server;
  let keyFile: string;
  let publicPem: string;
  beforeAll(async () => {
    // A service account whose key signs share links, and a stand-in for Google's token endpoint that
    // checks the signed assertion the key makes before handing out an access token.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const [h, c, s] = (new URLSearchParams(body).get('assertion') ?? '').split('.');
        const ok = !!(h && c && s) && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey(publicPem), Buffer.from(s!, 'base64url'));
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(ok ? JSON.stringify({ access_token: 'ya29.emulator', expires_in: 3600, token_type: 'Bearer' }) : '{"error":"invalid_grant"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    keyFile = join(work, 'gcs-key.json');
    writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: 'shadowlap-ci@northwind.iam.gserviceaccount.com', private_key_id: 'k1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `http://127.0.0.1:${port}/token` }));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('pushes, pulls, checks and shares, the link signed with the service account’s key', async () => {
    const { link } = await story(fresh(env.SHADOWLAP_TEST_GCS_URL!), { GOOGLE_APPLICATION_CREDENTIALS: keyFile });
    const res = await fetch(link);
    expect(res.status).toBe(200);
    // The emulator doesn't check signatures; Cloud Storage would: checked here as it does.
    const u = new URL(link);
    const params = [...u.searchParams.entries()].filter(([k]) => k !== 'X-Goog-Signature').sort(([a], [b]) => (a < b ? -1 : 1));
    const enc = (x: string) => encodeURIComponent(x).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    const canon = ['GET', u.pathname, params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&'), `host:${u.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = u.searchParams.get('X-Goog-Credential')!.split('/').slice(1).join('/');
    const toSign = ['GOOG4-RSA-SHA256', u.searchParams.get('X-Goog-Date'), scope, createHash('sha256').update(canon).digest('hex')].join('\n');
    expect(createVerify('RSA-SHA256').update(toSign).verify(publicPem, Buffer.from(u.searchParams.get('X-Goog-Signature')!, 'hex'))).toBe(true);
    expect(u.searchParams.get('X-Goog-Expires')).toBe('604800');
  }, 120_000);
});

describe.skipIf(!env.SHADOWLAP_TEST_AZURE_URL || !env.SHADOWLAP_TEST_AZURITE)("Azure's storage emulator", () => {
  it('pushes, pulls, checks and shares, with Shared Key requests and a SAS link the emulator checks', async () => {
    const { link } = await story(fresh(env.SHADOWLAP_TEST_AZURE_URL!), { AZURE_STORAGE_CONNECTION_STRING: env.SHADOWLAP_TEST_AZURITE });
    const res = await fetch(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const tampered = new URL(link);
    const sig = tampered.searchParams.get('sig')!;
    tampered.searchParams.set('sig', `${sig.slice(0, 5)}${sig[5] === 'A' ? 'B' : 'A'}${sig.slice(6)}`);
    expect((await fetch(tampered)).status).toBe(403);
  }, 120_000);
});
