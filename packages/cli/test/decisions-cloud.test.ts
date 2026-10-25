import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type DecisionsReport } from '@shadowlap/engine';

/**
 * `shadowlap decisions` on the cloud platforms, end to end against their mock (testing/frameworks):
 * Amazon Bedrock (InvokeModel with a Claude body, Converse, and ConverseStream's event stream), Vertex
 * AI (a Claude model's rawPredict, a Gemini model's generateContent) and Azure OpenAI (a deployment,
 * which needs its api-version). Each run is recorded through the sidecar as in-process capture sends
 * it, then asked again under another model: a Bedrock request signed for the AWS host it is for, a
 * Vertex AI one with a Google token, an Azure one with its key and the api-version it was sent with.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const REMOTE = new URL('../../remote/dist/index.js', import.meta.url).href;
const CLOUD_MOCK = new URL('../../../testing/frameworks/cloud-mock.mjs', import.meta.url).href;
const BEDROCK_MODEL = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

interface CloudMock {
  url: string;
  stats: { requests: number; signaturesOk: number; signatureFailures: string[]; seen: Array<{ method: string; url: string }> };
  close(): Promise<void>;
}

let cloud: CloudMock;
let aws: { accessKeyId: string; secretAccessKey: string; region: string };
let cwd: string;
let db: string;

/** Calls each platform as its in-process capture sends them to the sidecar: the agent's own signature and credentials, the host it meant in a header. */
const AGENT = `
import { createHash } from 'node:crypto';
import { signRequest } from ${JSON.stringify(REMOTE)};
import { AWS, SIGNED_HOST } from ${JSON.stringify(CLOUD_MOCK)};
const base = process.env.SHADOWLAP_URL + '/r/' + process.env.SHADOWLAP_RUN_ID;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const said = { role: 'user', content: 'hello' };
async function send(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const bytes = await res.arrayBuffer();
  if (!res.ok) throw new Error(url + ': ' + res.status + ' ' + Buffer.from(bytes).toString());
}
async function bedrock(op, body) {
  const path = '/model/' + encodeURIComponent(${JSON.stringify(BEDROCK_MODEL)}) + '/' + op;
  const raw = Buffer.from(JSON.stringify(body));
  const signed = signRequest({ method: 'POST', path: path.split('/').map(rfc3986).join('/'), query: '', headers: { host: SIGNED_HOST, 'content-type': 'application/json', 'x-amz-content-sha256': sha256(raw) }, payloadHash: sha256(raw) }, { region: AWS.region, service: 'bedrock', date: new Date(), credentials: { accessKeyId: AWS.accessKeyId, secretAccessKey: AWS.secretAccessKey } });
  await send(base + '/bedrock' + path, { 'x-amz-content-sha256': sha256(raw), ...signed.add, 'x-shadowlap-upstream': 'https://' + SIGNED_HOST }, raw);
}
const which = process.env.CLOUD_CASE;
if (which === 'bedrock') {
  await bedrock('converse', { messages: [{ role: 'user', content: [{ text: 'hello' }] }] });
  await bedrock('invoke', { anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages: [said] });
  await bedrock('converse-stream', { messages: [{ role: 'user', content: [{ text: 'hello again' }] }] });
}
if (which === 'vertex') {
  const vertex = base + '/vertex/v1/projects/p/locations/us-east5/publishers';
  const upstream = { authorization: 'Bearer ya29.test', 'x-shadowlap-upstream': 'https://us-east5-aiplatform.googleapis.com' };
  await send(vertex + '/anthropic/models/claude-3-5-haiku@20241022:rawPredict', upstream, JSON.stringify({ anthropic_version: 'vertex-2023-10-16', max_tokens: 64, messages: [said] }));
  await send(vertex + '/google/models/gemini-2.5-flash:generateContent', upstream, JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }));
}
if (which === 'azure') {
  await send(base + '/azure/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21', { 'api-key': 'az-test', 'x-shadowlap-upstream': 'https://acme.openai.azure.com' }, JSON.stringify({ messages: [said] }));
}
`;

/**
 * These tests are about how each request is signed, addressed and answered, so a step is asked once:
 * by default decisions also asks each step as recorded, three times a side (the control arm, which
 * decisions.test.ts covers).
 */
const once = (args: string[]): string[] => (args[0] === 'decisions' && !args.includes('--samples') && !args.includes('--verify') ? [...args, '--samples', '1'] : args);

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  // This machine's own cloud settings stay out: the mock's test credentials are the only ones.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AWS_|AZURE_OPENAI_|OPENAI_API_VERSION$|GOOGLE_)/.test(k)));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...once(args)], {
      cwd,
      env: {
        ...inherited,
        SHADOWLAP_UPSTREAM_BEDROCK: cloud.url,
        SHADOWLAP_UPSTREAM_VERTEX: cloud.url,
        SHADOWLAP_UPSTREAM_AZURE: cloud.url,
        AWS_ACCESS_KEY_ID: aws.accessKeyId,
        AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
        AWS_REGION: aws.region,
        GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.test',
        AZURE_OPENAI_API_KEY: 'az-test',
        SHADOWLAP_TELEMETRY: '0',
        NO_COLOR: '1',
        SHADOWLAP_GUARD: 'off',
        SHADOWLAP_HOME: join(cwd, 'home'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

const json = <T,>(r: { stdout: string; out: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};

async function record(which: string): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, 'agent.mjs'], { CLOUD_CASE: which });
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1];
}

beforeAll(async () => {
  const mod = (await import(CLOUD_MOCK)) as { startCloudMock: () => Promise<CloudMock>; AWS: typeof aws };
  cloud = await mod.startCloudMock();
  aws = mod.AWS;
  cwd = mkdtempSync(join(tmpdir(), 'sl-decisions-cloud-'));
  db = join(cwd, 'store.db');
  writeFileSync(join(cwd, 'agent.mjs'), AGENT);
});
afterAll(async () => {
  await cloud?.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap decisions on the cloud platforms', () => {
  it('Amazon Bedrock: InvokeModel, Converse and ConverseStream, each signed for the AWS host it is for', async () => {
    const runId = await record('bedrock');
    const seen = cloud.stats.seen.length;
    const failures = cloud.stats.signatureFailures.length;
    const ok = cloud.stats.signaturesOk;
    const r = await shadowlap(['decisions', runId, '--model', 'anthropic.claude-haiku-4-5-20251001-v1:0', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(cloud.stats.signatureFailures.slice(failures)).toEqual([]);
    expect(cloud.stats.signaturesOk - ok).toBe(3);
    // The model switched where Bedrock names it, in the path; the streamed answer read from its event stream.
    expect(cloud.stats.seen.slice(seen).map((q) => q.url).sort()).toEqual(['converse', 'converse-stream', 'invoke'].map((op) => `/model/${encodeURIComponent('anthropic.claude-haiku-4-5-20251001-v1:0')}/${op}`).sort());
    expect(report.runs[0]).toMatchObject({ steps: 3, asked: 3, rank: null, counts: { same: 3, notAsked: 0 } });
    expect(report.runs[0].decisions.map((s) => s.now?.text).sort()).toEqual(['echo: hello', 'echo: hello', 'echo: hello again']);
  }, 120_000);

  it("Vertex AI: a Claude model's rawPredict and a Gemini model's generateContent, each by the model it switches from", async () => {
    const runId = await record('vertex');
    let seen = cloud.stats.seen.length;
    // The runs use two models as much: the switch is at the first by name, the Claude model, and leaves Gemini's call.
    const claude = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', 'claude-3-7-sonnet@20250219', '--json']));
    expect(claude.change.from).toEqual(['claude-3-5-haiku@20241022']);
    expect(cloud.stats.seen.slice(seen).map((q) => q.url)).toEqual(['/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-3-7-sonnet@20250219:rawPredict']);
    expect(claude.runs[0].counts).toMatchObject({ same: 1, untouched: 1 });

    seen = cloud.stats.seen.length;
    const gemini = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', 'gemini-3.8-flash', '--from', 'gemini-2.5-flash', '--json']));
    expect(cloud.stats.seen.slice(seen).map((q) => q.url)).toEqual(['/v1/projects/p/locations/us-east5/publishers/google/models/gemini-3.8-flash:generateContent']);
    expect(gemini.runs[0].counts).toMatchObject({ same: 1, untouched: 1, notAsked: 0 });
    // Gemini 2.5 Flash retires on Vertex AI: the report says so.
    expect(gemini.retirements.map((n) => n.model)).toContain('gemini-2.5-flash');
  }, 120_000);

  it('Azure OpenAI: a deployment asked with the api-version it was sent with, and refused without one', async () => {
    const runId = await record('azure');
    const store = Store.open(db);
    let copy: number;
    try {
      const calls = store.getCalls(runId);
      const call = calls.find((c) => c.kind === 'api')!;
      // The recording keeps the query the agent sent, credentials left out.
      expect(call.meta.query).toBe('api-version=2024-10-21');
      // A call recorded before recordings kept a call's query.
      const { end, attempts: _attempts, ...start } = call;
      const { query: _query, ...meta } = start.meta;
      copy = Math.max(...calls.map((c) => c.callNo)) + 1;
      store.appendCallStart({ ...start, callNo: copy, meta });
      store.appendCallEnd({ kind: start.kind, name: start.name, fingerprint: start.fingerprint, occurrence: start.occurrence }, { ...end!, callNo: copy });
    } finally {
      store.close();
    }

    const refused = await shadowlap(['decisions', runId, '--model', 'gpt-4o-mini', '--json']);
    expect(refused.code).toBe(2);
    expect(json<{ error: { message: string } }>(refused).error.message).toBe("nothing was sent: an Azure OpenAI deployment call needs the api-version it was sent with, which this recording doesn't keep (it was made before recordings kept a call's query): set OPENAI_API_VERSION to it, as the AzureOpenAI SDKs read it");

    const seen = cloud.stats.seen.length;
    const r = await shadowlap(['decisions', runId, '--model', 'gpt-4o-mini', '--json'], { OPENAI_API_VERSION: '2024-10-21' });
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(cloud.stats.seen.slice(seen).map((q) => q.url)).toEqual(Array(2).fill('/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21'));
    expect(report.runs[0]).toMatchObject({ asked: 2, counts: { same: 2 } });
    expect(report.runs[0].decisions.map((s) => s.callNo)).toContain(copy!);
  }, 120_000);
});
