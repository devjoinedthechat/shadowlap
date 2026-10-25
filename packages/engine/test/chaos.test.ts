import { describe, expect, it } from 'vitest';
import { CHAOS_PRESETS, chaosTargets, cutJson, parsePresets, presetReplay, presetResult, refused, resultShape, Store, type CallRecord } from '../src/index.js';
import { RunBuilder, text, toolUse, user } from './run-fixtures.js';

/** The error-path presets: where each hits a recording, and what it answers there. */

function calls(build: (b: RunBuilder) => void): CallRecord[] {
  const store = Store.open(':memory:');
  const b = RunBuilder.start(store);
  build(b);
  const out = store.getCalls(b.end());
  store.close();
  return out;
}

describe('where the presets hit', () => {
  it('the first tool call that reads the world, and the model call after it', () => {
    const c = calls((b) => {
      b.model({ messages: [user('go')] }, [toolUse('get_units', {}, 'a')]);
      b.tool('get_units', {}, { units: 'c' }, { effect: 'pure' });
      b.tool('ask_user', {}, { text: 'yes' }, { meta: { input: true } });
      b.tool('lookup_order', {}, null, { error: 'not found' });
      b.tool('lookup_order', { id: 2 }, { amount: 40 });
      b.model({ messages: [user('go')] }, [text('done')]);
    });
    expect(chaosTargets(c)).toEqual({ tool: { callNo: 5, name: 'lookup_order' }, model: { callNo: 6, name: 'POST /v1/messages' } });
  });

  it('a tool of no declared effect before a write, a named tool before either, and says when there is none', () => {
    const c = calls((b) => {
      b.model({ messages: [user('go')] }, [text('x')]);
      b.tool('issue_refund', {}, { ok: true }, { effect: 'write' });
      b.tool('crm', {}, { ok: true }, { meta: {} });
    });
    // RunBuilder's default effect is read; null is what an import leaves.
    const unknown = c.map((x) => (x.name === 'crm' ? { ...x, effect: null } : x));
    expect(chaosTargets(unknown).tool).toEqual({ callNo: 3, name: 'crm' });
    expect(chaosTargets(unknown, { tool: 'issue_refund' }).tool).toEqual({ callNo: 2, name: 'issue_refund' });
    expect(chaosTargets(unknown, { tool: 'nothing' })).toEqual({ tool: { none: 'the recording never calls nothing' }, model: { callNo: 1, name: 'POST /v1/messages' } });
    const pure = calls((b) => {
      b.model({ messages: [user('go')] }, [text('x')]);
      b.tool('calc', {}, 1, { effect: 'pure' });
    });
    expect(chaosTargets(pure).tool).toEqual({ none: 'the recording calls no tool that reads the world (only pure tools, or ones that failed)' });
    expect(chaosTargets(calls(() => undefined))).toEqual({ tool: { none: 'the recording makes no tool call' }, model: { none: 'the recording makes no model call' } });
  });
});

describe('what a preset answers', () => {
  const order = { order_id: 'A-1', items: [{ sku: 'k1' }, { sku: 'k2' }], note: 'leave at the door' };

  it('empty: nothing, of the kind it recorded', () => {
    expect(presetResult('empty', order, 'value')).toEqual({ result: {} });
    expect(presetResult('empty', [1, 2], 'value')).toEqual({ result: [] });
    expect(presetResult('empty', 'some text', 'value')).toEqual({ result: '' });
    expect(presetResult('empty', 42, 'value')).toEqual({ result: null });
    expect(presetResult('empty', { status: 200, headers: { 'content-type': 'application/json' }, body: [1], encoding: 'json' }, 'http')).toEqual({ result: { status: 200, headers: { 'content-type': 'application/json' }, body: [], encoding: 'json' } });
    expect(presetResult('empty', { status: 200, headers: {}, body: '<p>hi</p>', encoding: 'text' }, 'http')).toEqual({ result: { status: 200, headers: {}, body: '', encoding: 'text' } });
    expect(presetResult('empty', { content: [{ type: 'text', text: '{}' }], isError: false }, 'mcp')).toEqual({ result: { content: [], isError: false } });
  });

  it('empty: refused on a tool that already answered with nothing, which it would leave as it was', () => {
    for (const nothing of [[], {}, '', null]) expect(presetResult('empty', nothing, 'value')).toEqual({ refused: 'it already answered with nothing' });
    expect(presetResult('empty', { status: 200, headers: {}, body: [], encoding: 'json' }, 'http')).toEqual({ refused: 'it already answered with nothing' });
    expect(presetResult('empty', { status: 204, headers: {}, body: '', encoding: 'text' }, 'http')).toEqual({ refused: 'it already answered with nothing' });
    expect(presetResult('empty', { content: [] }, 'mcp')).toEqual({ refused: 'it already answered with nothing' });
    // Something, however small, is still changed.
    expect(presetResult('empty', [0], 'value')).toEqual({ result: [] });
    expect(presetResult('empty', 0, 'value')).toEqual({ result: null });
  });

  it('malformed: the JSON cut short, which never parses', () => {
    const cut = presetResult('malformed', order, 'value');
    expect(refused(cut)).toBe(false);
    const text = (cut as { result: string }).result;
    expect(typeof text).toBe('string');
    expect(JSON.stringify(order).startsWith(text)).toBe(true);
    expect(() => JSON.parse(text)).toThrow();
    for (const v of ['{"a":1}', '[1,2,3]', '12345', 'true', 'null', '"text"', '{}', '1']) expect(() => JSON.parse(cutJson(v)), v).toThrow();
    // Text that isn't JSON has no JSON to break.
    expect(presetResult('malformed', 'plain words', 'value')).toEqual({ refused: 'it returned text, not JSON' });
    const http = presetResult('malformed', { status: 200, headers: { 'content-type': 'application/json' }, body: order, encoding: 'json' }, 'http') as { result: { body: string; encoding: string } };
    expect(http.result.encoding).toBe('text');
    expect(() => JSON.parse(http.result.body)).toThrow();
    expect(presetResult('malformed', { status: 200, headers: {}, body: '<p>x</p>', encoding: 'text' }, 'http')).toEqual({ refused: 'its recorded response is text, not JSON' });
    expect(presetResult('malformed', { status: 200, headers: {}, body: 'AAAA', encoding: 'base64' }, 'http')).toEqual({ refused: 'its recorded response is binary' });
    const mcp = presetResult('malformed', { content: [{ type: 'text', text: JSON.stringify(order) }] }, 'mcp') as { result: { content: Array<{ text: string }> } };
    expect(() => JSON.parse(mcp.result.content[0].text)).toThrow();
  });

  it('oversized: its longest text repeated, JSON kept JSON', () => {
    const grown = presetResult('oversized', order, 'value', { oversize: 5_000 }) as { result: typeof order };
    expect(JSON.stringify(grown.result).length).toBeGreaterThanOrEqual(5_000);
    expect(grown.result.order_id).toBe('A-1');
    expect(grown.result.note.startsWith('leave at the door\nleave at the door')).toBe(true);
    // A JSON string stays parseable, and grows inside.
    const json = presetResult('oversized', JSON.stringify(order), 'value', { oversize: 5_000 }) as { result: string };
    expect(JSON.parse(json.result).order_id).toBe('A-1');
    expect(json.result.length).toBeGreaterThanOrEqual(5_000);
    // Only a list to grow: its items, repeated.
    const list = presetResult('oversized', { ids: [1, 2, 3] }, 'value', { oversize: 1_000 }) as { result: { ids: number[] } };
    expect(list.result.ids.length).toBeGreaterThan(300);
    expect(presetResult('oversized', { amount: 240 }, 'value')).toEqual({ refused: 'its recorded result has no text or list to grow' });
    const http = presetResult('oversized', { status: 200, headers: {}, body: 'page', encoding: 'text' }, 'http', { oversize: 2_000 }) as { result: { body: string } };
    expect(http.result.body.length).toBeGreaterThanOrEqual(2_000);
  });

  it('knows a result\'s shape from its call, and plays each preset in as the replay takes it', () => {
    expect(resultShape({ meta: { http: 'api.example.com' } })).toBe('http');
    expect(resultShape({ meta: { mcp: { transport: 'stdio', server: 'kb' } } })).toBe('mcp');
    expect(resultShape({ meta: {} })).toBe('value');
    expect(presetReplay('timeout', { callNo: 4 })).toEqual({ toolFailures: new Map([[4, { kind: 'timeout' }]]) });
    expect(presetReplay('429', { callNo: 5 })).toEqual({ failAt: new Map([[5, 429]]) });
    expect(presetReplay('500', { callNo: 5 })).toEqual({ failAt: new Map([[5, 500]]) });
    expect(presetReplay('empty', { callNo: 4 }, { result: {} })).toEqual({ overrides: new Map([[4, {}]]) });
  });

  it('reads the presets asked for, in their own order', () => {
    expect(parsePresets('429, timeout')).toEqual(['timeout', '429']);
    expect(parsePresets('all')).toEqual([...CHAOS_PRESETS]);
    expect(() => parsePresets('flood,timeout')).toThrow('unknown preset "flood"');
    expect(() => parsePresets(' ')).toThrow('name at least one preset');
  });
});
