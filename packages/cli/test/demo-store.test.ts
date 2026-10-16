import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyRun, Store, type RunRecord } from '@shadowlap/engine';

/**
 * scripts/demo-store.mjs builds the demo project the dashboard is compared with the design on, each
 * state made by the CLI against the mock providers. Built here with --fast in a temporary folder,
 * its store holds what --fast promises: a run of every kind with blame's probes and verify's
 * attempts under them, a fork for each intervention it makes, an interrupted and a failed
 * recording, a verified fix and an open one, and goldens tested at several commits that passed,
 * failed a check and diverged. The script drives the built CLI, as the other end-to-end tests do.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Some three hundred processes, one after another: minutes on Windows, which starts a process
// several times slower. The script is the same on every system.
describe.skipIf(process.platform === 'win32')('scripts/demo-store.mjs --fast', () => {
  let base = '';
  let folder = '';
  let printed = '';
  let store: Store;
  let runs: RunRecord[] = [];

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'sl-demo-store-'));
    folder = join(base, 'demo');
    const built = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'demo-store.mjs'), folder, '--fast'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('close', (code) => resolve({ code, out }));
    });
    printed = built.out;
    expect(built.code, built.out).toBe(0);
    store = Store.open(join(folder, 'support-agent', '.shadowlap', 'shadowlap.db'));
    runs = store.allRuns();
  }, 120_000);

  afterAll(() => {
    store?.close();
    if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('has a run of every kind it promises, with the attempts blame and verify made', () => {
    const byId = new Map(runs.map((r) => [r.runId, r]));
    const calls = (id: string) => store.getCalls(id).length;
    const rescued = new Set(runs.map((r) => r.meta?.blame?.rescuedRunId).filter(Boolean));
    const kinds: Record<string, number> = {};
    const attempts: Record<string, number> = {};
    for (const r of runs) {
      const parent = r.parentRunId ? byId.get(r.parentRunId) : undefined;
      const c = classifyRun(r, { calls: calls(r.runId), parent: parent ? { calls: calls(parent.runId), status: parent.status } : null, rescued: rescued.has(r.runId) });
      if (c.attemptKind) attempts[c.attemptKind] = (attempts[c.attemptKind] ?? 0) + 1;
      else kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    }
    for (const kind of ['recording', 'fork', 'clean', 'test', 'capture']) expect(kinds[kind], kind).toBeGreaterThan(0);
    for (const kind of ['probe', 'verify']) expect(attempts[kind], kind).toBeGreaterThan(0);
    // What it prints, and what it leaves in runs.json, is the store as the dashboard counts it.
    const promised = JSON.parse(readFileSync(join(folder, 'runs.json'), 'utf8')) as { kinds: Record<string, number>; attempts: Record<string, number> };
    expect(promised.kinds).toEqual(kinds);
    expect(promised.attempts).toEqual(attempts);
    const total = Object.values(kinds).reduce((a, b) => a + b, 0);
    expect(printed).toContain(`runs      ${total}: `);
    expect(printed).toMatch(/Open the dashboard on it:\n {2}cd .+support-agent" && SHADOWLAP_HOME=.+ node .+shadowlap\.js" dashboard\n/);
  });

  it('forks with each intervention, and has an interrupted and a failed recording', () => {
    const made = runs.filter((r) => r.mode === 'replay' && !r.meta?.probe && !r.meta?.verify && !r.meta?.test).flatMap((r) => (r.meta?.interventions ?? []).map((i) => ({ ...i, parent: r.parentRunId })));
    expect(new Set(made.map((i) => i.kind))).toEqual(new Set(['override', 'fail', 'writes', 'plant', 'live-tool']));
    // --fail-at on a model call and on a tool call.
    const failed = made.filter((i) => i.kind === 'fail').map((i) => store.getCalls(i.parent!).find((c) => c.callNo === i.at)?.kind);
    expect(failed.sort()).toEqual(['api', 'tool']);
    const recorded = runs.filter((r) => r.mode === 'record').map((r) => r.status);
    expect(recorded).toContain('crashed');
    expect(recorded).toContain('failed');
  });

  it('records Anthropic, OpenAI and Gemini, and imports a HAR, nock, VCR and LiteLLM capture', () => {
    const names = new Set(runs.flatMap((r) => store.getCalls(r.runId).filter((c) => c.kind === 'api').map((c) => c.name)));
    expect(names).toContain('POST /v1/messages');
    expect(names).toContain('POST /v1/chat/completions');
    expect([...names].some((n) => n.endsWith(':generateContent'))).toBe(true);
    const sources = runs.filter((r) => r.meta?.covers).map((r) => r.meta!.imported!.from);
    expect(sources.sort()).toEqual(['digest-cassette.json', 'refund-A-1077.har', 'shadowlap-4121.jsonl, shadowlap-4122.jsonl', 'triage-nock.json']);
  });

  it('has a fix repair verified, and one blame opened that is still open', () => {
    expect(store.listFixes().map((f) => [f.status, f.title]).sort()).toEqual([
      ['open', 'Confirmation email sent twice'],
      ['verified', 'Refunds above the limit issued without approval'],
    ]);
  });

  it('tested its goldens at several commits: they passed, failed a check and diverged', () => {
    const sessions = store.listTestSessions();
    expect(new Set(sessions.map((s) => s.revision)).size).toBeGreaterThanOrEqual(3);
    const results = store.listTestResults({ limit: 1000 });
    expect(results.some((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.failure === 'check')?.golden).toBe('goldens/refund-flow-budget');
    expect(results.find((r) => r.failure === 'diverged')?.golden).toBe('goldens/refund-in-limit');
  });
});

/**
 * What the demo's models answer after the build, when its mock providers run again for the
 * dashboard: Repair from here on the open fix gets rewrites for the check its runs fail, which leave
 * the refund rules alone, and the agent heeds the one about emailing once.
 */
describe('the demo’s models', () => {
  type Answer = { candidates: Array<{ anchor: number; replace: string; strategy: string }> };
  type Models = { anthropic(ctx: { request: Record<string, unknown> }): { message: { content: Array<{ type: string; text?: string; name?: string }> } }; control: { email: string } };
  const load = async (): Promise<Models> => ((await import(pathToFileURL(join(ROOT, 'scripts', 'demo-store', 'models.mjs')).href)) as { createModels(): Models }).createModels();
  const SYSTEM = 'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.';

  it('offers a repair rewrites for the check its runs fail', async () => {
    const models = await load();
    const ask = (must: string): Answer => {
      const user = `## What a run must do\n\n${must}\n\n## The agent's instructions\n\nSystem prompt:\n${SYSTEM}\n\n## Text you may rewrite\n\n[1] system prompt, in agent.mjs: ${SYSTEM}\n[2] tool issue_refund, in agent.mjs: Refund an order in full.\n[3] tool send_email, in agent.mjs: Email the customer.\n\n## Rules\n\n- …`;
      const out = models.anthropic({ request: { model: 'claude-opus-5-5', system: 'You improve AI agents by rewriting the instructions they are given.', messages: [{ role: 'user', content: user }] } });
      return JSON.parse(out.message.content[0]!.text!) as Answer;
    };
    // A confirmation sent twice: emailing once, in the prompt or the tool, and nothing about refunds.
    const email = ask('- the agent exits 0\n- send_email called 1 time');
    expect(email.candidates.map((c) => c.anchor)).toEqual([1, 3]);
    expect(email.candidates[0]!.replace).toBe(`${SYSTEM} Email the customer once per decision.`);
    expect(JSON.stringify(email.candidates)).not.toMatch(/issue_refund|Refund an order|Check the policy/);
    // The refund runs: the three rewrites the build's repair chose from.
    const refund = ask('- the agent exits 0\n- issue_refund with {"amount":240} called 0 times');
    expect(refund.candidates.map((c) => c.strategy)).toEqual(['Forbid the failing refund', 'Point the refund tool at the policy', 'Escalate refunds above the policy limit']);
  });

  it('emails the customer about order A-1150 twice, unless the prompt or the tool says once', async () => {
    const models = await load();
    expect(models.control.email).toBe('always');
    const use = (id: string, name: string, input: unknown) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
    const result = (id: string, value: unknown) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(value) }] });
    const tools = (email: string) => [{ name: 'send_email', description: email, input_schema: { type: 'object' } }];
    const next = (system: string, email = 'Email the customer.') =>
      models.anthropic({
        request: {
          model: 'claude-sonnet-5',
          system,
          tools: tools(email),
          messages: [
            { role: 'user', content: 'Order A-1150: the customer asks for a refund.' },
            use('t1', 'lookup_order', { order_id: 'A-1150' }),
            result('t1', { order_id: 'A-1150', amount: 80 }),
            use('t2', 'get_policy', { topic: 'refunds' }),
            result('t2', { limit: 100 }),
            use('t3', 'issue_refund', { order_id: 'A-1150', amount: 80 }),
            result('t3', { status: 'issued' }),
            use('t4', 'send_email', { to: 'customer@example.com' }),
            result('t4', { sent: true }),
          ],
        },
      }).message.content.map((b) => b.name ?? 'text');
    expect(next(SYSTEM)).toContain('send_email');
    expect(next(`${SYSTEM} Email the customer once per decision.`)).toEqual(['text']);
    expect(next(SYSTEM, 'Email the customer. Send one email per decision, never a second.')).toEqual(['text']);
  });
});
