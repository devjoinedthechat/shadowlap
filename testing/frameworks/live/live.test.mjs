// Shadowlap against the real providers: every claim the other tests make against fakes, checked where
// it matters. For each provider with credentials in the environment, a tiny agent makes a call that
// must use a tool and a streamed call. The recording must have usage, model, stop reason and stream
// timing for every call, the engine must parse the tool call and the text out of what was stored, and
// the run must replay clean with the provider unreachable. Providers without credentials are skipped.
//
//   ANTHROPIC_API_KEY · OPENAI_API_KEY · GEMINI_API_KEY
//   AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT + LIVE_AZURE_DEPLOYMENT
//   LIVE_VERTEX_PROJECT (+ LIVE_VERTEX_LOCATION, LIVE_VERTEX_MODEL) with Google application default credentials
//   LIVE_BEDROCK_MODEL with AWS credentials and AWS_REGION
//   LIVE_<PROVIDER>_MODEL overrides the default model.
//
// LIVE_SELFTEST=1 runs the Anthropic, OpenAI and Gemini cases against Shadowlap's scripted fakes instead,
// to test this harness without keys.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { Store, normalizeConversation, normalizeResponse, priceFor } from '../../../packages/engine/dist/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = fileURLToPath(new URL('../../../packages/cli/bin/shadowlap.js', import.meta.url));
const env = process.env;
const selftest = env.LIVE_SELFTEST === '1';

const PROVIDERS = [
  { id: 'anthropic', ready: () => selftest || !!env.ANTHROPIC_API_KEY, models: 2 },
  { id: 'openai', ready: () => selftest || !!env.OPENAI_API_KEY, models: selftest ? 2 : 3 },
  { id: 'gemini', ready: () => selftest || !!env.GEMINI_API_KEY, models: 2 },
  { id: 'azure', ready: () => !selftest && !!(env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT && env.LIVE_AZURE_DEPLOYMENT), models: 2 },
  { id: 'vertex', ready: () => !selftest && !!env.LIVE_VERTEX_PROJECT, models: 2 },
  { id: 'bedrock', ready: () => !selftest && !!env.LIVE_BEDROCK_MODEL, models: 2 },
];

let work;
const mocks = {};
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'fp-live-'));
  if (!selftest) return;
  const [{ startMockAnthropic, message, text, toolUse }, { startMockOpenAI }, { startMockGemini, turn, functionCall }] = await Promise.all([
    import('../../mock-anthropic/dist/index.js'),
    import('../../mock-openai/dist/index.js'),
    import('../../mock-gemini/dist/index.js'),
  ]);
  mocks.anthropic = await startMockAnthropic({ script: (ctx) => ({ message: ctx.request.tools?.length ? message([toolUse('get_weather', { city: 'Paris' })]) : message([text('ready')]) }) });
  mocks.openai = await startMockOpenAI({ script: (ctx) => ({ turn: ctx.request.tools?.length ? { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }], finish_reason: 'tool_calls', usage: { prompt_tokens: 40, completion_tokens: 9 } } : { content: 'ready', finish_reason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 1 } } }) });
  mocks.gemini = await startMockGemini({ script: (ctx) => ({ turn: ctx.request.tools?.length ? turn(null, { functionCalls: [functionCall('get_weather', { city: 'Paris' })] }) : turn('ready') }) });
});
after(async () => {
  for (const m of Object.values(mocks)) await m.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function shadowlap(db, args, extra = {}) {
  const selftestEnv = selftest ? { ANTHROPIC_API_KEY: 'selftest', OPENAI_API_KEY: 'selftest', GEMINI_API_KEY: 'selftest', SHADOWLAP_UPSTREAM_ANTHROPIC: mocks.anthropic?.url, SHADOWLAP_UPSTREAM_OPENAI: mocks.openai?.url, SHADOWLAP_UPSTREAM_GEMINI: mocks.gemini?.url } : {};
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, '--db', db, ...args], { cwd: HERE, env: { ...env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...selftestEnv, ...extra }, encoding: 'utf8', timeout: 180_000 });
    return { code: 0, out: stdout + stderr, stdout };
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, stdout: err.stdout ?? '' };
  }
}
const agentOutput = (stdout) => JSON.parse(stdout.split('\n').filter((l) => l.startsWith('{')).pop());

for (const p of PROVIDERS) {
  describe(`live: ${p.id}`, { skip: p.ready() ? false : `no ${p.id} credentials` }, () => {
    const db = () => join(work, `${p.id}.db`);
    let runId;
    let recorded;

    it('records every call with usage, model, stop reason and stream timing', async (t) => {
      const r = await shadowlap(db(), ['run', '--', process.execPath, join(HERE, 'agent.mjs'), p.id]);
      assert.equal(r.code, 0, r.out);
      recorded = agentOutput(r.stdout);
      assert.equal(recorded.tool?.name, 'get_weather', `the model did not call the tool: ${JSON.stringify(recorded)}`);
      assert.ok(recorded.text?.trim(), 'the streamed call returned no text');
      runId = /recording run (\w{26})/.exec(r.out)[1];

      const store = Store.open(db());
      try {
        const models = store.getCalls(runId).filter((c) => c.kind === 'api');
        assert.equal(models.length, p.models, JSON.stringify(models.map((c) => c.name)));
        for (const c of models) {
          const where = `#${c.callNo} ${c.name}`;
          assert.equal(c.meta.provider, p.id, where);
          assert.equal(c.end?.outcome, 'ok', `${where}: ${JSON.stringify(c.end?.meta.error)}`);
          assert.ok(c.end.meta.usage?.inputTokens > 0 && c.end.meta.usage?.outputTokens > 0, `${where}: usage ${JSON.stringify(c.end.meta.usage)}`);
          assert.ok(c.end.meta.model ?? c.meta.model, `${where}: no model`);
          assert.ok(c.end.meta.stopReason, `${where}: no stop reason`);
          assert.ok(normalizeConversation(store.getJson(c.requestRef) ?? {}) !== undefined, where);
          const model = c.end.meta.model ?? c.meta.model;
          t.diagnostic(`${where}: ${model} · ${c.end.meta.usage.inputTokens} in / ${c.end.meta.usage.outputTokens} out · stop ${c.end.meta.stopReason} · ${priceFor(model) ? 'priced' : 'no price'}`);
        }
        const parse = (c) => normalizeResponse(store.getBlob(c.end.responseRef), c.end.meta.headers?.['content-type'], c.end.meta.chunks ?? [], p.id);
        const toolCall = parse(models[0]).blocks.find((b) => b.type === 'tool_call');
        assert.equal(toolCall?.name, 'get_weather', `the stored tool call did not parse: ${JSON.stringify(parse(models[0]).blocks)}`);
        const streamed = models[1];
        assert.ok((streamed.end.meta.chunks?.length ?? 0) >= 2, `the stream's timing was not recorded: ${JSON.stringify(streamed.end.meta.chunks)}`);
        const text = parse(streamed).blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
        assert.equal(text.trim(), recorded.text.trim(), 'the stored stream parses to a different text than the SDK saw');
      } finally {
        store.close();
      }
    });

    it('replays clean with the provider unreachable, printing the same output', async () => {
      assert.ok(runId, 'nothing was recorded');
      const upstream = `SHADOWLAP_UPSTREAM_${p.id.toUpperCase()}`;
      const r = await shadowlap(db(), ['replay', runId, '--strict'], { [upstream]: 'http://127.0.0.1:9' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Replay clean: (\d+)\/\1 calls replayed/);
      assert.match(r.out, / 0 upstream requests/);
      assert.deepEqual(agentOutput(r.stdout), recorded);
    });
  });
}
