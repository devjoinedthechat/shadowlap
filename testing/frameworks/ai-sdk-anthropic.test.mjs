// The Vercel AI SDK's Anthropic provider (@ai-sdk/anthropic) through shadowlap run, with no code
// changes: it reads ANTHROPIC_BASE_URL as an API root that ends in /v1 and sends /messages, where the
// official SDKs send /v1/messages. The calls must reach the API at /v1/messages, be recorded under
// that name, and replay offline. Also with a base URL of the user's own, given the AI SDK's way.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { message, startMockAnthropic, text, toolUse } from '../mock-anthropic/dist/index.js';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./ai-sdk-anthropic-agent.mjs', import.meta.url));

describe('Vercel AI SDK on @ai-sdk/anthropic, through shadowlap run', () => {
  let mock;
  let cwd;
  let env;
  before(async () => {
    mock = await startMockAnthropic({
      script: (ctx) => ({
        message: ctx.assistantTurns === 0 ? message([toolUse('lookup_order', { order_id: 'A-1042' })]) : message([text('Escalated to a manager: the refund is above the limit.')]),
      }),
    });
    cwd = mkdtempSync(join(tmpdir(), 'sl-ai-sdk-anthropic-'));
    env = { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-placeholder', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (k === 'ANTHROPIC_BASE_URL' || k === 'SHADOWLAP_URL' || k.startsWith('SHADOWLAP_UPSTREAM_')) delete env[k];
  });
  after(async () => {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const shadowlap = async (args, extra = {}) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
      return { code: 0, out: stdout + stderr, stdout };
    } catch (err) {
      return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
    }
  };
  const answer = (stdout) => JSON.parse(stdout.split('\n').find((l) => l.startsWith('{')));
  const expected = { text: 'Escalated to a manager: the refund is above the limit.', outputs: [{ order_id: 'A-1042', amount: 240 }] };

  it('records the model calls under /v1/messages, and replays them with no request upstream', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url });
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(answer(recorded.stdout), expected);
    assert.match(recorded.out, /Recorded \w+: 3 calls \(2 api, 1 tool\)/);
    assert.equal(mock.requests.length, 2);
    const runId = /recording run (\w{26})/.exec(recorded.out)[1];

    const shown = await shadowlap(['show', runId]);
    assert.equal(shown.code, 0, shown.out);
    assert.equal(shown.out.match(/api\s+POST \/v1\/messages\s/g)?.length, 2, shown.out);

    const replay = await shadowlap(['replay', runId, '--strict']);
    assert.equal(replay.code, 0, replay.out);
    assert.deepEqual(answer(replay.stdout), expected);
    assert.match(replay.out, /Replay clean: 3\/3 calls replayed \(2 api, 1 tool\), 0 upstream requests/);
    assert.equal(mock.requests.length, 2);
  });

  it('forwards to an ANTHROPIC_BASE_URL of the user\'s that ends in /v1, as the AI SDK reads it', async () => {
    const sent = mock.requests.length;
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { ANTHROPIC_BASE_URL: `${mock.url}/v1` });
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(answer(recorded.stdout), expected);
    assert.equal(mock.requests.length, sent + 2);
  });
});
