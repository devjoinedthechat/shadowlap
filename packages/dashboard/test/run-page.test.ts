import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRun, showJson, Store, type BlameRecord, type RunIntervention, type RunMeta } from '@shadowlap/engine';
// The record a replay keeps of its flags is written by the sidecar when the replay starts.
import { describeInterventions } from '@shadowlap/sidecar';
import { callDetail, countMasked, exportHtml, provenance, runDetail, showRunJson, startDashboard, type RunDetail } from '../src/index.js';

type RunDetailShape = Pick<RunDetail, 'intervention' | 'interventions' | 'notRecorded'>;
import { assistant, batchRun, closingBatch, RunBuilder, SYSTEM, text, toolResult, toolUse, TOOLS, usage, user } from '../../engine/test/run-fixtures.js';

describe('the run page: conversations', () => {
  it('numbers the conversations of a batch and shows a tool call its own ticket', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 40);
    const d = runDetail(store, runId)!;
    expect(d.conversations).toHaveLength(40);
    expect(d.cache.misses).toEqual([]);
    const [get, m1, lookup, m2, refund, m3] = byTicket.get(31)!;
    const row = (n: number) => d.calls.find((c) => c.callNo === n)!;
    expect([get, m1, lookup, m2, refund, m3].map((n) => row(n!).conversation)).toEqual([31, 31, 31, 31, 31, 31]);
    expect(row(m1!).conversationStart).toBe(true);
    expect(row(m2!).conversationStart).toBe(false);
    expect(row(lookup!)).toMatchObject({ requestedBy: m1, toolUseId: 'toolu_31_1', resultShort: '{"order_id":"A-2031","amount":71}' });
    // The tool call's conversation is its own ticket's, as it stood when the tool was called.
    const tool = callDetail(store, runId, refund!)!;
    expect(tool.conversation).toMatchObject({ fromCallNo: m2, n: 31 });
    expect(tool.conversation!.turns.find((t) => t.role === 'user')!.blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('A-2031') });
    // Fetched before its ticket's first model call: the conversation it feeds.
    expect(callDetail(store, runId, get!)!.conversation).toMatchObject({ fromCallNo: m1, n: 31 });
    store.close();
  });

  it('shows a ticket’s fetch its own ticket when the ticket before ended on a tool call', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = closingBatch(store, 3);
    const d = runDetail(store, runId)!;
    for (const [t, x] of byTicket) {
      const fetch = callDetail(store, runId, x.get)!;
      expect(fetch.call.conversation).toBe(t);
      expect(fetch.conversation).toMatchObject({ fromCallNo: x.first, n: t });
      expect(fetch.conversation!.turns.find((turn) => turn.role === 'user')!.blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining(`Ticket T-${t}:`) });
      // The CRM call close_ticket made stays with the ticket it closed.
      expect(d.calls.find((c) => c.callNo === x.crm)!.conversation).toBe(t);
    }
    expect(d.conversations.map((c) => c.calls)).toEqual([6, 6, 6]);
    store.close();
  });

  it('never shows a tool call another conversation’s request, even the latest one before it', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const qa = [user('Ticket A: order A-1 arrived damaged.')];
    const qb = [user('Ticket B: order B-2 never arrived.')];
    const ma = b.model({ system: SYSTEM, tools: TOOLS, messages: qa }, [toolUse('lookup_order', { order_id: 'A-1' }, 'toolu_a1')]);
    const mb = b.model({ system: SYSTEM, tools: TOOLS, messages: qb }, [toolUse('lookup_order', { order_id: 'B-2' }, 'toolu_b1')]);
    const ta = b.tool('lookup_order', { order_id: 'A-1' }, { status: 'delivered' });
    b.end();
    const tool = callDetail(store, b.runId, ta)!;
    expect(tool.call.conversation).toBe(1);
    expect(tool.conversation).toMatchObject({ fromCallNo: ma, n: 1 });
    expect(mb).toBe(ta - 1);
    store.close();
  });

  it('keeps each scope’s conversation apart in a multi-agent run', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const opening = 'Hi, my order A-1042 arrived damaged.';
    const c1 = b.model({ messages: [user('Start the conversation.')] }, [text(opening)], { scope: 'customer', usage: usage(10, 0, 2000) });
    const agentA = [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_lo')];
    const a1 = b.model({ system: SYSTEM, messages: [user(opening)] }, agentA, { scope: 'agent', usage: usage(10, 0, 8000) });
    const p1 = b.model({ messages: [user('Does a $240 refund need approval?')] }, [toolUse('lookup_policy', { region: 'EU' }, 'toolu_lp')], { scope: 'agent/policy-checker', usage: usage(10, 0, 20_000) });
    const lo = b.tool('lookup_order', { order_id: 'A-1042' }, { amount: 240 }, { scope: 'agent' });
    const lp = b.tool('lookup_policy', { region: 'EU' }, { refund_limit: 100 }, { scope: 'agent/policy-checker' });
    // The agent reads its own 8,010 tokens back: no miss, though the sub-agent's call just before held 20,010.
    const a2 = b.model({ system: SYSTEM, messages: [user(opening), assistant(agentA), user([toolResult('toolu_lo', { amount: 240 })])] }, [text('Escalating.')], { scope: 'agent', usage: usage(10, 8010, 300) });
    b.end();
    const d = runDetail(store, b.runId)!;
    expect(d.conversations.map((c) => [c.n, c.scope, c.firstCallNo])).toEqual([
      [1, 'customer', c1],
      [2, 'agent', a1],
      [3, 'agent/policy-checker', p1],
    ]);
    expect(d.cache.misses).toEqual([]);
    expect(callDetail(store, b.runId, lo)!.conversation).toMatchObject({ fromCallNo: a1, n: 2 });
    expect(callDetail(store, b.runId, lp)!.conversation).toMatchObject({ fromCallNo: p1, n: 3 });
    expect(d.calls.find((c) => c.callNo === a2)!.conversation).toBe(2);
    store.close();
  });

  it('marks where the prompt cache stopped hitting, with the tokens sent again', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 5, { broken: { ticket: 4, call: 2 } });
    const d = runDetail(store, runId)!;
    const [, m1, , m2] = byTicket.get(4)!;
    expect(d.cache.misses).toEqual([{ callNo: m2, sentAgain: 6000, previousCallNo: m1, scope: null, conversation: 4 }]);
    expect(d.calls.find((c) => c.callNo === m2)!.cacheMiss).toEqual({ sentAgain: 6000, previousCallNo: m1 });
    expect(d.calls.find((c) => c.callNo === m1)!.cacheMiss).toBeNull();
    expect(d.cache.readShare).toBeGreaterThan(0.5);
    store.close();
  });
});

describe('the run page: time not waited, blobs and results', () => {
  it('gives each replayed call its recorded duration and the run what it did not wait for', () => {
    const store = Store.open(':memory:');
    const rec = RunBuilder.start(store);
    rec.model({ messages: [user('Go.')] }, [toolUse('search', { q: 'x' }, 'toolu_1')], { latencyMs: 2900 });
    rec.tool('search', { q: 'x' }, ['a', 'b'], { latencyMs: 340 });
    rec.model({ messages: [user('Go.'), assistant([toolUse('search', { q: 'x' }, 'toolu_1')]), user([toolResult('toolu_1', '["a","b"]')])] }, [text('Done.')], { latencyMs: 3100 });
    rec.end();
    const replay = RunBuilder.start(store, { parent: rec.runId });
    replay.model({ messages: [user('Go.')] }, [toolUse('search', { q: 'x' }, 'toolu_1')], { origin: 'replayed', replayedFrom: 1 });
    replay.tool('search', { q: 'x' }, ['a', 'b'], { origin: 'replayed', replayedFrom: 2 });
    replay.model({ messages: [user('Go.'), assistant([toolUse('search', { q: 'x' }, 'toolu_1')]), user([toolResult('toolu_1', '["a","b"]')])] }, [text('Done.')], { origin: 'replayed', replayedFrom: 3 });
    replay.end();
    const d = runDetail(store, replay.runId)!;
    expect(d.calls.map((c) => [c.latencyMs, c.recordedMs])).toEqual([
      [0, 2900],
      [0, 340],
      [0, 3100],
    ]);
    expect(d.notWaitedMs).toBe(6340);
    // The blobs a call is stored as, for Provenance; a replayed call shares its recording's.
    const recorded = runDetail(store, rec.runId)!;
    expect(d.calls[1]!.responseRef).toBe(recorded.calls[1]!.responseRef);
    expect(d.calls[0]!.requestRef).toMatch(/^[0-9a-f]{64}$/);
    expect(d.calls[0]!.fingerprint).toBe('fp-1');
    expect(recorded.calls.map((c) => c.recordedMs)).toEqual([null, null, null]);
    expect(recorded.notWaitedMs).toBe(0);
    expect(recorded.calls.map((c) => c.resultShort)).toEqual([null, '["a","b"]', null]);
    store.close();
  });

  it('reads each tool result once, however often the run page asks', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, note: 'x'.repeat(40) })) };
    for (let i = 0; i < 20; i++) b.tool('export_rows', { page: i }, { ...big, page: i });
    b.tool('send_email', { to: 'x' }, { stubbed: true }, { origin: 'stubbed', effect: 'write' });
    b.end();
    const results = new Set(store.getCalls(b.runId).map((c) => c.end!.responseRef));
    const real = store.getJson.bind(store);
    let reads = 0;
    store.getJson = ((hash: string) => {
      if (results.has(hash)) reads++;
      return real(hash);
    }) as typeof store.getJson;
    const first = runDetail(store, b.runId)!;
    expect(first.calls[0]!.resultShort).toBe(`${JSON.stringify({ ...big, page: 0 }).slice(0, 71)}…`);
    expect(first.calls[20]!.resultShort).toBe('stubbed {"stubbed":true}');
    expect(reads).toBe(21);
    reads = 0;
    // Asked again, as the run page does every two seconds: no tool result is read again.
    expect(runDetail(store, b.runId)!.calls.map((c) => c.resultShort)).toEqual(first.calls.map((c) => c.resultShort));
    expect(reads).toBe(0);
    store.close();
  });
});

describe('the run page: header and banners', () => {
  function forked(store: Store) {
    const rec = RunBuilder.start(store);
    for (let i = 1; i <= 4; i++) rec.model({ messages: [user(`q${i}`)] }, [text('a')]);
    rec.end();
    const fork = RunBuilder.start(store, { parent: rec.runId });
    fork.model({ messages: [user('q1')] }, [text('a')], { origin: 'replayed', replayedFrom: 1 });
    fork.model({ messages: [user('q2')] }, null, { injected: true, status: 529 });
    fork.tool('add_note', { note: 'down' }, { stubbed: true }, { origin: 'stubbed', effect: 'write' });
    fork.end();
    store.setDivergence(fork.runId, { type: 'forced', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1, reason: "forced live by --fail-at 2=529: answered with HTTP 529 instead of the recording, so the agent's error path runs" });
    return { rec: rec.runId, fork: fork.runId };
  }

  it('names the fork and the flag that made it', () => {
    const store = Store.open(':memory:');
    const { rec, fork } = forked(store);
    const d = runDetail(store, fork)!;
    expect(d.forkAt).toBe(2);
    expect(d.intervention).toEqual({ flag: '--fail-at', value: '2=529', callNo: 2 });
    expect(d.interventions.map((x) => x.flag)).toEqual(['--fail-at', '--writes']);
    expect(d.calls[2]!.resultShort).toBe('stubbed {"stubbed":true}');
    // Stored flags win, as the sidecar keeps them: the instruction in its short form.
    store.updateRunMeta(fork, { interventions: describeInterventions(undefined, { inject: { atCall: 2, text: 'Prefer the 2026 policy', as: 'user' } }) });
    expect(runDetail(store, fork)!.intervention).toEqual({ flag: '--inject', value: '2=Prefer the 2026 policy', callNo: 2 });
    expect(runDetail(store, fork)!.interventions.map((x) => x.flag)).toEqual(['--inject']);
    const r = runDetail(store, rec)!;
    expect([r.forkAt, r.intervention, r.interventions, r.rescuedBy, r.blame, r.checks, r.notRecorded]).toEqual([null, null, [], null, null, null, null]);
    store.close();
  });

  it('says where a blamed run was lost, counted in its scope, and which fork blame rescued', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('Start.')] }, [text('Refund please.')], { scope: 'customer' });
    b.model({ messages: [user('Refund please.')] }, [toolUse('lookup_order', {}, 't1')], { scope: 'agent' });
    b.tool('lookup_order', {}, { amount: 240 }, { scope: 'agent' });
    b.model({ messages: [user('Refund please.'), assistant([toolUse('lookup_order', {}, 't1')]), user([toolResult('t1', 'x')])] }, [toolUse('issue_refund', {}, 't2')], { scope: 'agent' });
    b.model({ messages: [user('Start.'), assistant([text('Refund please.')]), user('Done.')] }, [text('Thanks.')], { scope: 'customer' });
    b.end();
    const rescued = RunBuilder.start(store, { parent: b.runId });
    rescued.model({ messages: [user('Start.')] }, [text('Refund please.')], { scope: 'customer', origin: 'replayed', replayedFrom: 1 });
    rescued.end();
    const blame: BlameRecord = { at: 5, outcome: 'blamed', callNo: 4, confidence: 'high', rescuedRunId: rescued.runId, fields: {}, scope: 'agent', oracle: ['issue_refund called 0 times'], probes: [], spent: 0.1 };
    store.updateRunMeta(b.runId, { blame });
    const d = runDetail(store, b.runId)!;
    expect(d.blame).toEqual({ outcome: 'blamed', callNo: 4, modelCall: { k: 2, m: 2 }, confidence: 'high', rescuedRunId: rescued.runId, scope: 'agent', at: 5 });
    expect(runDetail(store, rescued.runId)!.rescuedBy).toEqual({ runId: b.runId, callNo: 4 });
    // Without a scope, every model call counts.
    store.updateRunMeta(b.runId, { blame: { ...blame, scope: undefined as never } });
    expect(runDetail(store, b.runId)!.blame!.modelCall).toEqual({ k: 3, m: 4 });
    store.close();
  });

  it('counts each check over the attempts it ran in', () => {
    const store = Store.open(':memory:');
    const golden = RunBuilder.start(store).end();
    const attempts: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const meta: RunMeta = { repeat: { group: 'g1', attempt: i, of: 5 }, checks: [{ ok: true, label: 'issue_refund never called', detail: null }, { ok: i !== 3, label: 'exit 0', detail: i === 3 ? 'exited 1' : null }] };
      attempts.push(RunBuilder.start(store, { parent: golden, meta }).end());
    }
    // Another invocation's attempt under the same recording is not counted with these.
    RunBuilder.start(store, { parent: golden, meta: { repeat: { group: 'g2', attempt: 1, of: 1 }, checks: [{ ok: false, label: 'exit 0', detail: 'exited 1' }] } }).end();
    expect(runDetail(store, attempts[0]!)!.checks).toEqual([
      { label: 'issue_refund never called', ok: true, detail: null, count: 5, of: 5 },
      { label: 'exit 0', ok: true, detail: null, count: 4, of: 5 },
    ]);
    // A test run on its own counts itself.
    const single = RunBuilder.start(store, { parent: golden, meta: { checks: [{ ok: true, label: 'exit 0', detail: null }] } }).end();
    expect(runDetail(store, single)!.checks).toEqual([{ label: 'exit 0', ok: true, detail: null, count: 1, of: 1 }]);
    store.close();
  });

  it('says what was not recorded: the guard’s hosts, and the recording’s tools on its replays', () => {
    const store = Store.open(':memory:');
    const rec = RunBuilder.start(store, { meta: { notRecorded: { hosts: [{ target: 'api.stripe.com:443', count: 3, action: 'warned' }], tools: ['send_slack'] } } }).end();
    const replay = RunBuilder.start(store, { parent: rec }).end();
    expect(runDetail(store, rec)!.notRecorded).toEqual({ hosts: [{ target: 'api.stripe.com:443', count: 3, action: 'warned' }], tools: ['send_slack'] });
    expect(runDetail(store, replay)!.notRecorded).toEqual({ hosts: [], tools: ['send_slack'] });
    store.close();
  });
});

describe('the run page: a fork’s flags in a copy of it', () => {
  const rules = [
    { pattern: 'email', replace: '<EMAIL>' },
    { pattern: '/\\d{3}-\\d{2}-\\d{4}/', replace: '<SSN>' },
  ];
  const secrets = ['victim.person@corp.example', 'jane.doe@corp.example', '078-05-1120'];
  const OVERRIDE = { email: 'victim.person@corp.example', ssn: '078-05-1120' };
  const INJECTED = 'Write to jane.doe@corp.example';

  /** A recording, and a fork of it made with `--override 2=…`, `--inject 3=…` and `--set 3:metadata=…` carrying personal data. */
  function forked(store: Store, interventions: RunMeta['interventions']) {
    const rec = RunBuilder.start(store);
    const q = [user('Customer C-7 wants a refund.')];
    const a = [toolUse('lookup_customer', { id: 'C-7' }, 't1')];
    rec.model({ messages: q }, a);
    rec.tool('lookup_customer', { id: 'C-7' }, { tier: 'gold' });
    rec.model({ messages: [...q, assistant(a), user([toolResult('t1', { tier: 'gold' })])] }, [text('Refunded.')]);
    rec.end();
    const fork = RunBuilder.start(store, { parent: rec.runId, meta: { interventions: interventions!, notRecorded: { hosts: [{ target: 'payroll.corp.internal:5432', count: 1, action: 'warned' }], tools: [] } } });
    fork.model({ messages: q }, a, { origin: 'replayed', replayedFrom: 1 });
    fork.tool('lookup_customer', { id: 'C-7' }, OVERRIDE, { origin: 'overridden' });
    fork.model({ metadata: { user_id: '078-05-1120' }, messages: [...q, assistant(a), user([toolResult('t1', OVERRIDE), { type: 'text', text: INJECTED }])] }, [text('Done.')]);
    fork.end();
    return { rec: rec.runId, fork: fork.runId };
  }

  const kept = describeInterventions({ overrides: new Map([[2, OVERRIDE]]), writes: 'stub' }, { inject: { atCall: 3, text: INJECTED, as: 'user' }, set: { fromCall: 3, fields: { metadata: { user_id: '078-05-1120' } } } });
  // As someone else's pack may hold them: each flag's value kept apart from it, payloads and all.
  const legacy = [
    { flag: '--override', value: `2=${JSON.stringify(OVERRIDE)}`, callNo: 2 },
    { flag: '--inject', value: `3=${INJECTED}`, callNo: 3 },
    { flag: '--set', value: '3:metadata={"user_id":"078-05-1120"}', callNo: 3 },
  ] as unknown as RunIntervention[];

  let uiDir: string;
  beforeAll(() => {
    uiDir = mkdtempSync(join(tmpdir(), 'sl-run-page-export-'));
    mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
    writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
    writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
    writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
  afterAll(() => rmSync(uiDir, { recursive: true, force: true }));

  it('keeps each flag exactly on the run, and shows an override as the call recorded it', () => {
    const store = Store.open(':memory:');
    const { fork } = forked(store, kept);
    // The run keeps what made the fork exactly, so the fork menu can make it again; its page shows the short form.
    expect(store.getRun(fork)!.meta!.interventions!.find((i) => i.kind === 'override')!.args).toEqual(['--override', `2=${JSON.stringify(OVERRIDE)}`]);
    const d = runDetail(store, fork)!;
    expect(d.interventions).toEqual([
      { flag: '--inject', value: `3=${INJECTED}`, callNo: 3 },
      { flag: '--set', value: '3:metadata={"user_id":"078-05-1120"}', callNo: 3 },
      { flag: '--override', value: `2=${JSON.stringify(OVERRIDE)}`, callNo: 2 },
      { flag: '--writes', value: 'stub', callNo: null },
    ]);
    store.close();
  });

  for (const [what, interventions] of [['as kept now', kept], ['as someone else’s pack may hold them', legacy]] as const) {
    it(`masks them in an HTML export and a pack, ${what}`, () => {
      const store = Store.open(':memory:');
      const { fork } = forked(store, interventions);
      const html = exportHtml({ store, runIds: [fork], uiDir, redact: rules }).html;
      for (const s of secrets) expect(html, s).not.toContain(s);
      const data = JSON.parse(/<script type="application\/json" id="shadowlap-data">([\s\S]*?)<\/script>/.exec(html)![1]!.replace(/<\\\//g, '</')) as { responses: Record<string, RunDetailShape> };
      const shown = data.responses[`runs/${fork}`]!;
      // The override as the copy's call recorded it, masked there; a value someone else's pack kept apart from its flag is left out.
      if (interventions === kept) expect(shown.interventions.find((x) => x.flag === '--override')).toEqual({ flag: '--override', value: '2={"email":"<EMAIL>","ssn":"<SSN>"}', callNo: 2 });
      else expect(shown.interventions.map((x) => x.value)).toEqual([null, null, null]);
      expect(shown.notRecorded!.hosts[0]!.target).toBe('payroll.corp.internal:5432');

      const dir = mkdtempSync(join(tmpdir(), 'sl-run-page-pack-'));
      try {
        packRun(store, fork, dir, { lineage: true, redact: rules });
        const files = [join(dir, 'run.json'), join(dir, 'calls.jsonl'), ...readdirSync(join(dir, 'blobs')).map((b) => join(dir, 'blobs', b))];
        for (const f of files) for (const s of secrets) expect(readFileSync(f, 'utf8'), `${s} in ${f}`).not.toContain(s);
        const packed = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<{ runId: string; meta: RunMeta }> };
        expect(packed.runs.find((r) => r.runId === fork)!.meta.interventions!.length).toBe(interventions.length);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      store.close();
    });
  }

  it('masks the hosts the guard named with a rule that matches them', () => {
    const store = Store.open(':memory:');
    const { fork } = forked(store, kept);
    const html = exportHtml({ store, runIds: [fork], uiDir, redact: [{ pattern: '/[a-z]+\\.corp\\.internal/', replace: '<HOST>' }] }).html;
    expect(html).not.toContain('payroll.corp.internal');
    expect(html).toContain('<HOST>:5432');
    store.close();
  });
});

describe('the run page: metadata from someone else’s pack', () => {
  it('shows only what is well formed, and never fails the run', () => {
    const store = Store.open(':memory:');
    const parent = RunBuilder.start(store, { meta: { blame: { rescuedRunId: 'x', callNo: 'two' } as never } }).end();
    const meta = {
      notRecorded: { hosts: ['evil', { target: 'api.example.com:443', count: 2, action: 'exfiltrated' }], tools: [1, 'send_slack'] },
      checks: 'all good',
      blame: { outcome: 'pwned', callNo: 1.5, confidence: 9, scope: { x: 1 }, at: 'yesterday' },
      interventions: { flag: '--fail-at' },
      repeat: { group: { $ne: null } },
    } as unknown as RunMeta;
    const b = RunBuilder.start(store, { parent, meta });
    b.model({ messages: [user('x')] }, [text('y')]);
    b.end();
    const d = runDetail(store, b.runId)!;
    expect(d.notRecorded).toEqual({ hosts: [{ target: 'api.example.com:443', count: 2, action: 'warned' }], tools: ['send_slack'] });
    expect(d.checks).toBeNull();
    expect(d.blame).toEqual({ outcome: 'stopped', callNo: null, modelCall: null, confidence: 'low', rescuedRunId: null, scope: null, at: 0 });
    expect(d.interventions).toEqual([]);
    expect(d.rescuedBy).toBeNull();
    store.close();
  });
});

describe('the run page: provenance', () => {
  it('states the record, the lineage and what a copy would mask', () => {
    const store = Store.open(':memory:');
    const rec = RunBuilder.start(store, { startedAt: Date.UTC(2026, 9, 1, 9, 41, 7) });
    rec.model({ messages: [user('Email jane@example.com about A-1042.')] }, [toolUse('send_email', { to: 'jane@example.com' }, 't1')], { usage: usage(100, 0, 0), model: 'claude-sonnet-5-20260101' });
    rec.tool('send_email', { to: 'jane@example.com' }, { sent: true }, { effect: 'write' });
    rec.model({ messages: [user('Email jane@example.com about A-1042.'), assistant([toolUse('send_email', { to: 'jane@example.com' }, 't1')]), user([toolResult('t1', 'sent')])] }, [text('Sent to jane@example.com.')], { usage: usage(120, 0, 0), model: 'claude-sonnet-5-20260101', scope: 'agent' });
    rec.end();
    const replay = RunBuilder.start(store, { parent: rec.runId });
    replay.model({ messages: [user('Email jane@example.com about A-1042.')] }, [text('x')], { origin: 'replayed', replayedFrom: 1 });
    replay.end();
    const p = provenance(store, rec.runId, { redact: [{ pattern: 'email', replace: '<EMAIL>' }] })!;
    expect(p).toMatchObject({
      runId: rec.runId,
      label: 'recording',
      command: ['python', 'agent.py'],
      codeVersion: 'abc1234',
      startedUtc: '2026-10-01 09:41:07 UTC',
      models: [{ model: 'claude-sonnet-5-20260101', short: 'sonnet-5', calls: 2 }],
      providers: [{ provider: 'anthropic', calls: 2 }],
      calls: { model: 2, tool: 1, other: 0, scopes: 1 },
      origins: { live: 3, replayed: 0, blocked: 0, stubbed: 0, overridden: 0, injected: 0 },
      lineage: [{ runId: rec.runId, parentRunId: null, mode: 'record', label: 'recording', codeVersion: 'abc1234' }],
    });
    expect(p.endedUtc).toMatch(/^2026-10-01 09:41:\d\d UTC$/);
    expect(p.upstream.requests).toBe(2);
    // Two requests and a tool's arguments each hold the address; so do the last response and the tool's.
    expect(p.mask.rules).toBe(1);
    expect(p.mask.values).toBe(countMasked(store, rec.runId, [{ pattern: 'email', replace: '<EMAIL>' }]));
    expect(p.mask.values).toBeGreaterThanOrEqual(5);
    expect(provenance(store, rec.runId)!.mask).toEqual({ rules: 0, values: 0 });
    expect(provenance(store, rec.runId, { maskCount: () => ({ rules: 3, values: 7 }) })!.mask).toEqual({ rules: 3, values: 7 });
    expect(provenance(store, replay.runId)!.lineage.map((x) => x.runId)).toEqual([rec.runId, replay.runId]);
    expect(provenance(store, 'nope')).toBeNull();
    store.close();
  });

  it('serves show --json exactly as the CLI prints it', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('x')] }, [text('y')], { usage: usage(10, 0, 0) });
    b.end();
    expect(JSON.stringify(showRunJson(store, b.runId))).toBe(JSON.stringify(showJson(store, store.getRun(b.runId)!)));
    store.close();
  });
});

describe('the run endpoint', () => {
  it('returns the run page’s facts over HTTP', async () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 3);
    const uiDir = mkdtempSync(join(tmpdir(), 'sl-run-page-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Shadowlap</title>');
    const dash = await startDashboard({ store, uiDir });
    try {
      const get = async (path: string) => (await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } })).json() as Promise<Record<string, unknown>>;
      const d = await get(`runs/${runId}`);
      expect(d).toMatchObject({ conversations: [{ n: 1 }, { n: 2 }, { n: 3 }], notWaitedMs: 0, forkAt: null, intervention: null, notRecorded: null, cache: { misses: [] } });
      const [, , lookup] = byTicket.get(2)!;
      const call = await get(`runs/${runId}/calls/${lookup}`);
      expect(call).toMatchObject({ call: { conversation: 2, requestedBy: lookup! - 1, toolUseId: 'toolu_2_1' }, conversation: { fromCallNo: lookup! - 1, n: 2 } });
      // A run in no fix says so; the Provenance tab's record has its own endpoint, as the read model gives it.
      expect(d.fix).toBeNull();
      expect(await get(`runs/${runId}/provenance`)).toEqual(JSON.parse(JSON.stringify(provenance(store, runId))));
      expect((await fetch(`${dash.url}/api/runs/01NOSUCHRUN0000000000000000/provenance`, { headers: { 'x-shadowlap-token': dash.token } })).status).toBe(404);
    } finally {
      await dash.close();
      rmSync(uiDir, { recursive: true, force: true });
      store.close();
    }
  });
});
