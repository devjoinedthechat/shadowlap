import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type DecisionsReport } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';
import type { MigrateReport } from '../src/migrate.js';

/**
 * A switch changes the agent's model calls, not every call a recording holds. The agent here talks
 * to a simulated customer on another model (in a scope of its own), and the recording holds a call
 * Shadowlap's judge made after it (the reserved scope `shadowlap:judge`). `decisions --model` and
 * `migrate --to` change the calls made with the model the runs use most (or those `--from` names),
 * leave the customer's and the judge's as they are, verify the same way, patch only the strings
 * that name the model in code and config, and mask what the redaction rules mask in every report.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const TS_SDK = new URL('../../sdk/dist/index.js', import.meta.url).href;
const AGENT_MODEL = 'claude-sonnet-4-6';
const CUSTOMER_MODEL = 'claude-haiku-4-5';
const NEW_MODEL = 'claude-sonnet-5-5';

let mock: MockServer;
let cwd: string;
let db: string;
let runId: string;
let judgeCall: number;

/** The customer opens; the agent looks the order up and refunds it (the new model words its note its own way), then answers. */
function script({ request, assistantTurns }: ScriptContext): ScriptResult {
  const system = typeof request.system === 'string' ? request.system : JSON.stringify(request.system ?? '');
  if (system.includes('You are a customer')) return { message: message([text('My order A-1 arrived broken.')], { model: request.model, input_tokens: 50, output_tokens: 10 }) };
  if (system.includes('You judge')) return { message: message([text('yes')], { model: request.model, input_tokens: 40, output_tokens: 2 }) };
  const usage = { model: request.model, input_tokens: 1000 + assistantTurns * 100, output_tokens: 30 };
  if (assistantTurns === 0) return { message: message([toolUse('lookup_order', { order_id: 'A-1' })], usage) };
  if (assistantTurns === 1) return { message: message([toolUse('issue_refund', { order_id: 'A-1', amount: 240, note: request.model === NEW_MODEL ? 'card 4242-4242 refunded in full' : 'card 4242-4242 refunded' })], usage) };
  return { message: message([text('Refunded.')], usage) };
}

const AGENT = `
import { tool } from ${JSON.stringify(TS_SDK)};
const impl = {
  lookup_order: tool('lookup_order', { effect: 'read' }, async ({ order_id }) => ({ order_id, total: 240 })),
  issue_refund: tool('issue_refund', { effect: 'write' }, async ({ amount }) => ({ refunded: amount })),
};
const tools = [
  { name: 'lookup_order', description: 'Look an order up.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } } } },
  { name: 'issue_refund', description: 'Refund an order.', input_schema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number' }, note: { type: 'string' } } } },
];
const ask = async (body, scope) => {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test', ...(scope ? { 'x-shadowlap-scope': scope } : {}) };
  return (await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) })).json();
};
const opening = await ask({ model: ${JSON.stringify(CUSTOMER_MODEL)}, max_tokens: 100, system: 'You are a customer whose order arrived broken.', messages: [{ role: 'user', content: 'Start.' }] }, 'customer');
const messages = [{ role: 'user', content: opening.content[0].text }];
// With AGENT_CACHE, the agent marks a cache breakpoint on its system prompt, as a prompt-caching agent does.
const system = process.env.AGENT_CACHE ? [{ type: 'text', text: 'You refund orders.', cache_control: { type: 'ephemeral' } }] : 'You refund orders.';
for (let i = 0; i < 4; i++) {
  const r = await ask({ model: process.env.AGENT_MODEL ?? '${AGENT_MODEL}', max_tokens: 1024, system, messages, tools });
  messages.push({ role: 'assistant', content: r.content });
  const calls = r.content.filter((b) => b.type === 'tool_use');
  if (!calls.length) break;
  messages.push({ role: 'user', content: await Promise.all(calls.map(async (c) => ({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(await impl[c.name](c.input)) }))) });
}
`;

/**
 * These tests are about how each request is shaped and answered, so a step is asked once unless a
 * test says otherwise: by default decisions also asks each step as recorded, three times a side (the
 * control arm, which decisions.test.ts covers).
 */
const once = (args: string[]): string[] => (args[0] === 'decisions' && !args.includes('--samples') && !args.includes('--verify') ? [...args, '--samples', '1'] : args);

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...once(args)], {
      cwd,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, 'home'), ...env },
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

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  cwd = mkdtempSync(join(tmpdir(), 'sl-decisions-scopes-'));
  db = join(cwd, '.shadowlap', 'shadowlap.db');
  // A project that names its agent's model in code and config, and in places a switch must leave alone.
  const files: Record<string, string> = {
    'agent.mjs': AGENT,
    'config.yaml': `agent:\n  model: ${AGENT_MODEL}\n  customer: ${CUSTOMER_MODEL}\n`,
    '.env': `AGENT_MODEL=${AGENT_MODEL}\n`,
    'CHANGELOG.md': `# Changelog\n\n- Moved the agent to ${AGENT_MODEL}.\n`,
    'test/agent.test.mjs': `// The agent's model, as configured.\nexport const expected = '${AGENT_MODEL}';\n`,
    'src/prompt.ts': `export const about = 'Runs on ${AGENT_MODEL} today.';\n`,
    'shadowlap.config.json': `${JSON.stringify({ redact: [{ pattern: '/4242-4242/', replace: '<card>' }], prices: { [AGENT_MODEL]: { input: 3, output: 15 } } }, null, 2)}\n`,
    '.gitignore': '.shadowlap/\nhome/\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('add', '.');
  git('commit', '-q', '-m', 'agent');
  const rec = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  expect(rec.code, rec.out).toBe(0);
  runId = /recording run (\w{26})/.exec(rec.out)![1]!;
  // The call Shadowlap's judge makes after the agent exits, kept in the run as the judge keeps it.
  const store = Store.open(db);
  try {
    const calls = store.getCalls(runId);
    const last = calls.filter((c) => c.kind === 'api').at(-1)!;
    const { end, attempts: _attempts, ...start } = last;
    judgeCall = Math.max(...calls.map((c) => c.callNo)) + 1;
    store.appendCallStart({ ...start, callNo: judgeCall, meta: { ...start.meta, scope: 'shadowlap:judge', model: CUSTOMER_MODEL } });
    store.appendCallEnd({ kind: start.kind, name: start.name, fingerprint: start.fingerprint, occurrence: start.occurrence }, { ...end!, callNo: judgeCall, meta: { ...end!.meta, model: CUSTOMER_MODEL } });
  } finally {
    store.close();
  }
}, 120_000);

afterAll(async () => {
  await mock?.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a switch changes the agent\'s model calls', () => {
  it("switches the model the runs use most, leaves the customer's calls as recorded, and the judge's out", async () => {
    const before = mock.requests.length;
    const r = await shadowlap(['decisions', runId, '--model', NEW_MODEL, '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<DecisionsReport>(r);
    expect(report.change.from).toEqual([AGENT_MODEL]);
    // Four steps: the customer's and the agent's three. The judge's call is none of the agent's.
    const run = report.runs[0];
    expect(run.steps).toBe(4);
    expect(run.decisions.map((s) => s.callNo)).not.toContain(judgeCall);
    expect(run.counts).toMatchObject({ 1: 1, same: 2, untouched: 1, notAsked: 0 });
    expect(run.decisions.find((s) => s.scope === 'customer')).toMatchObject({ rank: null, model: { recorded: CUSTOMER_MODEL, asked: null }, samples: { asked: 0 } });
    expect(report.flagged).toEqual([runId]);
    // Only the agent's three calls were sent, each under the new model.
    expect(mock.requests.slice(before).map((q) => q.body.model)).toEqual([NEW_MODEL, NEW_MODEL, NEW_MODEL]);
    expect(report.notes).toContain(`The 1 model call made with ${CUSTOMER_MODEL} stays as recorded: the change is at the calls made with ${AGENT_MODEL}, the model the runs use most (--from names others).`);
    // What a run costs counts the agent's calls only.
    expect(report.runs[0].cost.before).toBeGreaterThan(0);
  }, 120_000);

  it('switches the models --from names, and asks only the scope --scope names, none for no scope', async () => {
    let before = mock.requests.length;
    const customer = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', NEW_MODEL, '--from', CUSTOMER_MODEL, '--json']));
    expect(customer.change.from).toEqual([CUSTOMER_MODEL]);
    expect(mock.requests.slice(before).map((q) => q.body.model)).toEqual([NEW_MODEL]);
    expect(customer.runs[0].counts).toMatchObject({ same: 1, untouched: 3 });

    before = mock.requests.length;
    const unscoped = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', NEW_MODEL, '--scope', 'none', '--json']));
    expect(unscoped.runs[0].steps).toBe(3);
    expect(unscoped.runs[0].decisions.every((s) => s.scope === null)).toBe(true);
    expect(mock.requests.slice(before)).toHaveLength(3);

    const unknown = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', NEW_MODEL, '--from', 'claude-opus-4-8', '--json']));
    expect(unknown.warnings).toContain(`--from claude-opus-4-8: no model call of the runs was made with it (they use ${AGENT_MODEL}, ${CUSTOMER_MODEL})`);
  }, 120_000);

  it("asks a run whose requests carry cache breakpoints one step at a time, in order, and the others side by side", async () => {
    // A gateway in front of the mock that answers slowly and counts the requests in flight.
    let inFlight = 0;
    let most = 0;
    const gateway = createServer((req, res) => {
      inFlight++;
      most = Math.max(most, inFlight);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        setTimeout(() => {
          void fetch(`${mock.url}${req.url}`, { method: req.method ?? 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: Buffer.concat(chunks) }).then(async (answer) => {
            res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
            res.end(Buffer.from(await answer.arrayBuffer()));
            inFlight--;
          });
        }, 80);
      });
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    try {
      const rec = await shadowlap(['run', '--', process.execPath, 'agent.mjs'], { AGENT_CACHE: '1' });
      expect(rec.code, rec.out).toBe(0);
      const cached = /recording run (\w{26})/.exec(rec.out)![1];
      const asked = json<DecisionsReport>(await shadowlap(['decisions', cached, '--model', NEW_MODEL, '--concurrency', '4', '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: url }));
      expect(asked.runs[0].asked).toBe(3);
      expect(most).toBe(1);
      expect(asked.notes.join('\n')).toContain('a run whose requests carry them is asked one step at a time, in order');
      // Without breakpoints, the steps go side by side.
      most = 0;
      const plain = json<DecisionsReport>(await shadowlap(['decisions', runId, '--model', NEW_MODEL, '--concurrency', '4', '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: url }));
      expect(plain.runs[0].asked).toBe(3);
      expect(most).toBeGreaterThan(1);
    } finally {
      await new Promise<void>((r) => gateway.close(() => r()));
    }
  }, 120_000);

  it("refuses to ask a model of another family the recorded request, and says why", async () => {
    const before = mock.requests.length;
    const r = await shadowlap(['decisions', runId, '--model', 'gpt-5.6-sol', '--json']);
    expect(r.code).toBe(3);
    const report = json<DecisionsReport>(r);
    expect(mock.requests.length).toBe(before);
    expect(report.runs[0].counts).toMatchObject({ notAsked: 3, untouched: 1 });
    expect(report.warnings.join('\n')).toContain(`gpt-5.6-sol is a model of another family than ${AGENT_MODEL} (OpenAI, not Claude): asking the recorded request again can't carry it into that family's request format, so verify that switch instead`);
  }, 120_000);
});

describe('migrate, on a project that names its model in many places', () => {
  it("verifies as it previews, patches only the strings that name the model in code and config, and masks the redaction rules' values", async () => {
    const r = await shadowlap(['migrate', '--to', NEW_MODEL, runId, '-y', '--attempts', '1', '--json']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('4242-4242');
    const report = json<MigrateReport>(r);
    expect(report.from).toEqual([AGENT_MODEL]);
    expect(report.pullRequest.title).toBe(`Switch ${AGENT_MODEL} to ${NEW_MODEL}`);
    expect(report.changes.steps).toEqual([expect.objectContaining({ rank: 1, detail: 'issue_refund is called with other arguments', arguments: ['issue_refund.note: "card <card> refunded" → "card <card> refunded in full"'] })]);
    expect(report.passes.runs).toEqual([{ runId, golden: null, verdict: 'passed', outcome: 'kept', verified: true, tally: { passes: 1, attempts: 1, bound: null, rule: '1 of 1 attempts must pass', undecided: null } }]);
    expect(report.set).toEqual({ flags: [], fields: [], given: {} });
    // Verify changes the calls the preview changed: those made with the model it switches from.
    expect(report.decisions.verify!.commands[0]).toContain(`--from ${AGENT_MODEL}`);

    // Verify switched the agent's calls, and left the customer's on its model.
    const store = Store.open(db);
    try {
      const attempts = store.allRuns().filter((x) => x.meta?.verify && x.parentRunId === runId);
      expect(attempts.length).toBeGreaterThan(0);
      const models = store.getCalls(attempts[0].runId).filter((c) => c.kind === 'api').map((c) => [c.meta.scope ?? null, c.end?.meta.model ?? c.meta.model]);
      expect(models).toEqual([
        ['customer', CUSTOMER_MODEL],
        [null, NEW_MODEL],
        [null, NEW_MODEL],
        [null, NEW_MODEL],
      ]);
    } finally {
      store.close();
    }

    // The patch: the agent's default in code, the YAML value and the .env value; never a key, prose, a test, or Shadowlap's config.
    const change = report.configChange!;
    expect(change.files.map((f) => f.path).sort()).toEqual(['.env', 'agent.mjs', 'config.yaml']);
    expect(change.patch).toContain(`-  model: ${AGENT_MODEL}\n+  model: ${NEW_MODEL}`);
    expect(change.patch).toContain(`-AGENT_MODEL=${AGENT_MODEL}\n+AGENT_MODEL=${NEW_MODEL}`);
    expect(change.patch).not.toContain(`customer: ${NEW_MODEL}`);
    expect(change.review.map((m) => m.path).sort()).toEqual(['CHANGELOG.md', 'shadowlap.config.json', 'src/prompt.ts', 'test/agent.test.mjs']);
    writeFileSync(join(cwd, 'check.patch'), change.patch);
    execFileSync('git', ['apply', '--check', 'check.patch'], { cwd });
    rmSync(join(cwd, 'check.patch'));

    // The pull request body carries no value a redaction rule masks.
    const body = readFileSync(join(cwd, report.files!.pullRequest), 'utf8');
    expect(body).toContain('issue_refund.note: "card <card> refunded" → "card <card> refunded in full"');
    expect(body).not.toContain('4242-4242');
    expect(body).toContain('Left as they are, for review: 4 other mentions');
  }, 240_000);
});
