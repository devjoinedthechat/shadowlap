import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLACEHOLDER_AWS_ACCESS_KEY_ID, PLACEHOLDER_KEY } from '@shadowlap/sidecar';
import { answered, ciEnv, CLI, findPython, HERE, node, recorded, refusal, ROOT, run, startProviders, workdir, type ProviderId, type Providers } from './clients.js';

/**
 * Agents that build their model client the default way, with each official SDK, take their key
 * from the environment and fail before they send anything when there is none, as they would in a CI
 * job without secrets. Recorded with a key, each replays without one: a clean replay, `shadowlap
 * test` on its golden and the GitHub Action pass on placeholder keys; a fork that needs a live call
 * is refused with one line, counted as refused and with nothing reaching the provider; and a key the
 * environment holds goes live as it is. The Python agents run where SHADOWLAP_PYTHON, python3 or
 * python has their SDK.
 */

interface Agent {
  name: string;
  provider: ProviderId;
  argv: string[] | null;
  /** The variables the agent's key was in when it was recorded, and those a key of the user's own is set in. */
  keys: Record<string, string>;
  mine: Record<string, string>;
  /** The variable a refused call says to set. */
  set: string;
  /** How the key a request carried reads at the provider. */
  carried: (headers: Record<string, string | string[] | undefined>, path: string) => string;
}

const header = (name: string) => (h: Record<string, string | string[] | undefined>) => String(h[name] ?? '');
const signedWith = (h: Record<string, string | string[] | undefined>) => /Credential=([^/]+)\//.exec(String(h.authorization ?? ''))?.[1] ?? '';
const anthropicKey = (h: Record<string, string | string[] | undefined>) => String(h['x-api-key'] ?? String(h.authorization ?? '').replace(/^Bearer /, ''));
const geminiKey = (h: Record<string, string | string[] | undefined>, path: string) => String(h['x-goog-api-key'] ?? new URLSearchParams(path.split('?')[1] ?? '').get('key') ?? '');
const aws = (id: string) => ({ AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: `${id.toLowerCase()}-secret` });

const python = {
  anthropic: findPython('anthropic'),
  openai: findPython('openai'),
  gemini: findPython('google.genai'),
  bedrock: findPython('anthropic', 'boto3'),
  boto3: findPython('boto3'),
};
const py = (cmd: string | null, agent: string) => (cmd ? [cmd, join(HERE, agent)] : null);

const AGENTS: Agent[] = [
  { name: 'anthropic-node', provider: 'anthropic', argv: node('anthropic.mjs'), keys: { ANTHROPIC_API_KEY: 'sk-ant-recording' }, mine: { ANTHROPIC_API_KEY: 'sk-ant-mine' }, set: 'ANTHROPIC_API_KEY', carried: anthropicKey },
  { name: 'openai-node', provider: 'openai', argv: node('openai.mjs'), keys: { OPENAI_API_KEY: 'sk-recording' }, mine: { OPENAI_API_KEY: 'sk-mine' }, set: 'OPENAI_API_KEY', carried: (h) => header('authorization')(h).replace(/^Bearer /, '') },
  { name: 'gemini-node', provider: 'gemini', argv: node('gemini.mjs'), keys: { GEMINI_API_KEY: 'gm-recording' }, mine: { GEMINI_API_KEY: 'gm-mine' }, set: 'GEMINI_API_KEY', carried: geminiKey },
  { name: 'azure-node', provider: 'azure', argv: node('azure.mjs'), keys: { AZURE_OPENAI_API_KEY: 'az-recording' }, mine: { AZURE_OPENAI_API_KEY: 'az-mine' }, set: 'AZURE_OPENAI_API_KEY', carried: header('api-key') },
  // anthropic 2.0 and later send the key as a bearer token, 1.x as x-api-key.
  { name: 'anthropic-python', provider: 'anthropic', argv: py(python.anthropic, 'anthropic_agent.py'), keys: { ANTHROPIC_API_KEY: 'sk-ant-recording' }, mine: { ANTHROPIC_API_KEY: 'sk-ant-mine' }, set: 'ANTHROPIC_API_KEY', carried: anthropicKey },
  { name: 'openai-python', provider: 'openai', argv: py(python.openai, 'openai_agent.py'), keys: { OPENAI_API_KEY: 'sk-recording' }, mine: { OPENAI_API_KEY: 'sk-mine' }, set: 'OPENAI_API_KEY', carried: (h) => header('authorization')(h).replace(/^Bearer /, '') },
  { name: 'gemini-python', provider: 'gemini', argv: py(python.gemini, 'gemini_agent.py'), keys: { GOOGLE_API_KEY: 'gm-recording' }, mine: { GOOGLE_API_KEY: 'gm-mine' }, set: 'GEMINI_API_KEY', carried: geminiKey },
  { name: 'azure-python', provider: 'azure', argv: py(python.openai, 'azure_agent.py'), keys: { AZURE_OPENAI_API_KEY: 'az-recording' }, mine: { AZURE_OPENAI_API_KEY: 'az-mine' }, set: 'AZURE_OPENAI_API_KEY', carried: header('api-key') },
  { name: 'bedrock-python', provider: 'bedrock', argv: py(python.bedrock, 'bedrock_agent.py'), keys: aws('AKIARECORDING'), mine: aws('AKIAMINE'), set: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY', carried: signedWith },
  { name: 'boto3-python', provider: 'bedrock', argv: py(python.boto3, 'boto_agent.py'), keys: aws('AKIARECORDING'), mine: aws('AKIAMINE'), set: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY', carried: signedWith },
];

let providers: Providers;
let work: ReturnType<typeof workdir>;
const env = (extra: Record<string, string> = {}) => ciEnv(providers, work.empty, extra);
const shadowlap = (args: string[], extra: Record<string, string> = {}, db = 'store.db') => run([process.execPath, CLI, '--db', join(work.dir, db), ...args], work.dir, env(extra));

beforeAll(async () => {
  providers = await startProviders();
  work = workdir('sl-no-key-');
});

afterAll(async () => {
  // Whatever happened above, no placeholder reached a provider: not in a header, not in a query, not in a signature.
  const carried = providers.all().filter((r) => JSON.stringify(r).includes(PLACEHOLDER_KEY) || JSON.stringify(r).includes(`Credential=${PLACEHOLDER_AWS_ACCESS_KEY_ID}/`));
  expect(carried).toEqual([]);
  await providers.close();
  work.remove();
});

for (const agent of AGENTS) {
  describe.skipIf(!agent.argv)(`${agent.name}: a client built the default way, with no key in the environment`, () => {
    let runId = '';
    const golden = `goldens/${agent.name}`;
    const count = () => providers.seen(agent.provider).length;

    beforeAll(async () => {
      const made = await shadowlap(['run', '--', ...agent.argv!], agent.keys);
      expect(made.code, made.out).toBe(0);
      expect(made.out).toMatch(answered('hello'));
      runId = recorded(made.out);
      expect(providers.seen(agent.provider).at(-1) && agent.carried(providers.seen(agent.provider).at(-1)!.headers, providers.seen(agent.provider).at(-1)!.path)).toContain(Object.values(agent.keys)[0]);
      const packed = await shadowlap(['pack', runId, golden]);
      expect(packed.code, packed.out).toBe(0);
    });

    it('fails before it sends anything without Shadowlap, as in a CI job without secrets', async () => {
      // Gemini's Node client looks for Google credentials over the network first: it is left out here.
      if (agent.name === 'gemini-node') return;
      const before = providers.all().length;
      const alone = await run(agent.argv!, work.dir, env({ ANTHROPIC_BASE_URL: providers.urls.anthropic, OPENAI_BASE_URL: `${providers.urls.openai}/v1`, GOOGLE_GEMINI_BASE_URL: providers.urls.gemini }));
      expect(alone.code, alone.out).toBe(1);
      expect(alone.out).toMatch(/"error"/);
      expect(providers.all().length).toBe(before);
    });

    it('replays clean, every call answered from the recording', async () => {
      const before = count();
      const r = await shadowlap(['replay', runId, '--strict']);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(answered('hello'));
      expect(r.out).toMatch(/Replay clean: 1\/1 calls replayed/);
      expect(count()).toBe(before);
    });

    it('passes shadowlap test on its golden, in a store of its own as in CI', async () => {
      const before = count();
      const r = await shadowlap(['test', golden], {}, `ci-${agent.name}.db`);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('1 passed, 0 failed');
      expect(count()).toBe(before);
    });

    it('refuses a fork that needs a live call in one line, counted as refused, and sends the provider nothing', async () => {
      const before = count();
      const r = await shadowlap(['replay', runId], { PROMPT: 'goodbye' });
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(refusal(agent.set));
      expect(r.out).toMatch(/Forked at call 1: 0 calls replayed, then 0 live, 1 refused; 0 upstream requests/);
      expect(r.out).toContain(`  ! ${refusal(agent.set)}`);
      expect(count()).toBe(before);
    });

    it('goes live on a fork with the key the environment holds, never in its place', async () => {
      const before = count();
      const r = await shadowlap(['replay', runId], { PROMPT: 'goodbye', ...agent.mine });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(answered('goodbye'));
      expect(count()).toBe(before + 1);
      const last = providers.seen(agent.provider).at(-1)!;
      expect(agent.carried(last.headers, last.path)).toContain(Object.values(agent.mine)[0]);
    });
  });
}

describe('the GitHub Action, in a job without secrets', () => {
  it('passes every golden of the agents above', () => {
    const packed = AGENTS.filter((a) => a.argv).length;
    const output = join(work.dir, 'action-output');
    const summary = join(work.dir, 'action-summary.md');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const before = providers.all().length;
    const inputs = { INPUT_RECORDINGS: 'goldens/*', INPUT_WORKING_DIRECTORY: work.dir, INPUT_STORE: join(work.dir, 'action.db'), INPUT_KEEP_HISTORY: 'false' };
    const r = spawnSync(process.execPath, [join(ROOT, 'action', 'run.mjs')], { cwd: work.dir, env: env({ ...inputs, SHADOWLAP_CLI: CLI, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: work.dir }), encoding: 'utf8', timeout: 240_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(outputs).toMatchObject({ passed: String(packed), failed: '0' });
    expect(providers.all().length).toBe(before);
  }, 240_000);
});
