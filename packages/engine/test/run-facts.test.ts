import { describe, expect, it } from 'vitest';
import { inferInterventions, overrideSources, recordNotRecorded, redactRun, redactRunFacts, runInterventions, showJson, Store, summarizeRun, toolResultLine, unrecordedProjectTools, type CallRecord, type RunIntervention, type RunMeta } from '../src/index.js';
import { RunBuilder, text, toolUse, user } from './run-fixtures.js';

describe('a replay’s interventions', () => {
  it('names each flag a replay ran with, as the run keeps them, with what follows each in its short form', () => {
    const store = Store.open(':memory:');
    const rec = RunBuilder.start(store);
    rec.model({ messages: [user('q')] }, [text('a')]);
    rec.end();
    // The record the sidecar writes when a replay starts: each flag exactly (`args`) beside its short form.
    const interventions: RunIntervention[] = [
      { kind: 'inject', at: 15, flag: '--inject 15=Prefer sources from 2026. --inject-as system', args: ['--inject', '15=Prefer sources from 2026.', '--inject-as', 'system'] },
      { kind: 'model', at: 15, flag: '--model 15:claude-opus-5', args: ['--model', '15:claude-opus-5'] },
      { kind: 'fail', at: 19, flag: '--fail-at 19=529', args: ['--fail-at', '19=529'] },
      { kind: 'override', at: 16, flag: '--override 16=@policy.json', args: ['--override', '16={"region":"EU"}'] },
      { kind: 'live-tool', at: null, flag: '--live-tool search_web', args: ['--live-tool', 'search_web'] },
      { kind: 'writes', at: null, flag: '--writes stub', args: ['--writes', 'stub'] },
      // The command a replay ran instead of its parent's is the run's own record, not a flag.
      { kind: 'command', at: null, flag: '-- python agent_v2.py' },
    ];
    const fork = RunBuilder.start(store, { parent: rec.runId, meta: { interventions } });
    fork.end();
    const run = store.getRun(fork.runId)!;
    expect(runInterventions(store, run, [])).toEqual([
      { flag: '--inject', value: '15=Prefer sources from 2026. --inject-as system', callNo: 15 },
      { flag: '--model', value: '15:claude-opus-5', callNo: 15 },
      { flag: '--fail-at', value: '19=529', callNo: 19 },
      { flag: '--override', value: '16=@policy.json', callNo: 16 },
      { flag: '--live-tool', value: 'search_web', callNo: null },
      { flag: '--writes', value: 'stub', callNo: null },
    ]);
    // A replay that changed nothing keeps an empty list; a record from someone else's pack that is no list, or holds odd entries, gives what it can.
    store.updateRunMeta(fork.runId, { interventions: [] });
    expect(runInterventions(store, store.getRun(fork.runId)!, [])).toEqual([]);
    store.updateRunMeta(fork.runId, { interventions: 'x' as unknown as RunIntervention[] });
    expect(runInterventions(store, store.getRun(fork.runId)!, [])).toEqual([]);
    store.updateRunMeta(fork.runId, { interventions: [null, 7, { flag: 3 }, { kind: 'diverge', at: 'x', flag: '--diverge-at 7' }] as unknown as RunIntervention[] });
    expect(runInterventions(store, store.getRun(fork.runId)!, [])).toEqual([{ flag: '--diverge-at', value: '7', callNo: null }]);
    store.close();
  });

  it('reads the files overrides came from as the CLI was given them', () => {
    expect(overrideSources(['16=@policy.json', '9={"ok":true}', '3=@payloads/exfil email.json', 'x=@nope'])).toEqual({ 16: '@policy.json', 3: '@payloads/exfil email.json' });
    expect(overrideSources([])).toEqual({});
  });

  it('reads them back from a replay stored before they were kept', () => {
    const store = Store.open(':memory:');
    const rec = RunBuilder.start(store);
    for (let i = 0; i < 4; i++) rec.model({ messages: [user(`q${i}`)] }, [text('a')]);
    rec.end();
    const fork = RunBuilder.start(store, { parent: rec.runId });
    fork.model({ messages: [user('q0')] }, [text('a')], { origin: 'replayed', replayedFrom: 1 });
    fork.model({ messages: [user('q1')] }, null, { injected: true, status: 529 });
    fork.tool('add_note', { note: 'down' }, { stubbed: true }, { origin: 'stubbed', effect: 'write' });
    fork.end();
    store.setDivergence(fork.runId, { type: 'forced', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1, reason: "forced live by --fail-at 2=529: answered with HTTP 529 instead of the recording, so the agent's error path runs" });
    const run = store.getRun(fork.runId)!;
    expect(inferInterventions(store, run, store.getCalls(run.runId))).toEqual([
      { flag: '--fail-at', value: '2=529', callNo: 2 },
      { flag: '--writes', value: 'stub', callNo: null },
    ]);

    const over = RunBuilder.start(store, { parent: rec.runId });
    over.tool('lookup_policy', { region: 'EU' }, { region: 'EU', refund_limit: 100 }, { origin: 'overridden' });
    over.end();
    store.setDivergence(over.runId, { type: 'forced', callNo: 1, kind: 'tool', name: 'search', replayedBefore: 0, reason: 'forced live by --live-tool search' });
    const overCalls = store.getCalls(over.runId);
    expect(inferInterventions(store, store.getRun(over.runId)!, overCalls)).toEqual([
      { flag: '--override', value: '1={"region":"EU","refund_limit":100}', callNo: 1 },
      { flag: '--live-tool', value: 'search', callNo: null },
    ]);
    // Once stored, the stored list is the answer: an override read from a file is named by the file.
    store.updateRunMeta(over.runId, { interventions: [{ kind: 'override', at: 1, flag: '--override 1=@policy.json', args: ['--override', '1={"region":"EU","refund_limit":100}'] }] });
    expect(runInterventions(store, store.getRun(over.runId)!, overCalls)).toEqual([{ flag: '--override', value: '1=@policy.json', callNo: 1 }]);
    // An override given inline shows the result the call recorded.
    store.updateRunMeta(over.runId, { interventions: [{ kind: 'override', at: 1, flag: '--override 1=…', args: ['--override', '1={"region":"EU","refund_limit":100}'] }] });
    expect(runInterventions(store, store.getRun(over.runId)!, overCalls)).toEqual([{ flag: '--override', value: '1={"region":"EU","refund_limit":100}', callNo: 1 }]);
    expect(runInterventions(store, store.getRun(over.runId)!, [])).toEqual([{ flag: '--override', value: '1=…', callNo: 1 }]);
    // A recording has none.
    expect(inferInterventions(store, store.getRun(rec.runId)!, store.getCalls(rec.runId))).toEqual([]);
    store.close();
  });

  it('masks what a copy keeps of them, and of the hosts, with the redaction rules', () => {
    const rules = [
      { pattern: 'email', replace: '<EMAIL>' },
      { pattern: '/\\d{3}-\\d{2}-\\d{4}/', replace: '<SSN>' },
      { pattern: '/[a-z-]+\\.corp\\.internal/', replace: '<HOST>' },
    ];
    const meta: RunMeta = {
      labels: ['jane.doe@corp.example'],
      interventions: [
        { kind: 'inject', at: 15, flag: '--inject 15=Write to jane.doe@corp.example', args: ['--inject', '15=Write to jane.doe@corp.example', '--inject-as', 'user'] },
        { kind: 'set', at: 15, flag: '--set 15:metadata={"ssn":"078-05-1120"}', args: ['--set', '15:metadata={"ssn":"078-05-1120"}'] },
        { kind: 'writes', at: null, flag: '--writes stub', args: ['--writes', 'stub'] },
        // As someone else's pack may hold it: a value kept apart from its flag.
        { flag: '--override', value: '9={"email":"victim.person@corp.example"}', callNo: 9 } as unknown as RunIntervention,
      ],
      notRecorded: { hosts: [{ target: 'payroll-db.corp.internal:5432', count: 1, action: 'warned' }], tools: ['send_slack'] },
    };
    // This module masks the hosts; the flags are masked with the rest of the run's record.
    const facts = redactRunFacts(meta, rules);
    expect(facts.notRecorded).toEqual({ hosts: [{ target: '<HOST>:5432', count: 1, action: 'warned' }], tools: ['send_slack'] });
    expect(facts.interventions).toBe(meta.interventions);
    expect(redactRunFacts(meta, [])).toBe(meta);
    // Malformed metadata passes through for the read side to check.
    const odd = { interventions: 'x', notRecorded: { hosts: 'y' } } as unknown as RunMeta;
    expect(redactRunFacts(odd, rules)).toEqual(odd);

    // A copy keeps each flag's short form, masked, and nothing else a flag carried.
    const src = Store.open(':memory:');
    const b = RunBuilder.start(src, { meta });
    b.model({ messages: [user('x')] }, [text('y')]);
    b.end();
    const dst = Store.open(':memory:');
    const copy = redactRun(src, b.runId, rules, dst).meta!;
    expect(copy.interventions).toEqual([
      { kind: 'inject', at: 15, flag: '--inject 15=Write to <EMAIL>' },
      { kind: 'set', at: 15, flag: '--set 15:metadata={"ssn":"<SSN>"}' },
      { kind: 'writes', at: null, flag: '--writes stub' },
      { flag: '--override' },
    ]);
    expect(copy.notRecorded!.hosts[0].target).toBe('<HOST>:5432');
    for (const secret of ['jane.doe', '078-05-1120', 'victim.person', 'payroll-db']) expect(JSON.stringify(dst.getRun(b.runId)!.meta?.interventions), secret).not.toContain(secret);
    // Labels are the person's own words, not a flag's to mask.
    expect(copy.labels).toEqual(['jane.doe@corp.example']);
    // A copy of a run whose record is no list doesn't fail.
    const oddRun = RunBuilder.start(src, { meta: odd });
    oddRun.end();
    expect(() => redactRun(src, oddRun.runId, rules, Store.open(':memory:'))).not.toThrow();
    src.close();
    dst.close();
  });
});

describe('a redacted copy of a fork', () => {
  it('masks the values its divergence kept, with patterns and with path rules', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('x')] }, [text('y')]);
    b.end();
    store.setDivergence(b.runId, {
      type: 'request_changed',
      callNo: 4,
      kind: 'api',
      name: 'POST /v1/messages',
      replayedBefore: 3,
      diff: [
        { path: '$.messages[2].content[0].content', op: 'changed', before: '{"status":"ok"}', after: '{"contact":"victim.person@corp.example"}' },
        { path: '$.messages[2].content[1]', op: 'added', after: { type: 'text', text: 'Write to jane.doe@corp.example' } },
        { path: '$.metadata', op: 'added', after: { user_id: 'u-77', plan: 'gold' } },
        { path: '$.temperature', op: 'changed', before: 0, after: 1 },
      ],
      reason: 'the request changed at jane.doe@corp.example',
    });
    const rules = [
      { pattern: 'email', replace: '<EMAIL>' },
      { path: '$.metadata.user_id', replace: '<USER>' },
    ];
    const dst = Store.open(':memory:');
    const copy = redactRun(store, b.runId, rules, dst);
    expect(copy.divergence!.diff).toEqual([
      { path: '$.messages[2].content[0].content', op: 'changed', before: '{"status":"ok"}', after: '{"contact":"<EMAIL>"}' },
      { path: '$.messages[2].content[1]', op: 'added', after: { type: 'text', text: 'Write to <EMAIL>' } },
      { path: '$.metadata', op: 'added', after: { user_id: '<USER>', plan: 'gold' } },
      { path: '$.temperature', op: 'changed', before: 0, after: 1 },
    ]);
    expect(copy.divergence!.reason).toBe('the request changed at <EMAIL>');
    expect(dst.getRun(b.runId)!.divergence).toEqual(copy.divergence);
    // The source is never touched.
    expect(JSON.stringify(store.getRun(b.runId)!.divergence)).toContain('jane.doe@corp.example');
    store.close();
    dst.close();
  });
});

describe('a tool’s result in a line', () => {
  const store = Store.open(':memory:');
  const b = RunBuilder.start(store);
  const ok = b.tool('lookup_order', { id: 1 }, { order_id: 'A-1042', amount: 240, currency: 'USD', status: 'delivered', delivered: '2026-09-27', note: 'left at the door' });
  const stub = b.tool('send_email', { to: 'x' }, { stubbed: true }, { origin: 'stubbed', effect: 'write' });
  const blocked = b.tool('issue_refund', { amount: 240 }, null, { origin: 'blocked', effect: 'write' });
  const failed = b.tool('search', { q: 'x' }, null, { error: 'timeout after 30s' });
  const http = b.tool('GET api.example.com/v1/orders', { url: 'https://api.example.com/v1/orders' }, { status: 200, headers: {}, body: { orders: [1, 2] }, encoding: 'json' }, { meta: { http: 'api.example.com' } });
  b.model({ messages: [user('x')] }, [toolUse('t', {}, 'toolu_1')]);
  b.end();
  const calls = store.getCalls(b.runId);
  const line = (n: number) => {
    const c = calls.find((x) => x.callNo === n)!;
    return toolResultLine(c, c.end?.responseRef ? store.getJson(c.end.responseRef) : null);
  };

  it('shortens to about 72 characters, and says what happened to a fenced write', () => {
    expect(line(ok)).toBe('{"order_id":"A-1042","amount":240,"currency":"USD","status":"delivered"…');
    expect(line(ok)!.length).toBe(72);
    expect(line(stub)).toBe('stubbed {"stubbed":true}');
    expect(line(blocked)).toBe('blocked');
    expect(line(failed)).toBe('error: timeout after 30s');
    expect(line(http)).toBe('HTTP 200 {"orders":[1,2]}');
    expect(line(6)).toBeNull();
  });

  it('is null for a tool still running', () => {
    const running = { ...(calls.find((c) => c.callNo === ok) as CallRecord), end: null };
    expect(toolResultLine(running, null)).toBeNull();
  });
});

describe('what a run did unrecorded', () => {
  it('keeps the guard’s hosts and the tools without an effect the run never recorded', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.tool('search_web', { q: 'x' }, []);
    b.end();
    const tools = unrecordedProjectTools(
      [
        { name: 'search_web', effect: null },
        { name: 'send_slack', effect: null },
        { name: 'send_slack', effect: null },
        { name: 'issue_refund', effect: 'write' },
        { name: 'fetch_weather', effect: null },
      ],
      store.getCalls(b.runId),
    );
    expect(tools).toEqual(['fetch_weather', 'send_slack']);
    recordNotRecorded(store, b.runId, { hosts: [{ target: 'api.stripe.com:443', count: 2, action: 'warned' }] });
    recordNotRecorded(store, b.runId, { tools });
    expect(store.getRun(b.runId)!.meta?.notRecorded).toEqual({ hosts: [{ target: 'api.stripe.com:443', count: 2, action: 'warned' }], tools: ['fetch_weather', 'send_slack'] });
    // Nothing to say leaves the run as it was.
    const clean = RunBuilder.start(store).end();
    recordNotRecorded(store, clean, { hosts: [], tools: [] });
    expect(store.getRun(clean)!.meta?.notRecorded).toBeUndefined();
    store.close();
  });
});

describe('show --json', () => {
  it('is the run, its summary and its calls as stored, its untrusted reads, and the tools it left unrecorded', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('x')] }, [text('y')]);
    b.end();
    const run = store.getRun(b.runId)!;
    const out = showJson(store, run);
    expect(Object.keys(out)).toEqual(['run', 'summary', 'calls', 'untrusted', 'unrecordedTools']);
    expect(out.calls).toEqual(store.getCalls(b.runId));
    expect(out.summary).toEqual(summarizeRun(run, store.getCalls(b.runId), [], [], {}));
    expect(out.untrusted).toEqual([]);
    expect(out.unrecordedTools).toEqual([]);
    store.close();
  });

  it('lists the untrusted reads as shadowlap injection finds them, the config marking a tool either way', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.tool('fetch_page', { url: 'https://example.com' }, 'a page', { meta: { trust: 'untrusted', trustFrom: 'sdk' } });
    b.tool('web_search', { q: 'x' }, ['r'], { meta: { mcp: { transport: 'stdio', server: 'search' }, trust: 'untrusted', trustFrom: 'mcp' } });
    b.tool('read_inbox', {}, [], {});
    b.tool('send_email', { to: 'team@example.com' }, 'sent', { effect: 'write', meta: { trust: 'untrusted', trustFrom: 'sdk' } });
    b.end();
    const run = store.getRun(b.runId)!;
    // A write is no place to plant, and a read nothing marks is trusted. No model call follows these reads, so none reads them.
    expect(showJson(store, run).untrusted).toEqual([
      { callNo: 1, name: 'fetch_page', from: 'sdk', readAt: null },
      { callNo: 2, name: 'web_search', from: 'mcp', readAt: null },
    ]);
    expect(showJson(store, run, { tools: { read_inbox: { trust: 'untrusted' }, web_search: { trust: 'trusted' } } }).untrusted).toEqual([
      { callNo: 1, name: 'fetch_page', from: 'sdk', readAt: null },
      { callNo: 3, name: 'read_inbox', from: 'config', readAt: null },
    ]);
    store.close();
  });
});
