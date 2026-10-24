// Amazon Bedrock, Vertex AI and Azure OpenAI through their official clients, run by the real CLI:
// record, replay with the upstream unreachable, and fork on a changed prompt. None of these clients
// can be redirected with a base URL (Bedrock signs for its host; Azure and Vertex take their endpoint
// or region in code), so every call is captured inside the agent's process. The mock checks each
// Bedrock request's SigV4 signature against the host it was signed for.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { Store } from '../../packages/engine/dist/index.js';
import { AWS, startCloudMock } from './cloud-mock.mjs';
import { findPython } from './python.mjs';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const agentPath = (name) => fileURLToPath(new URL(`./cloud/${name}`, import.meta.url));
const PYTHON = findPython('boto3');

let mock;
let dir;
before(async () => {
  mock = await startCloudMock();
  dir = mkdtempSync(join(tmpdir(), 'fp-cloud-'));
});
after(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Run in the test's own folder: run and replay keep their active-run file in the one they run in.
async function shadowlap(db, args, env) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, '--db', db, ...args], {
      cwd: dir,
      env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', AWS_ACCESS_KEY_ID: AWS.accessKeyId, AWS_SECRET_ACCESS_KEY: AWS.secretAccessKey, AWS_REGION: AWS.region, AWS_EC2_METADATA_DISABLED: 'true', ...env },
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { code: 0, out: stdout + stderr, stdout };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
  }
}
const texts = (stdout) => JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()).texts;

const CASES = [
  { name: 'Bedrock, AWS SDK (Converse and ConverseStream)', provider: 'bedrock', argv: [process.execPath, agentPath('bedrock-aws.mjs')], models: 'anthropic.claude-3-5-haiku-20241022-v1:0', calls: 2, signed: true },
  { name: 'Bedrock, Anthropic Bedrock client (InvokeModel, streamed and not)', provider: 'bedrock', argv: [process.execPath, agentPath('bedrock-anthropic.mjs')], calls: 2, signed: true },
  { name: 'Vertex AI, Anthropic Vertex client with the region in code', provider: 'vertex', argv: [process.execPath, agentPath('vertex-anthropic.mjs')], calls: 2 },
  { name: 'Vertex AI, Google GenAI in express mode', provider: 'vertex', argv: [process.execPath, agentPath('vertex-genai.mjs')], calls: 1 },
  { name: 'Azure OpenAI, AzureOpenAI with the endpoint in code', provider: 'azure', argv: [process.execPath, agentPath('azure-openai.mjs')], calls: 2 },
  { name: 'Bedrock, boto3 (Python)', provider: 'bedrock', argv: [PYTHON, agentPath('bedrock_boto3.py')], calls: 2, signed: true, python: true },
  // Signs its Accept-Encoding, which the sidecar forwards as the client sent it.
  { name: 'Bedrock, anthropic.AnthropicBedrock (Python, InvokeModel, streamed and not)', provider: 'bedrock', argv: [PYTHON, agentPath('bedrock_anthropic.py')], calls: 2, signed: true, python: true },
  { name: 'Azure OpenAI, openai.AzureOpenAI (Python)', provider: 'azure', argv: [PYTHON, agentPath('azure_openai.py')], calls: 2, python: true },
  { name: 'Vertex AI, anthropic.AnthropicVertex (Python)', provider: 'vertex', argv: [PYTHON, agentPath('vertex_anthropic.py')], calls: 1, python: true },
];

for (const c of CASES) {
  describe(c.name, { skip: c.python && !PYTHON ? 'no Python with boto3, openai and anthropic[vertex] (set SHADOWLAP_PYTHON)' : false }, () => {
    const upstream = `SHADOWLAP_UPSTREAM_${c.provider.toUpperCase()}`;
    let db;
    let recordedRun;
    let recordedTexts;

    it('records every call through in-process capture', async () => {
      db = join(dir, `${c.provider}-${CASES.indexOf(c)}.db`);
      const signedBefore = mock.stats.signaturesOk;
      const r = await shadowlap(db, ['run', '--', ...c.argv], { [upstream]: mock.url, PROMPT: 'hello' });
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /bypasses Shadowlap/);
      recordedTexts = texts(r.stdout);
      assert.match(recordedTexts[0], /^echo: hello/);
      recordedRun = /recording run (\w{26})/.exec(r.out)[1];
      const store = Store.open(db);
      const calls = store.getCalls(recordedRun);
      store.close();
      assert.equal(calls.length, c.calls, JSON.stringify(calls.map((x) => x.name)));
      assert.ok(calls.every((x) => x.kind === 'api' && x.origin === 'live' && x.end?.outcome === 'ok' && x.meta.provider === c.provider), JSON.stringify(calls.map((x) => [x.name, x.meta.provider, x.end?.outcome, x.end?.meta.status])));
      assert.ok(calls.every((x) => x.end.meta.usage?.outputTokens === 5), 'usage is read from every response, streamed or not');
      if (c.signed) assert.equal(mock.stats.signaturesOk - signedBefore, c.calls, mock.stats.signatureFailures.join('\n'));
      if (c.models) assert.equal(calls[0].end.meta.model ?? calls[0].meta.model, c.models);
    });

    it('replays with the upstream unreachable, serving the same answers', async () => {
      const r = await shadowlap(db, ['replay', recordedRun, '--strict'], { [upstream]: 'http://127.0.0.1:9', PROMPT: 'hello' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, new RegExp(`Replay clean: ${c.calls}/${c.calls} calls replayed`));
      assert.deepEqual(texts(r.stdout), recordedTexts);
    });

    it('forks with --set in the provider\'s own shape, signed again where the client signs', async () => {
      const before = { ok: mock.stats.signaturesOk, failures: mock.stats.signatureFailures.length };
      const r = await shadowlap(db, ['replay', recordedRun, '--set', '1:temperature=0'], { [upstream]: mock.url, PROMPT: 'hello' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /changed by --set 1:temperature=0/);
      assert.deepEqual(texts(r.stdout), recordedTexts);
      if (c.signed) {
        // Every changed request was signed again, and the provider accepted the signature.
        assert.deepEqual(mock.stats.signatureFailures.slice(before.failures), []);
        assert.equal(mock.stats.signaturesOk - before.ok, c.calls);
      }
    });

    if (c.signed) {
      it('runs as a golden in shadowlap test with no AWS credentials in the environment', async () => {
        const pack = join(dir, `pack-${CASES.indexOf(c)}`);
        const packed = await shadowlap(db, ['pack', recordedRun, pack], {});
        assert.equal(packed.code, 0, packed.out);
        const home = mkdtempSync(join(dir, 'home-'));
        const env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', HOME: home, USERPROFILE: home, AWS_REGION: AWS.region, AWS_EC2_METADATA_DISABLED: 'true', PROMPT: 'hello' };
        for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) delete env[name];
        // A store of its own: the session it keeps never lands in a .shadowlap folder here.
        const r = await promisify(execFile)(process.execPath, [CLI, '--db', join(dir, `test-${CASES.indexOf(c)}.db`), 'test', pack], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 }).then(
          ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
          (err) => ({ code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }),
        );
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /1 passed, 0 failed/);
      });
    }

    it('forks on a changed prompt and goes live from there', async () => {
      const r = await shadowlap(db, ['replay', recordedRun], { [upstream]: mock.url, PROMPT: 'goodbye' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Diverged at call 1/);
      assert.match(texts(r.stdout)[0], /^echo: goodbye/);
    });
  });
}

describe('an agent with its own fallback for OPENAI_BASE_URL, next to an AzureOpenAI client', () => {
  // The local-model pattern: `process.env.OPENAI_BASE_URL ?? '<local server>'`. The fallback server
  // stays up during the replay, so a call that skipped the sidecar would reach it and show up live.
  const argv = [process.execPath, agentPath('openai-fallback.mjs')];
  let db;
  let recordedRun;
  let recordedTexts;

  it('records both calls: the OpenAI one through OPENAI_BASE_URL, the Azure one captured', async () => {
    db = join(dir, 'openai-fallback.db');
    const r = await shadowlap(db, ['run', '--', ...argv], { SHADOWLAP_UPSTREAM_OPENAI: mock.url, SHADOWLAP_UPSTREAM_AZURE: mock.url, FALLBACK_SERVER: mock.url, PROMPT: 'hello' });
    assert.equal(r.code, 0, r.out);
    recordedTexts = texts(r.stdout);
    recordedRun = /recording run (\w{26})/.exec(r.out)[1];
    const store = Store.open(db);
    const calls = store.getCalls(recordedRun);
    store.close();
    assert.deepEqual(calls.map((x) => x.meta.provider), ['openai', 'azure']);
  });

  it('replays both from the recording while the fallback server is still reachable', async () => {
    const r = await shadowlap(db, ['replay', recordedRun, '--strict'], { SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:9', SHADOWLAP_UPSTREAM_AZURE: 'http://127.0.0.1:9', FALLBACK_SERVER: mock.url, PROMPT: 'hello' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Replay clean: 2\/2 calls replayed/);
    assert.match(r.out, / 0 upstream requests/);
    assert.deepEqual(texts(r.stdout), recordedTexts);
  });
});

describe('the sidecar never forwards a captured call to a host its provider does not own', () => {
  it('refuses an upstream outside the provider hosts', async () => {
    const { Sidecar } = await import('../../packages/sidecar/dist/index.js');
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store });
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    const post = (upstream) => fetch(`${sidecar.url}/r/${run.runId}/bedrock/model/m/invoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-upstream': upstream }, body: '{}' });
    assert.equal((await post('https://example.com')).status, 403);
    assert.equal((await post('http://bedrock-runtime.us-east-1.amazonaws.com')).status, 403); // not https
    assert.equal((await post('https://bedrock-runtime.us-east-1.amazonaws.com.evil.test')).status, 403);
    sidecar.endRun(run.runId, 'completed');
    await sidecar.close();
    store.close();
  });
});
