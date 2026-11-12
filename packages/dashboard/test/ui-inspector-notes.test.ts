import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { failedWhy } from '../ui/run/calls.js';
import { CallNote, Inspector, type InspectorTab } from '../ui/run/Inspector.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { CallDetail } from '../ui/types.js';
import type { PresetAttempt } from '../ui/run/preset.js';

/**
 * The inspector's words for a call that went wrong, as the mock writes them: a note over the
 * conversation with its verdict on a line of its own (Never sent., Refused., Failed.) and then why;
 * a tool call's arguments and result, and what a blocked or fenced one got instead; and Details'
 * rows saying who answered a failed model call and that one never sent cost nothing.
 */

type Call = CallDetail['call'];

const LIVE: Call = { callNo: 19, kind: 'api', name: 'POST /v1/messages', origin: 'live', effect: null, outcome: 'error', status: 529, model: 'claude-opus-5', stopReason: null, latencyMs: 420, ttftMs: null, usage: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.004, bytes: null, attempts: 0, replayedFrom: null, error: 'Overloaded', scope: null, fingerprint: 'fp', occurrence: 1, startedAt: 0, endedAt: 420, implHash: null, headers: {}, provider: null } as unknown as Call;
const INJECTED: Call = { ...LIVE, origin: 'injected', attempts: 2, error: null };
const REFUSED: Call = { ...LIVE, status: 503, error: 'The replay is offline and this request is not in the recording' };

const text = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'");
const note = (c: Call, flag: string | null = null) => renderToStaticMarkup(createElement(CallNote, { c, flag }));

const APP = { client: {}, exported: true, actionsOff: null, toast: () => undefined, guard: (fn: () => void) => fn() } as unknown as AppState;
function tab(c: Call, which: InspectorTab, more: Partial<CallDetail> = {}, flag: string | null = null, preset: PresetAttempt | null = null): string {
  const detail = { call: c, conversation: null, request: null, response: null, result: null, notes: [], actions: [], ...more } as unknown as CallDetail;
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: APP }, createElement(Inspector, { runId: 'R', call: c, calls: [c], detail, error: null, tab: which, onTab: () => undefined, onStep: () => undefined, change: null, live: false, flag, preset })));
}

describe('a failed call’s note', () => {
  it('says Failed. on a line of its own, then the provider’s status and error', () => {
    const html = note(LIVE);
    expect(html).toContain('<div class="inote err"><b>Failed.</b>');
    expect(text(html)).toBe('Failed. The provider answered HTTP 529: Overloaded. This is the conversation the agent sent.');
  });

  it('names the status once when the error repeats it, and says what it can without one', () => {
    expect(failedWhy({ status: 529, error: 'HTTP 529: Overloaded.' })).toBe('The provider answered HTTP 529: Overloaded.');
    expect(failedWhy({ status: 529, error: 'HTTP 529' })).toBe('The provider answered HTTP 529.');
    expect(failedWhy({ status: 500, error: null })).toBe('The provider answered HTTP 500.');
    expect(failedWhy({ status: null, error: 'socket hang up' })).toBe('socket hang up.');
    expect(failedWhy({ status: null, error: null })).toBe('The call ended in an error.');
  });

  it('says Never sent. for --fail-at, with its flag and attempts, and Refused. for an offline replay', () => {
    expect(note(INJECTED, '--fail-at 19=529')).toBe('<div class="inote inj"><b>Never sent.</b> Shadowlap answered with HTTP 529 (<code>--fail-at 19=529</code>), 3 attempts. This is the conversation the agent would have sent.</div>');
    expect(text(note(REFUSED))).toBe('Refused. The replay is offline and this request is not in the recording, so it got HTTP 503. This is what the agent sent.');
  });

  it('draws nothing over a call that answered', () => {
    expect(note({ ...LIVE, outcome: 'ok', status: 200, error: null })).toBe('');
  });

  it('heads the conversation with it, with nothing about a conversation a tool call doesn’t have', () => {
    expect(tab(LIVE, 'conversation')).toContain('<b>Failed.</b>');
    const conversation = { turns: [], fromCallNo: 19, n: null };
    expect(text(tab(LIVE, 'conversation', { conversation } as unknown as Partial<CallDetail>))).toContain('DetailsFailed. The provider answered HTTP 529: Overloaded. This is the conversation the agent sent.0 messages · what the model would have seen at #19');
    const tool = { ...LIVE, kind: 'tool', name: 'refund', outcome: 'ok', status: null, error: null } as Call;
    const html = tab(tool, 'conversation', { request: { args: { amount: 40 } }, result: { result: { ok: true } } });
    expect(html).toContain('<div class="ibar">Its arguments, then its result:</div>');
  });
});

describe('a tool call’s response, as the fork changed it', () => {
  const tool = { ...LIVE, kind: 'tool', name: 'refund', status: null, error: null } as Call;
  it('says what a blocked write and a blocked read got instead, in one sentence each', () => {
    expect(tab({ ...tool, origin: 'blocked', effect: 'write' }, 'response')).toContain('Blocked: a write tool after the fork, so the agent got this instead of the real result:');
    expect(tab({ ...tool, origin: 'blocked', effect: 'read' }, 'response')).toContain('Blocked: a read the recording doesn’t hold, after the fork, so the agent got this instead of a live result:');
    expect(tab({ ...tool, origin: 'stubbed', effect: 'write' }, 'response')).toContain('Stubbed: a write tool after the fork answered with a stand-in:');
  });

  it('says who wrote a failed model call’s HTTP answer', () => {
    const response = { kind: 'json', raw: '{"error":{"message":"Overloaded"}}' } as unknown as CallDetail['response'];
    expect(text(tab(LIVE, 'response', { response }))).toContain('HTTP 529 · from the provider');
    expect(text(tab(INJECTED, 'response', { response }))).toContain('HTTP 529 · written by Shadowlap, nothing sent');
    expect(text(tab(REFUSED, 'response', { response }))).toContain('HTTP 503 · refused offline');
  });
});

describe('a failed model call’s details', () => {
  it('says who answered, that its input was only in the request, and that one never sent cost nothing', () => {
    const live = tab(LIVE, 'details');
    expect(live).toContain('<dt>Outcome</dt><dd>error · HTTP 529<small> from the provider</small></dd>');
    expect(live).toContain('<dt>Input tokens</dt><dd>1,200 <small>in the request</small></dd>');
    expect(live).toMatch(/<dt>Cost<\/dt><dd>≈/);
    expect(live).toMatch(/<dt>Latency<\/dt><dd>[^<]+<small> answered by the provider<\/small><\/dd>/);
    const injected = tab(INJECTED, 'details');
    expect(injected).toContain('<dt>Outcome</dt><dd>error · HTTP 529<small> by --fail-at, never sent</small></dd>');
    expect(injected).toContain('<dt>Input tokens</dt><dd>1,200 <small>in the request; nothing was sent</small></dd>');
    expect(injected).toContain('<dt>Cost</dt><dd>$0</dd>');
    expect(injected).toMatch(/<small> answered by Shadowlap<\/small>/);
    expect(tab(REFUSED, 'details')).toMatch(/<small> refused offline<\/small>[\s\S]*<dt>Cost<\/dt><dd>\$0<\/dd>[\s\S]*<small> refused by the replay<\/small>/);
  });

  it('names the flag that overrode a call, and keeps an answered call’s split of its input', () => {
    const over = { ...LIVE, origin: 'overridden', outcome: 'ok', status: 200, error: null } as Call;
    const html = tab(over, 'details', {}, '--override 16=@policy.json');
    expect(html).toContain('<dt>Origin</dt><dd>overridden <small>--override 16=@policy.json</small></dd>');
    expect(html).toContain('<small>0 cache read · 0 cache creation · 1,200 uncached</small>');
    expect(html).not.toContain('answered by');
  });
});

describe('a preset’s attempt, at the call its preset played in at', () => {
  const at = (callNo: number, label: string): PresetAttempt => ({ label, golden: null, callNo, target: null, verdict: 'failed', attempt: 1, of: 3, played: null, outcome: 'the agent exited with code 1', exitCode: 1 });
  const TIMEOUT: Call = { ...LIVE, callNo: 4, kind: 'tool', name: 'get_ticket', origin: 'injected', status: null, model: null };

  it('names the preset in place of --fail-at: its note, its Response tab’s head and its details', () => {
    expect(text(tab(INJECTED, 'conversation', {}, '--fail-at 19=429', at(19, 'provider 429')))).toContain('Never sent. The provider 429 preset answered with HTTP 529, 3 attempts. This is the conversation the agent would have sent.');
    expect(tab(INJECTED, 'details', {}, null, at(19, 'provider 429'))).toContain('<dt>Outcome</dt><dd>error · HTTP 529<small> by the provider 429 preset, never sent</small></dd>');
    const result = { error: { name: 'TimeoutError', message: 'get_ticket timed out' } };
    expect(text(tab(TIMEOUT, 'response', { result }, null, at(4, 'tool timeout')))).toContain('Played in by the tool timeout preset: get_ticket didn’t run, and the agent got this error:');
    expect(text(tab({ ...TIMEOUT, outcome: 'ok' }, 'response', { result: { result: [] } }, null, at(4, 'empty result')))).toContain('Played in by the empty result preset, in place of the recorded result:');
    const details = tab(TIMEOUT, 'details', { result }, null, at(4, 'tool timeout'));
    expect(details).toContain('injected <small>by the tool timeout preset</small>');
    expect(details).toContain('<small> by the tool timeout preset; the tool didn’t run</small>');
    // Any other call of the attempt keeps the inspector's own words.
    expect(text(tab(INJECTED, 'conversation', {}, '--fail-at 19=429', at(4, 'tool timeout')))).toContain('Shadowlap answered with HTTP 529');
  });
});
