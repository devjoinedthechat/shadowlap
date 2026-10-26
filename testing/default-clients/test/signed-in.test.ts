import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLACEHOLDER_AWS_ACCESS_KEY_ID, PLACEHOLDER_KEY } from '@shadowlap/sidecar';
import { answered, ciEnv, CLI, committed, findPython, HERE, node, recorded, refusal, run, startProviders, workdir, type Providers } from './clients.js';

/**
 * Agents that bring a credential of their own, not a key the environment holds when they start:
 * a profile the developer signed in with, a key from a .env file the agent loads, a Microsoft Entra
 * ID token provider, an instance role. No replay puts a placeholder in place of any of them: a clean
 * replay is clean, `shadowlap test` passes in a job without them, and a fork goes live with what the
 * agent has. And where in-process capture is off, or the call is to a host declared under `http`, no
 * placeholder goes anywhere either.
 */

let providers: Providers;
let work: ReturnType<typeof workdir>;
const env = (extra: Record<string, string> = {}) => ciEnv(providers, work.empty, extra);
const shadowlap = (args: string[], extra: Record<string, string> = {}, db = 'store.db', cwd = work.dir) => run([process.execPath, CLI, '--db', join(work.dir, db), ...args], cwd, env(extra));
const last = (p: Parameters<Providers['seen']>[0]) => providers.seen(p).at(-1)!;

beforeAll(async () => {
  providers = await startProviders();
  work = workdir('sl-signed-in-');
});

afterAll(async () => {
  const carried = providers.all().filter((r) => JSON.stringify(r).includes(PLACEHOLDER_KEY) || JSON.stringify(r).includes(`Credential=${PLACEHOLDER_AWS_ACCESS_KEY_ID}/`));
  expect(carried).toEqual([]);
  await providers.close();
  work.remove();
});

describe('signed in with an Anthropic profile, no key in the environment', () => {
  let profile = '';
  let runId = '';
  beforeAll(async () => {
    // The active profile, as `ant auth login` leaves it: a config and a token for it.
    profile = join(work.dir, 'anthropic-profile');
    mkdirSync(join(profile, 'configs'), { recursive: true });
    mkdirSync(join(profile, 'credentials'), { recursive: true });
    writeFileSync(join(profile, 'configs', 'default.json'), JSON.stringify({ authentication: { type: 'user_oauth' } }));
    writeFileSync(join(profile, 'credentials', 'default.json'), JSON.stringify({ type: 'oauth_token', access_token: 'oauth-token-of-the-developer', expires_at: 4102444800 }), { mode: 0o600 });
    const made = await shadowlap(['run', '--', ...node('anthropic.mjs')], { ANTHROPIC_CONFIG_DIR: profile });
    expect(made.code, made.out).toBe(0);
    runId = recorded(made.out);
    expect(last('anthropic').headers).toMatchObject({ authorization: 'Bearer oauth-token-of-the-developer', 'anthropic-beta': expect.stringContaining('oauth-') });
    expect((await shadowlap(['pack', runId, 'goldens/profile'])).code).toBe(0);
    committed(work.dir, 'goldens/profile');
  });

  it('replays clean on the developer machine, with the profile: no placeholder takes its place', async () => {
    const before = providers.seen('anthropic').length;
    const r = await shadowlap(['replay', runId, '--strict'], { ANTHROPIC_CONFIG_DIR: profile });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Replay clean: 1\/1 calls replayed/);
    expect(providers.seen('anthropic').length).toBe(before);
  });

  it('passes shadowlap test in a job with no profile and no key, as the sign-in beta is no part of the match', async () => {
    const r = await shadowlap(['test', 'goldens/profile'], {}, 'ci-profile.db');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('1 passed, 0 failed');
  });

  it("goes live on a fork with the profile's token", async () => {
    const before = providers.seen('anthropic').length;
    const r = await shadowlap(['replay', runId], { ANTHROPIC_CONFIG_DIR: profile, PROMPT: 'goodbye' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(answered('goodbye'));
    expect(providers.seen('anthropic').length).toBe(before + 1);
    expect(last('anthropic').headers.authorization).toBe('Bearer oauth-token-of-the-developer');
  });
});

describe('a key the agent loads from its .env file', () => {
  let project = '';
  let runId = '';
  beforeAll(async () => {
    project = join(work.dir, 'dotenv-project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.env'), 'OPENAI_API_KEY=sk-from-dotenv\n');
    const made = await shadowlap(['run', '--', ...node('dotenv-openai.mjs')], {}, 'store.db', project);
    expect(made.code, made.out).toBe(0);
    runId = recorded(made.out);
    expect(last('openai').headers.authorization).toBe('Bearer sk-from-dotenv');
    expect((await shadowlap(['pack', runId, join(project, 'goldens', 'dotenv')], {}, 'store.db', project)).code).toBe(0);
    committed(project, 'goldens/dotenv');
  });

  it('replays clean, and its fork goes live with the key from .env, which no placeholder shadows', async () => {
    const before = providers.seen('openai').length;
    const clean = await shadowlap(['replay', runId, '--strict'], {}, 'store.db', project);
    expect(clean.code, clean.out).toBe(0);
    expect(providers.seen('openai').length).toBe(before);
    const fork = await shadowlap(['replay', runId], { PROMPT: 'goodbye' }, 'store.db', project);
    expect(fork.code, fork.out).toBe(0);
    expect(fork.out).toMatch(answered('goodbye'));
    expect(providers.seen('openai').length).toBe(before + 1);
    expect(last('openai').headers.authorization).toBe('Bearer sk-from-dotenv');
  });

  it('passes shadowlap test, with the .env file and in a job without it', async () => {
    expect(await shadowlap(['test', 'goldens/dotenv'], {}, 'ci-dotenv.db', project)).toMatchObject({ code: 0, out: expect.stringContaining('1 passed, 0 failed') });
    rmSync(join(project, '.env'));
    // The agent loads a .env that isn't there: it runs on the placeholder, offline.
    writeFileSync(join(project, '.env'), '');
    expect(await shadowlap(['test', 'goldens/dotenv'], {}, 'ci-dotenv-2.db', project)).toMatchObject({ code: 0, out: expect.stringContaining('1 passed, 0 failed') });
  });
});

describe('Azure OpenAI signed in with a Microsoft Entra ID token provider', () => {
  let runId = '';
  beforeAll(async () => {
    const made = await shadowlap(['run', '--', ...node('azure-entra.mjs')]);
    expect(made.code, made.out).toBe(0);
    runId = recorded(made.out);
    expect(last('azure').headers.authorization).toBe('Bearer entra-token-of-the-developer');
    expect((await shadowlap(['pack', runId, 'goldens/entra'])).code).toBe(0);
    committed(work.dir, 'goldens/entra');
  });

  it('replays clean and passes shadowlap test: no key goes beside the token provider, which the client refuses', async () => {
    const before = providers.seen('azure').length;
    const clean = await shadowlap(['replay', runId, '--strict']);
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).not.toContain('mutually exclusive');
    const tested = await shadowlap(['test', 'goldens/entra'], {}, 'ci-entra.db');
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toContain('1 passed, 0 failed');
    expect(providers.seen('azure').length).toBe(before);
  });

  it('goes live on a fork with the Entra ID token', async () => {
    const before = providers.seen('azure').length;
    const r = await shadowlap(['replay', runId], { PROMPT: 'goodbye' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(answered('goodbye'));
    expect(providers.seen('azure').length).toBe(before + 1);
    expect(last('azure').headers.authorization).toBe('Bearer entra-token-of-the-developer');
  });
});

const boto3 = findPython('boto3');

describe.skipIf(!boto3)('Bedrock through boto3 on an instance role, which the metadata service hands out', () => {
  let imds: Server;
  let role: Record<string, string>;
  let runId = '';
  beforeAll(async () => {
    // An instance metadata service, as EC2's: a session token, the role's name, then its credentials.
    imds = createServer((req, res) => {
      const p = req.url ?? '';
      if (req.method === 'PUT' && p.startsWith('/latest/api/token')) return res.end('imds-session-token');
      if (/security-credentials(-extended)?\/$/.test(p)) return res.end('instance-role');
      if (/security-credentials(-extended)?\/instance-role$/.test(p)) return res.end(JSON.stringify({ Code: 'Success', Type: 'AWS-HMAC', AccessKeyId: 'ASIAINSTANCEROLE', SecretAccessKey: 'instance-role-secret', Token: 'instance-role-session', Expiration: '2099-01-01T00:00:00Z', LastUpdated: '2026-10-21T00:00:00Z' }));
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => imds.listen(0, '127.0.0.1', resolve));
    role = { AWS_EC2_METADATA_DISABLED: 'false', AWS_EC2_METADATA_SERVICE_ENDPOINT: `http://127.0.0.1:${(imds.address() as AddressInfo).port}` };
    const made = await shadowlap(['run', '--', boto3!, join(HERE, 'boto_agent.py')], role);
    expect(made.code, made.out).toBe(0);
    runId = recorded(made.out);
    expect(String(last('bedrock').headers.authorization)).toContain('Credential=ASIAINSTANCEROLE/');
    expect((await shadowlap(['pack', runId, 'goldens/role'])).code).toBe(0);
    committed(work.dir, 'goldens/role');
  });
  afterAll(() => new Promise<void>((resolve) => imds.close(() => resolve())));

  it('replays clean with the role, passes shadowlap test in a job without one, and its fork is signed with the role', async () => {
    const before = providers.seen('bedrock').length;
    const clean = await shadowlap(['replay', runId, '--strict'], role);
    expect(clean.code, clean.out).toBe(0);
    const tested = await shadowlap(['test', 'goldens/role'], {}, 'ci-role.db');
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toContain('1 passed, 0 failed');
    expect(providers.seen('bedrock').length).toBe(before);
    const fork = await shadowlap(['replay', runId], { ...role, PROMPT: 'goodbye' });
    expect(fork.code, fork.out).toBe(0);
    expect(fork.out).toMatch(answered('goodbye'));
    expect(providers.seen('bedrock').length).toBe(before + 1);
    expect(String(last('bedrock').headers.authorization)).toContain('Credential=ASIAINSTANCEROLE/');
  });
});

describe('in-process capture off', () => {
  it('gives Azure OpenAI and Bedrock no placeholder, since their calls would go straight to the provider', async () => {
    const made = await shadowlap(['run', '--', ...node('azure.mjs')], { AZURE_OPENAI_API_KEY: 'az-recording' });
    expect(made.code, made.out).toBe(0);
    const azure = recorded(made.out);
    expect((await shadowlap(['pack', azure, 'goldens/azure-capture'])).code).toBe(0);
    committed(work.dir, 'goldens/azure-capture');
    const viaBoto = boto3 ? await shadowlap(['run', '--', boto3, join(HERE, 'boto_agent.py')], { AWS_ACCESS_KEY_ID: 'AKIARECORDING', AWS_SECRET_ACCESS_KEY: 'recording-secret' }) : null;
    if (viaBoto) expect(viaBoto.code, viaBoto.out).toBe(0);
    const before = providers.all().length;
    // The agent's own endpoint is the front itself: whatever it sent, the front would get.
    const off = { SHADOWLAP_CAPTURE: 'off', AZURE_OPENAI_ENDPOINT: providers.urls.azure };
    const replayed = await shadowlap(['replay', azure], off);
    expect(replayed.out).toMatch(/Missing credentials/);
    const calibrated = await shadowlap(['calibrate', azure], off);
    expect(calibrated.out).toMatch(/Missing credentials/);
    const tested = await shadowlap(['test', 'goldens/azure-capture'], off, 'ci-capture-off.db');
    expect(tested.code).toBe(1);
    if (viaBoto) {
      const r = await shadowlap(['replay', recorded(viaBoto.out)], { SHADOWLAP_CAPTURE: 'off', AWS_ENDPOINT_URL_BEDROCK_RUNTIME: providers.urls.bedrock });
      expect(r.out).toMatch(/NoCredentialsError|Unable to locate credentials/);
    }
    expect(providers.all().length).toBe(before);
  });
});

describe('a read declared under http that passes the OpenAI key on', () => {
  let vectors: Server;
  const received: Array<string | undefined> = [];
  let project = '';
  let name = '';
  let runId = '';
  beforeAll(async () => {
    vectors = createServer((req, res) => {
      received.push(req.headers['x-openai-api-key'] as string | undefined);
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"orders":["A-1042"]}}');
    });
    await new Promise<void>((resolve) => vectors.listen(0, '127.0.0.1', resolve));
    const host = `127.0.0.1:${(vectors.address() as AddressInfo).port}`;
    name = `POST ${host}/v1/graphql`;
    project = join(work.dir, 'vector-project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ http: { [host]: 'read' } }));
    const made = await shadowlap(['run', '--', ...node('vector.mjs')], { OPENAI_API_KEY: 'sk-recording', VECTOR_DB: `http://${host}` }, 'store.db', project);
    expect(made.code, made.out).toBe(0);
    runId = recorded(made.out);
    expect(received).toEqual(['sk-recording']);
  });
  afterAll(() => new Promise<void>((resolve) => vectors.close(() => resolve())));

  it('replays clean from the recording, and run live with --live-tool is refused in one line, the host sent nothing', async () => {
    const vector = `http://${name.split(' ')[1].split('/')[0]}`;
    const clean = await shadowlap(['replay', runId, '--strict'], { VECTOR_DB: vector }, 'store.db', project);
    expect(clean.code, clean.out).toBe(0);
    const before = [received.length, providers.seen('openai').length];
    const r = await shadowlap(['replay', runId, '--live-tool', name], { VECTOR_DB: vector }, 'store.db', project);
    expect(r.out).toContain(`${name}: a live call needs a real key: set the key it sends, or keep the replay offline`);
    // The read was refused, so the model was asked about a refused read: that call is refused too.
    expect(r.out).toContain(refusal('OPENAI_API_KEY'));
    expect(r.out).toMatch(/then 0 live, 2 refused; 0 upstream requests/);
    expect([received.length, providers.seen('openai').length]).toEqual(before);
  });
});
