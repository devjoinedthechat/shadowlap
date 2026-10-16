import { describe, expect, it } from 'vitest';
import { changeCards, codeNote, comparingLive, pickable, prefixLine, samePlaces, shortSha } from '../ui/compare/model.js';
import type { CallRow, CompareView } from '../ui/types.js';

// Compare's logic without a browser: what the four change cards say, which rows after the fork the
// other run made too, the prefix line, and which runs the pickers offer.

const changes = (o: Partial<CompareView['changes']> = {}): CompareView['changes'] => ({
  systemPrompt: false,
  systems: { a: ['3f9e0c1d2b7a8e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7a21'], b: ['3f9e0c1d2b7a8e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7a21'] },
  tools: { added: [], removed: [], redefined: false },
  models: { a: ['claude-sonnet-5'], b: ['claude-sonnet-5'] },
  code: { a: 'a7b3c2e', b: 'a7b3c2e' },
  ...o,
});

const card = (c: Pick<CompareView, 'changes' | 'code'>, key: string) => changeCards(c).find((x) => x.key === key)!;

describe('the change cards', () => {
  it('say unchanged as the mock does: the revision, the prompt by its hash, the declarations, the model', () => {
    const cards = changeCards({ changes: changes(), code: null });
    expect(cards.map((c) => [c.key, c.changed, c.title, c.note])).toEqual([
      ['code', false, 'unchanged', 'a7b3c2e'],
      ['system prompt', false, 'unchanged', 'sha 3f9e…a21'],
      ['tools', false, 'unchanged', 'same declarations'],
      ['model', false, 'unchanged', 'claude-sonnet-5'],
    ]);
    expect(card({ changes: changes(), code: null }, 'system prompt').tip).toContain('sha256 3f9e0c1d');
  });

  it('name the code change by its commit, or how many commits it took', () => {
    const changed = changes({ code: { a: 'a7b3c2e', b: 'c91d0f4' } });
    const one = card({ changes: changed, code: { commits: 1, newer: 'b', subjects: ['harness: pass refund_limit through'], uncommitted: false } }, 'code');
    expect([one.changed, one.title, one.note]).toEqual([true, 'a7b3c2e → c91d0f4', 'harness: pass refund_limit through']);
    expect(one.tip).toBe('harness: pass refund_limit through');
    const three = card({ changes: changed, code: { commits: 3, newer: 'b', subjects: ['Shorten the policy summary', 'b', 'c'], uncommitted: false } }, 'code');
    expect(three.note).toBe('3 commits · Shorten the policy summary');
    // Compared with an older run, the change is read backwards.
    expect(card({ changes: changed, code: { commits: 2, newer: 'a', subjects: ['x', 'y'], uncommitted: false } }, 'code').note).toBe('2 commits earlier');
    // Fewer subjects than commits: the hover says how many more.
    expect(codeNote({ commits: 14, newer: 'b', subjects: ['a', 'b'], uncommitted: false }).tip).toBe('a\nb\n… and 12 more');
  });

  it('say plainly when git could not tell, the branches parted, or only uncommitted changes differ', () => {
    const changed = changes({ code: { a: 'a7b3c2e', b: 'c91d0f4' } });
    expect(card({ changes: changed, code: null }, 'code').note).toBe('different revision');
    expect(card({ changes: changed }, 'code').note).toBe('different revision');
    expect(card({ changes: changed, code: { commits: null, newer: null, subjects: [], uncommitted: false } }, 'code').note).toBe('on separate branches');
    expect(card({ changes: changes({ code: { a: 'a7b3c2e', b: 'a7b3c2e+dirty' } }), code: { commits: 0, newer: null, subjects: [], uncommitted: true } }, 'code').note).toBe('uncommitted changes');
    expect(card({ changes: changes({ code: { a: null, b: null } }), code: null }, 'code').note).toBe('no revision recorded');
  });

  it('count the prompts of a multi-agent run, and say when there is none or the comparison is older', () => {
    expect(card({ changes: changes({ systems: { a: ['x', 'y'], b: ['x', 'y'] } }) }, 'system prompt').note).toBe('2 prompts, the same');
    expect(card({ changes: changes({ systems: { a: [], b: [] } }) }, 'system prompt').note).toBe('no system prompt');
    const { systems: _s, ...older } = changes();
    expect(card({ changes: older }, 'system prompt').note).toBe('same prompt');
    expect(card({ changes: changes({ systemPrompt: true }) }, 'system prompt')).toMatchObject({ changed: true, title: 'changed', note: 'different prompt', tip: null });
    expect(shortSha('abc')).toBe('sha abc');
  });

  it('list the tools added and removed, and the models either side', () => {
    expect(card({ changes: changes({ tools: { added: ['lookup'], removed: ['email'], redefined: true } }) }, 'tools')).toMatchObject({ changed: true, note: '+lookup −email' });
    expect(card({ changes: changes({ tools: { added: [], removed: [], redefined: true } }) }, 'tools').note).toBe('a definition changed');
    // Another agent's dozen tools: a few named, the rest counted, all of them on hover.
    const many = card({ changes: changes({ tools: { added: ['a', 'b', 'c', 'd', 'e'], removed: ['f'], redefined: false } }) }, 'tools');
    expect(many.note).toBe('+a +b +c · 3 more');
    expect(many.tip).toBe('+a +b +c +d +e −f');
    expect(card({ changes: changes({ models: { a: ['claude-sonnet-5'], b: ['claude-haiku-4-5'] } }) }, 'model')).toMatchObject({ changed: true, title: 'claude-sonnet-5 → claude-haiku-4-5', note: 'different model' });
    expect(card({ changes: changes({ models: { a: [], b: [] } }) }, 'model').note).toBe('no model call');
  });
});

describe('the prefix line', () => {
  const base = { identicalPrefix: 16, firstRequestDifference: { callNo: 17, kind: 'api' as const, name: 'POST /v1/messages' }, responseDifferences: [], onlyInA: 0, onlyInB: 0 };
  it('names the first request that differs, and the answers that changed before it', () => {
    expect(prefixLine(base)).toEqual({ lead: '#1–#16 identical.', rest: 'The first request that differs is #17.' });
    expect(prefixLine({ ...base, identicalPrefix: 15, responseDifferences: [{ callNo: 16, kind: 'tool', name: 'lookup_policy', detail: '1 difference' }] }).rest).toBe('The first request that differs is #17; before it, 1 call got a different answer to the same request.');
    expect(prefixLine({ ...base, identicalPrefix: 0 }).lead).toBe('No identical prefix.');
    expect(prefixLine({ ...base, firstRequestDifference: null }).rest).toBe('Every call matches.');
    expect(prefixLine({ ...base, firstRequestDifference: null, onlyInB: 3 }).rest).toBe('Every request they share matches.');
    expect(prefixLine({ ...base, firstRequestDifference: null, responseDifferences: [{ callNo: 4, kind: 'api', name: 'x', detail: '' }] }).rest).toBe('Every request matches; 1 call got a different answer.');
  });
});

describe('the paths after the fork', () => {
  const call = (callNo: number, kind: CallRow['kind'], name: string, detail = ''): Pick<CallRow, 'callNo' | 'kind' | 'name' | 'detail'> => ({ callNo, kind, name, detail });
  // The recording refunded at #18; the fork asked the tier-2 queue instead, then both looked the locale up and answered.
  const a = [call(17, 'api', 'POST /v1/messages'), call(18, 'tool', 'issue_refund', '{"amount":240}'), call(19, 'api', 'POST /v1/messages'), call(20, 'tool', 'lookup_locale', '{"customer":"C-1"}'), call(21, 'api', 'POST /v1/messages')];
  const b = [call(17, 'api', 'POST /v1/messages'), call(18, 'tool', 'queue_status', '{"team":"t2"}'), call(19, 'api', 'POST /v1/messages'), call(20, 'tool', 'lookup_locale', '{"customer":"C-1"}'), call(21, 'api', 'POST /v1/messages')];

  it('dims a model call only when it asked for the same tools, and a tool only with the same arguments', () => {
    expect(samePlaces(a, b, 17)).toEqual([false, false, true, true, true]);
    // A model call that asked for other tools is not the same place, whatever its name.
    const c = [...b.slice(0, 3), call(20, 'tool', 'escalate', '{}'), call(21, 'api', 'POST /v1/messages')];
    expect(samePlaces(a, c, 17)).toEqual([false, false, false, false, true]);
    // The call where the requests first differ never is.
    expect(samePlaces(a, a, 17)[0]).toBe(false);
    expect(samePlaces(a, a, null)).toEqual([true, true, true, true, true]);
    // A run that went on past the other's end.
    expect(samePlaces([...a, call(22, 'tool', 'send_email', '{}')], a, 17).at(-1)).toBe(false);
  });
});

describe('the pickers and live runs', () => {
  const runs = [
    { runId: '01K5CQ4N7G000000000000000A', startedAt: 1 },
    { runId: '01K5CQ4P2R000000000000000B', startedAt: 3 },
    { runId: '01K5CQ4R1T000000000000000C', startedAt: 2 },
  ];
  it('offers every run, newest first; in an exported copy of many runs, only the pairs it holds', () => {
    expect(pickable(runs, runs[0]!.runId, null).map((r) => r.startedAt)).toEqual([3, 2, 1]);
    // The other side is the run every pair includes: any run pairs with it.
    expect(pickable(runs, runs[0]!.runId, runs[0]!.runId)).toHaveLength(3);
    expect(pickable(runs, '01K5CQ4N7G', runs[0]!.runId)).toHaveLength(3);
    // Otherwise only that run.
    expect(pickable(runs, runs[1]!.runId, runs[0]!.runId).map((r) => r.runId)).toEqual([runs[0]!.runId]);
  });

  it('reads the comparison again while either run records, by full or short id', () => {
    expect(comparingLive([{ runId: '01K5CQ6L0P000000000000000Z' }], '01K5CQ6L0P', '01K5CQ4N7G')).toBe(true);
    expect(comparingLive([{ runId: '01K5CQ6L0P000000000000000Z' }], '01K5CQ4N7G', '01K5CQ6L0P000000000000000Z')).toBe(true);
    expect(comparingLive([], 'a', 'b')).toBe(false);
  });
});
