import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyRun, decide, SPRT_DEFAULTS, Store, type RunRecord } from '@shadowlap/engine';
import { startMockAnthropic } from '@shadowlap-testing/mock-anthropic';

/**
 * scripts/demo-store.mjs builds the demo project the dashboard is shown on, each state made by the
 * CLI against the mock providers. Built here with --fast in a temporary folder, its store holds what
 * --fast promises: a run of every kind with blame's probes and verify's attempts under them, a fork
 * for each intervention it makes, an interrupted and a failed recording, a verified fix and an open
 * one, and goldens tested at several commits that passed, failed a check and diverged. The script
 * drives the built CLI, as the other end-to-end tests do.
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
    // A machine running other suites beside this one has taken four minutes over it.
  }, 600_000);

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
    const made = runs.filter((r) => r.mode === 'replay' && !r.meta?.probe && !r.meta?.verify && !r.meta?.test && !r.meta?.chaos).flatMap((r) => (r.meta?.interventions ?? []).map((i) => ({ ...i, parent: r.parentRunId })));
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

  it('previews a model switch on the ticket run: the $240 refund is a write removed', () => {
    const [session] = store.listDecisionSessions({ kind: 'decisions' });
    expect(session).toMatchObject({ change: 'the model claude-haiku-4-5', runs: 1, flagged: 1 });
    const run = store.getDecisionSession(session.sessionId)!.runRows[0].data as { rank: number; decisions: Array<{ callNo: number; rank: number | null; changes: Array<{ kind: string; tool: string | null }> }> };
    expect(run.rank).toBe(1);
    // It checks the tier-2 queue instead, a read: its effect comes from the runs that called it.
    expect(run.decisions[0].changes.map((c) => [c.kind, c.tool]).slice(0, 2)).toEqual([
      ['write-removed', 'issue_refund'],
      ['read-added', 'queue_status'],
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

  it('keeps refund-over-limit, replayed five times a session, as one test run with its attempts', () => {
    const tested = runs.filter((r) => r.meta?.test?.golden === 'goldens/refund-over-limit');
    const sessions = [...new Set(tested.map((r) => r.meta!.test!.session))];
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      const five = tested.filter((r) => r.meta!.test!.session === session);
      expect(five.map((r) => r.meta!.test!.attempt).sort()).toEqual([1, 2, 3, 4, 5]);
      // One run stands for the golden: the one its result shows, with the other four filed under it.
      const heads = five.filter((r) => classifyRun(r).attemptOf === null);
      expect(heads).toHaveLength(1);
      const head = heads[0];
      expect(store.listTestResults({ sessionId: session, golden: 'goldens/refund-over-limit', limit: 1 })[0]?.runId).toBe(head.runId);
      for (const r of five.filter((x) => x !== head)) expect(classifyRun(r)).toMatchObject({ kind: 'test', attemptOf: head.runId, attemptKind: 'test' });
    }
    const promised = JSON.parse(readFileSync(join(folder, 'runs.json'), 'utf8')) as { attempts: Record<string, number> };
    expect(promised.attempts.test).toBe(4 * sessions.length);
  });

  // Production coverage and error-path presets, on what the build left: the scan, the golden it
  // packed of the triage capture and the refund HAR it couldn't, and the presets of two goldens;
  // then --pack on the rest, until every behaviour seen in production has a golden.
  it('lists the imported behaviours no golden covers, packs one of each, and runs presets on goldens', async () => {
    const ids = (JSON.parse(readFileSync(join(folder, 'runs.json'), 'utf8')) as { runs: { coverageGolden: string } }).runs;
    const [scan] = store.listCoverageScans();
    expect(scan).toMatchObject({ runs: 4, groups: 4, uncovered: 2 });
    const groups = store.coverageGroups();
    const starting = (tool: string) => groups.find((g) => g.behaviour.path[0] === tool)!;
    expect(starting('list_inbox')).toMatchObject({ coveredBy: [ids.coverageGolden] });
    expect(starting('get_ticket').coveredBy).toEqual(['goldens/refund-flow-budget', 'goldens/refund-in-limit']);
    expect(starting('list_tickets')).toMatchObject({ coveredBy: [], behaviour: { writes: ['post_digest'] }, command: { argv: ['node', 'digest.mjs'] } });
    const refund = starting('lookup_order');
    expect(refund).toMatchObject({ coveredBy: [], behaviour: { path: ['lookup_order', 'get_policy', 'issue_refund', 'send_email'] }, command: { argv: ['node', 'agent.mjs', 'A-1077'] } });
    expect(refund.nearest?.differs).toEqual({ step: 3, seen: 'issue_refund', golden: 'escalate' });
    // What --pack made of each it tried: the triage golden, and why the refund HAR wasn't packed.
    const packs = new Map(store.coveragePacks().map((p) => [p.key, p]));
    expect(packs.get(starting('list_inbox').key)).toMatchObject({ golden: ids.coverageGolden, mode: 'replay' });
    expect(packs.get(refund.key)).toMatchObject({ golden: null, reason: 'not-reproduced', why: expect.stringMatching(/^node agent\.mjs A-1077 doesn't reproduce \w{10}: diverged at call 1 \(api POST \/v1\/messages\)/) });

    // Each preset's outcome: the ticket agent copes with every failure, the triage agent with none that fails a call.
    const verdicts = (golden: string) => Object.fromEntries(store.latestChaosResults().filter((r) => r.golden === golden).map((r) => [r.preset, r.verdict]));
    expect(verdicts('goldens/refund-in-limit')).toEqual({ timeout: 'passed', empty: 'passed', malformed: 'passed', oversized: 'passed', '429': 'passed', '500': 'passed' });
    expect(verdicts(ids.coverageGolden)).toEqual({ timeout: 'failed', empty: 'passed', malformed: 'passed', oversized: 'passed', '429': 'failed', '500': 'failed' });
    const attempts = runs.filter((r) => r.meta?.chaos);
    expect(attempts).toHaveLength(12);
    for (const a of attempts) expect(classifyRun(a).attemptKind).toBe('chaos');

    const coverage = (args: string[]) =>
      new Promise<{ code: number | null; out: string; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js'), 'coverage', ...args], {
          cwd: join(folder, 'support-agent'),
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(folder, 'home'), SHADOWLAP_AUTHOR: 'dana@example.com', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => resolve({ code, out, stdout }));
      });
    type Packed = { key: string; golden: string | null; mode: string | null; reason: string | null; command: { argv: string[] } | null };
    // The goldens made here are taken out again after, as the config is put back: the last test
    // applies the fixes to the goldens the build left.
    const configFile = join(folder, 'support-agent', 'shadowlap.config.json');
    const configBefore = readFileSync(configFile, 'utf8');
    const made: string[] = [];
    try {
      // The digest agent still does what its capture did: it is packed. The refund agent was fixed since.
      const packed = await coverage(['--pack', '--json']);
      expect(packed.code, packed.out).toBe(1);
      const pack = (JSON.parse(packed.stdout) as { pack: Packed[] }).pack;
      made.push(...pack.flatMap((p) => (p.golden ? [p.golden] : [])));
      expect(pack.find((p) => p.command?.argv[1] === 'digest.mjs')).toMatchObject({ golden: expect.stringMatching(/^goldens\/list-tickets-post-digest-[0-9a-f]{6}$/), mode: 'replay', reason: null });
      expect(pack.find((p) => p.key === refund.key)).toMatchObject({ golden: null, reason: 'not-reproduced' });
      // Kept as the test that the fix holds: production's order, run through the agent as it is now,
      // must escalate rather than refund.
      const forked = await coverage(['--pack', refund.key.slice(0, 8), '--fork', '--expect', '{"tools":{"issue_refund":0,"escalate":1}}', '--json']);
      expect(forked.code, forked.out).toBe(0);
      const fork = (JSON.parse(forked.stdout) as { pack: Packed[]; uncovered: number }).pack[0];
      if (fork.golden) made.push(fork.golden);
      expect(fork).toMatchObject({ golden: expect.stringMatching(/^goldens\/lookup-order-issue-refund-send-email-[0-9a-f]{6}$/), mode: 'fork', command: { argv: ['node', 'agent.mjs', 'A-1077'] } });
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as { tests: Record<string, unknown> };
      expect(config.tests[fork.golden!]).toEqual({ fork: true, expect: { tools: { issue_refund: 0, escalate: 1 } } });
      // One of each: no behaviour seen in production is left without a golden.
      const after = JSON.parse((await coverage(['--json'])).stdout) as { uncovered: number; groups: Array<{ covered: boolean }> };
      expect(after.uncovered).toBe(0);
      expect(after.groups.every((g) => g.covered)).toBe(true);
    } finally {
      for (const g of made) rmSync(join(folder, 'support-agent', g), { recursive: true, force: true });
      writeFileSync(configFile, configBefore);
    }
  }, 180_000);

  // Last: it applies both fixes and re-records goldens. The email fix changes send_email's
  // description, which every request of the refund agent carries, so the refund fix's goldens,
  // recorded before it, diverge from their first call.
  it('repairs and applies the email fix, names the goldens it leaves behind, and holds every fix once they are updated', async () => {
    const { createModels } = (await import(pathToFileURL(join(ROOT, 'scripts', 'demo-store', 'models.mjs')).href)) as { createModels(): { anthropic: Parameters<typeof startMockAnthropic>[0]['script'] } };
    const anthropic = await startMockAnthropic({ script: createModels().anthropic, eventDelayMs: () => 0 });
    const project = join(folder, 'support-agent');
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(folder, 'home'), SHADOWLAP_PROJECT_ROOTS: folder, SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url, ANTHROPIC_BASE_URL: anthropic.url, ANTHROPIC_API_KEY: 'demo-key', SHADOWLAP_AUTHOR: 'dana@example.com', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
    const sl = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, [join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js'), ...args], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('close', (code) => resolve({ code, out, err }));
      });
    type Fix = { fixId: string; status: string; title: string; broken: string | null };
    const fixes = async () => (JSON.parse((await sl(['fix', 'ls', '--json'])).out) as { fixes: Fix[] }).fixes;
    try {
      const ids = (JSON.parse(readFileSync(join(folder, 'runs.json'), 'utf8')) as { runs: { emailFix: string; refundFix: string; fixedGoldens: string[] } }).runs;
      const shown = JSON.parse((await sl(['fix', 'show', ids.emailFix, '--json'])).out) as { actions: { repair: { argv: string[] } } };
      const repaired = await sl([...shown.actions.repair.argv, '--repairer', 'anthropic', '--json']);
      expect(repaired.code, repaired.err).toBe(0);

      const email = await sl(['fix', 'apply', ids.emailFix, '--json']);
      expect(email.code, email.err).toBe(0);
      const applied = JSON.parse(email.out) as { tests: string; outdated: Array<{ golden: string; callNo: number; path: string }>; update: string };
      expect(applied.tests).toBe('passed');
      // The refund fix's goldens, at their first call, on the tool description the patch rewrote;
      // not the goldens of the ticket agent, whose requests carry no send_email.
      expect(applied.outdated.map((g) => g.golden).sort()).toEqual(ids.fixedGoldens.map((d) => `goldens/${d}`).sort());
      for (const g of applied.outdated) expect(g).toMatchObject({ callNo: 1, path: expect.stringMatching(/^\$\.tools\[\d+\]\.description$/) });
      expect(applied.update).toBe(`shadowlap test ${applied.outdated.map((g) => g.golden).join(' ')} --update`);

      // Applied now, the refund fix's goldens fail on that change: it doesn't hold.
      const refund = await sl(['fix', 'apply', ids.refundFix, '--json']);
      expect(refund.code).toBe(1);
      expect(JSON.parse(refund.out)).toMatchObject({ status: 'applied', patch: 'already', tests: 'failed' });
      expect((await fixes()).find((f) => f.fixId.startsWith(ids.refundFix))?.broken).toBe('shadowlap test failed on its goldens');

      // Updated, they pass, and with them the refund fix holds again.
      const updated = await sl(['test', ...applied.outdated.map((g) => g.golden), '--update']);
      expect(updated.code, updated.out).toBe(0);
      expect(updated.out).toContain(`holds again: its goldens passed · Refunds above the limit issued without approval`);
      expect((await fixes()).map((f) => [f.status, f.broken, f.title]).sort()).toEqual([
        ['applied', null, 'Confirmation email sent twice'],
        ['applied', null, 'Refunds above the limit issued without approval'],
      ]);
    } finally {
      await anthropic.close();
    }
  }, 180_000);
});

/**
 * What the demo's models answer after the build, when its mock providers run again for the
 * dashboard: Run repair on the open fix gets rewrites for the check its runs fail, which leave
 * the refund rules alone, and the agent heeds the one about emailing once.
 */
describe('the demo’s models', () => {
  type Answer = { candidates: Array<{ anchor: number; replace: string; strategy: string }> };
  type Models = { anthropic(ctx: { request: Record<string, unknown> }): { message: { content: Array<{ type: string; text?: string; name?: string }> } }; control: { email: string } };
  const load = async (): Promise<Models> => ((await import(pathToFileURL(join(ROOT, 'scripts', 'demo-store', 'models.mjs')).href)) as { createModels(): Models }).createModels();
  const SYSTEM = 'You are a support agent. Follow the refund policy: escalate every refund above the limit.';

  it('offers a repair rewrites for the check its runs fail', async () => {
    const models = await load();
    const ask = (must: string): Answer => {
      const user = `## What a run must do\n\n${must}\n\n## The agent's instructions\n\nSystem prompt:\n${SYSTEM}\n\n## Text you may rewrite\n\n[1] system prompt, in agent.mjs: ${SYSTEM}\n[2] tool issue_refund, in agent.mjs: Refund an order in full.\n[3] tool send_email, in agent.mjs: Email the customer.\n\n## Rules\n\n- …`;
      const out = models.anthropic({ request: { model: 'claude-opus-5-5', system: 'You improve AI agents by rewriting the instructions they are given.', messages: [{ role: 'user', content: user }] } });
      return JSON.parse(out.message.content[0].text!) as Answer;
    };
    // A confirmation sent twice: emailing once, in the prompt or the tool, and nothing about refunds.
    const email = ask('- the agent exits 0\n- send_email called 1 time');
    expect(email.candidates.map((c) => c.anchor)).toEqual([1, 3]);
    expect(email.candidates[0].replace).toBe(`${SYSTEM} Email the customer once per decision.`);
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

  // Repair's last rewrite is the fix the build keeps: verify replays each failing run under it until
  // the default gate decides, one run after another, on one model. A fix that holds four times in
  // five sits between the gate's two rates, so no run settles and repair keeps nothing.
  it('escalates under the refund fix often enough for verify’s default gate to keep it', async () => {
    const models = await load();
    const use = (id: string, name: string, input: unknown) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
    const result = (id: string, value: unknown) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(value) }] });
    const escalates = () =>
      models
        .anthropic({
          request: {
            model: 'claude-sonnet-5',
            system: SYSTEM,
            messages: [
              { role: 'user', content: 'Order A-1042: the customer asks for a refund.' },
              use('t1', 'lookup_order', { order_id: 'A-1042' }),
              result('t1', { order_id: 'A-1042', amount: 240 }),
              use('t2', 'get_policy', { topic: 'refunds' }),
              result('t2', { limit: 100 }),
            ],
          },
        })
        .message.content.some((b) => b.name === 'escalate');
    const gate = { kind: 'sprt' as const, ...SPRT_DEFAULTS };
    for (const run of ['A-1042', 'A-1077', 'A-1103', 'A-1042 again']) {
      const seen: boolean[] = [];
      let decision = decide(0, 0, gate);
      while (decision === 'continue') {
        seen.push(escalates());
        decision = decide(seen.filter(Boolean).length, seen.length, gate);
      }
      expect(decision, `${run}: escalated ${seen.filter(Boolean).length} of ${seen.length}`).toBe('pass');
    }
  });
});
