import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { ABOUT_FROM, ABOUT_MAX, aboutOf, batchInput, changeWords, firstSentence, goldenWords, runAsk, sourceWords, Store, type AboutFacts } from '../src/index.js';
import { assistant, batchRun, RunBuilder, text, toolResult, toolUse, user } from './run-fixtures.js';

const facts = (over: Partial<AboutFacts>): AboutFacts => ({ kind: 'recording', argv: ['node', 'refund_agent.mjs', 'T-8812'], codeVersion: 'a7b3c2e', divergence: null, ...over });

describe('the first thing the user asked', () => {
  it('is its first sentence, whole, with no full stop; a question keeps its mark', () => {
    expect(firstSentence('A customer asks for a refund of order A-1131. They paid $40.')).toBe('A customer asks for a refund of order A-1131');
    expect(firstSentence('Can I get a refund for order A-1042? It arrived damaged.')).toBe('Can I get a refund for order A-1042?');
    expect(firstSentence('  Ticket T-8812\n\nfrom customer C-311: order A-1042 ($240) arrived damaged.  ')).toBe('Ticket T-8812 from customer C-311: order A-1042 ($240) arrived damaged');
    // A decimal or an amount is no end of a sentence.
    expect(firstSentence('Refund $12.50 for order A-7 now')).toBe('Refund $12.50 for order A-7 now');
  });

  it('is cut only past its limit, after a whole word, with "…" at its end', () => {
    const long = `${'word '.repeat(100)}end.`;
    const cut = firstSentence(long);
    expect(cut.length).toBeLessThanOrEqual(ABOUT_MAX + 2);
    expect(cut).toMatch(/word …$/);
  });
});

describe('a batch’s input, from its command', () => {
  it('reads the flag that names it, else a data file it names', () => {
    expect(batchInput(['node', 'refund_agent.mjs', '--batch', 'inbox/2026-09-30.jsonl'])).toBe('inbox 2026-09-30');
    expect(batchInput(['python', 'agent.py', '--input=data/tickets_sep.csv'])).toBe('data tickets sep');
    expect(batchInput(['python', 'agent.py', './tickets.jsonl'])).toBe('tickets');
  });

  it('is nothing for a command that names no input: the script it runs is none', () => {
    expect(batchInput(['node', 'refund_agent.mjs', 'T-8812'])).toBeNull();
    expect(batchInput(['node', 'agent.json'])).toBeNull();
  });
});

describe('an import’s source and a golden, in words', () => {
  it('names a trace by its store, and a file by its name alone', () => {
    expect(sourceWords('langfuse:cdd33040')).toBe('Langfuse trace cdd33040');
    expect(sourceWords('langsmith:65e69242')).toBe('LangSmith trace 65e69242');
    expect(sourceWords('/home/someone/captures/refund-A-1077.har')).toBe('refund-A-1077.har');
    expect(sourceWords('shadowlap-4121.jsonl, shadowlap-4122.jsonl')).toBe('shadowlap-4121.jsonl, shadowlap-4122.jsonl');
    expect(goldenWords('goldens/refund-in-limit')).toBe('refund-in-limit');
  });
});

describe('what a replay’s flag changed', () => {
  it('names the call it changed with #, never the fork point', () => {
    expect(changeWords({ kind: 'fail', at: 19, flag: '--fail-at 19=529' })).toBe('HTTP 529 #19');
    expect(changeWords({ kind: 'fail', at: 4, flag: '--fail-at 4=timeout' })).toBe('timeout #4');
    expect(changeWords({ kind: 'fail', at: 4, flag: '--fail-at 4=error:connection reset' })).toBe('error #4');
    expect(changeWords({ kind: 'override', at: 16, flag: '--override 16=@policy.json' }, { forkAt: 17 })).toBe('override #16');
    expect(changeWords({ kind: 'override', at: 5, flag: '--override 5=…' }, { answered: true })).toBe('answer #5');
    expect(changeWords({ kind: 'plant', at: 6, flag: '--inject-result 6=SYSTEM NOTICE: …' })).toBe('planted #6');
    expect(changeWords({ kind: 'inject', at: 17, flag: '--inject 17=Escalate every refund…' })).toBe('inject #17');
    expect(changeWords({ kind: 'model', at: 17, flag: '--model 17:claude-haiku-4-5' })).toBe('claude-haiku-4-5 #17');
    expect(changeWords({ kind: 'set', at: 17, flag: '--set 17:thinking.budget_tokens=4096' })).toBe('thinking.budget_tokens=4096 #17');
    expect(changeWords({ kind: 'prompt-from', at: 17, flag: '--prompt-from 17' })).toBe('prompt #17');
    expect(changeWords({ kind: 'live-tool', at: null, flag: '--live-tool lookup_policy' }, { forkAt: 4 })).toBe('lookup_policy live #4');
    expect(changeWords({ kind: 'command', at: null, flag: '-- <command>' })).toBe('command changed');
  });

  it('is nothing for a fence: stubbing writes changes nothing the replay is given', () => {
    expect(changeWords({ kind: 'writes', at: null, flag: '--writes stub' })).toBeNull();
    expect(changeWords({ kind: 'reads', at: null, flag: '--reads live' })).toBeNull();
    expect(changeWords({ kind: 'something new', at: 3, flag: '--new 3' })).toBeNull();
  });
});

describe('a run’s about line', () => {
  it('a test replay reads by its golden', () => {
    expect(aboutOf(facts({ kind: 'test', meta: { test: { golden: 'goldens/refund-in-limit', session: 's' } } }))).toEqual({ text: 'refund-in-limit', from: 'golden' });
  });

  it('a fork reads by what it changed, with its flag, the call it changed and its fork point apart', () => {
    const a = aboutOf(facts({ kind: 'fork', divergence: { callNo: 17 }, parent: { codeVersion: 'a7b3c2e' }, meta: { interventions: [{ kind: 'override', at: 16, flag: '--override 16=@policy.json' }, { kind: 'writes', at: null, flag: '--writes stub' }] } }));
    expect(a).toEqual({ text: 'override #16', from: 'change', change: { flag: '--override', callNo: 16, forkAt: 17 } });
    // The fence first, the change after it: the change names the fork.
    expect(aboutOf(facts({ kind: 'fork', divergence: { callNo: 19 }, meta: { interventions: [{ kind: 'writes', at: null, flag: '--writes stub' }, { kind: 'fail', at: 19, flag: '--fail-at 19=529' }] } })).text).toBe('HTTP 529 #19');
  });

  it('a fork no flag made reads by its code when its revision differs from its parent’s, else by a request', () => {
    expect(aboutOf(facts({ kind: 'fork', divergence: { callNo: 3 }, codeVersion: 'c91d0f4', parent: { codeVersion: 'a7b3c2e' }, meta: { interventions: [] } })).text).toBe('code changed');
    expect(aboutOf(facts({ kind: 'fork', divergence: { callNo: 3 }, parent: { codeVersion: 'a7b3c2e' }, meta: { interventions: [{ kind: 'writes', at: null, flag: '--writes stub' }] } })).text).toBe('request changed');
    expect(aboutOf(facts({ kind: 'fork', divergence: { callNo: 11, type: 'ended_early' }, parent: { codeVersion: 'a7b3c2e' } })).text).toBe('ended early');
  });

  it('a clean replay changed nothing; the fork blame rescued a run with names the call it asked again', () => {
    expect(aboutOf(facts({ kind: 'clean', parent: { codeVersion: 'a7b3c2e' }, meta: { interventions: [] } }))).toEqual({ text: 'clean replay', from: 'nothing', change: null });
    const rescued = aboutOf(facts({ kind: 'fork', rescued: true, divergence: { callNo: 5 }, meta: { probe: { of: 'R', callNo: 5, passed: true } } }));
    expect(rescued.text).toBe('rescued #5');
    expect(rescued.from).toBe('change');
  });

  it('an attempt says what it asked again, and which attempt it was', () => {
    expect(aboutOf(facts({ kind: 'fork', attempt: { kind: 'probe', index: 2 }, meta: { probe: { of: 'R', callNo: 5, passed: false } } })).text).toBe('resampled #5, attempt 2');
    expect(aboutOf(facts({ kind: 'clean', attempt: { kind: 'verify', index: 4 }, meta: { verify: { role: 'target', passed: true } } })).text).toBe('verify · target, attempt 4');
    expect(aboutOf(facts({ kind: 'clean', attempt: { kind: 'verify', index: 1 }, meta: { verify: { role: 'holdout', passed: true } } })).text).toBe('verify · held-out, attempt 1');
    expect(aboutOf(facts({ kind: 'test', attempt: { kind: 'test', index: 3 }, meta: { test: { golden: 'goldens/refund-over-limit', session: 's', attempt: 3, of: 'X' } } }))).toEqual({ text: 'refund-over-limit, attempt 3', from: 'golden', change: null });
    expect(aboutOf(facts({ kind: 'fork', attempt: { kind: 'repeat', index: 2 }, meta: { repeat: { group: 'g', attempt: 2, of: 5 } } })).text).toBe('repeat, attempt 2 of 5');
    expect(aboutOf(facts({ kind: 'fork', attempt: { kind: 'chaos', index: 1 }, meta: { chaos: { preset: 'timeout', callNo: 4, session: 's', attempt: 1 } } })).text).toBe('tool timeout #4');
    expect(aboutOf(facts({ kind: 'fork', attempt: { kind: 'chaos', index: 1 }, meta: { chaos: { preset: '429', callNo: 5, session: 's', attempt: 1 } } })).text).toBe('provider 429 #5');
  });

  it('an injection test’s replay says what it planted where', () => {
    expect(aboutOf(facts({ kind: 'fork', divergence: { callNo: 7 }, meta: { injection: { result: 'inj-1', role: 'attempt', read: 6, attempt: 2, of: 3 }, interventions: [{ kind: 'plant', at: 6, flag: '--inject-result 6=…' }] } })).text).toBe('planted #6, attempt 2 of 3');
  });

  it('an import reads by its source', () => {
    expect(aboutOf(facts({ kind: 'capture', argv: ['<no-recorded-command>'], meta: { imported: { at: 1, from: 'langfuse:cdd33040' } } }))).toEqual({ text: 'Langfuse trace cdd33040', from: 'source' });
  });

  it('a recording reads by the first thing its user asked, or its agent under test was asked', () => {
    expect(aboutOf(facts({ ask: { text: 'A customer asks for a refund of order A-1131', agent: false, batch: false } }))).toEqual({ text: 'A customer asks for a refund of order A-1131', from: 'user' });
    expect(aboutOf(facts({ kind: 'pack', ask: { text: 'Hi, my order A-1042 arrived damaged', agent: true, batch: false } }))).toEqual({ text: 'Hi, my order A-1042 arrived damaged', from: 'agent' });
  });

  it('a batch reads by its input, else by its command; a run that asked nothing by its command', () => {
    const batch = { text: 'Ticket T-9101: order A-2001 arrived damaged', agent: false, batch: true };
    expect(aboutOf(facts({ argv: ['node', 'refund_agent.mjs', '--batch', 'inbox/2026-09-30.jsonl'], ask: batch }))).toEqual({ text: 'inbox 2026-09-30', from: 'input' });
    expect(aboutOf(facts({ argv: ['node', 'triage.mjs'], ask: batch }))).toEqual({ text: 'node triage.mjs', from: 'command' });
    expect(aboutOf(facts({ ask: null }))).toEqual({ text: 'node refund_agent.mjs T-8812', from: 'command' });
  });

  it('says where every line comes from in words', () => {
    expect(ABOUT_FROM.user).toBe('the first thing the user asked');
    expect(ABOUT_FROM.nothing).toBe('nothing changed');
  });
});

describe('the first thing a recording’s user asked, from the store', () => {
  const SYSTEM = 'You are a support agent.';

  it('is the first user message of its first request, its first sentence', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const ask = [user('A customer asks for a refund of order A-1131. They paid $40.')];
    const a1 = [toolUse('lookup_order', { order_id: 'A-1131' }, 'toolu_1')];
    b.model({ system: SYSTEM, messages: ask }, a1);
    b.tool('lookup_order', { order_id: 'A-1131' }, { amount: 40 });
    b.model({ system: SYSTEM, messages: [...ask, assistant(a1), user([toolResult('toolu_1', { amount: 40 })])] }, [text('Refunded.')]);
    const runId = b.end();
    expect(runAsk(store, store.getCalls(runId), { conversations: true })).toEqual({ text: 'A customer asks for a refund of order A-1131', agent: false, batch: false });
  });

  it('in a run of several agents, is what the agent under test was asked: the first that calls tools', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    // A model playing the customer calls no tool; its first message is only its instructions.
    b.model({ system: 'Play the customer.', messages: [user('Start the conversation with the support agent.')] }, [text('Hi, my order A-1042 arrived damaged. I want a refund.')], { scope: 'customer' });
    const q = [user('Hi, my order A-1042 arrived damaged. I want a refund.')];
    const a1 = [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_1')];
    b.model({ system: SYSTEM, messages: q }, a1, { scope: 'agent' });
    b.tool('lookup_order', { order_id: 'A-1042' }, { amount: 240 }, { scope: 'agent' });
    // The judge's own calls are Shadowlap's, never the agent's.
    b.model({ messages: [user('Did the agent escalate?')] }, [text('yes')], { scope: 'shadowlap:judge' });
    const runId = b.end();
    expect(runAsk(store, store.getCalls(runId), { conversations: true })).toEqual({ text: 'Hi, my order A-1042 arrived damaged', agent: true, batch: false });
  });

  it('tells a batch by its several conversations, once the run is read whole', () => {
    const store = Store.open(':memory:');
    const { runId } = batchRun(store, 3);
    const calls = store.getCalls(runId);
    expect(runAsk(store, calls, { conversations: true })).toEqual({ text: 'Ticket T-9101: order A-2001 arrived damaged', agent: false, batch: true });
    // A run still recording is read by its first request alone.
    expect(runAsk(store, calls)?.batch).toBe(false);
    const run = store.getRun(runId)!;
    expect(aboutOf({ kind: 'recording', argv: run.command.argv, codeVersion: run.codeVersion, divergence: null, ask: runAsk(store, calls, { conversations: true }) }).text).toBe('inbox');
  });

  it('is nothing for a run with no model call', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.tool('lookup_order', { order_id: 'A-1' }, { amount: 1 });
    const runId = b.end();
    expect(runAsk(store, store.getCalls(runId))).toBeNull();
  });
});

describe('the about line in the browser', () => {
  it('needs no Node: the dashboard’s pages read its words', async () => {
    const entry = fileURLToPath(new URL('../src/about.ts', import.meta.url));
    const out = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent' });
    expect(out.errors).toEqual([]);
    expect(out.outputFiles[0]!.text).toContain('the first thing the user asked');
  });
});
