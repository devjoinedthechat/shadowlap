import { describe, expect, it } from 'vitest';
import { CUT, jsonDiff, splitRows, wordMarks, type JsonLine } from '../ui/json-diff.js';

/**
 * Show diff's walk (ui/json-diff.ts), on the design's own samples: a key a line in this run's order,
 * arrays by index, JSON inside a string walked as JSON, a changed value's differing words marked (a
 * UUID whole, its quotes not), context cut, a changed array's unchanged items folded, and each line's
 * path as the structural diff names it.
 */

/** A line as `<sign> <indent><key>: <value>`, its marked words in [brackets]. */
const said = (l: JsonLine) => `${l.sign} ${'  '.repeat(l.depth)}${l.key ?? ''}${l.key !== null && (l.value.length || l.json) ? ': ' : l.key !== null ? ':' : ''}${l.json ? 'JSON in a string' : ''}${l.value.map((p) => (p.marked ? `[${p.text}]` : p.text)).join('')}`;
const lines = (was: unknown, now: unknown) => jsonDiff(was, now).map(said);

const POLICY = { region: 'EU', approval: 'tier2' };
const FIXED = { region: 'EU', refund_limit: 100, approval: 'tier2' };
const UUID_A = '3f1c9a2e-5b7d-4e21-9c0a-8d6f2b1e7a43';
const UUID_B = 'b84e07d1-2c9f-4a63-8e15-6f0d3a9c2b78';

describe('the structural diff', () => {
  it('draws a key a line in this run’s order, a key only the recording had where it stood', () => {
    expect(lines(POLICY, FIXED)).toEqual(['  region: "EU"', '+ refund_limit: 100', '  approval: "tier2"']);
    expect(lines({ a: 1, b: 2, c: 3 }, { c: 3, a: 1 })).toEqual(['- b: 2', '  c: 3', '  a: 1']);
    expect(lines({ a: 1, gone: true, c: 3 }, { a: 1, c: 4 })).toEqual(['  a: 1', '- gone: true', '- c: [3]', '+ c: [4]']);
  });

  it('keys an array’s items by their index under the array’s key, nested keys a level deeper', () => {
    const was = { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] };
    const now = { role: 'user', content: [{ type: 'tool_result', content: 'refused' }] };
    expect(lines(was, now)).toEqual(['  role: "user"', '  content[0]:', '    type: "tool_result"', '-   content: "[ok]"', '+   content: "[refused]"']);
    expect(jsonDiff(was, now).at(-1)!.path).toBe('$.content[0].content');
    expect(lines({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual(['  tags[0]: "a"', '+ tags[1]: "b"']);
  });

  it('walks JSON inside a string as JSON, and says so, on both sides and on one', () => {
    const both = jsonDiff({ content: JSON.stringify(POLICY) }, { content: JSON.stringify(FIXED) });
    expect(both.map(said)).toEqual(['  content: JSON in a string', '    region: "EU"', '+   refund_limit: 100', '    approval: "tier2"']);
    // Inside the string, the path is the string's: the structural diff goes no deeper.
    expect(both.map((l) => l.path)).toEqual(['$.content', '$.content', '$.content', '$.content']);
    expect(lines({}, { result: JSON.stringify({ fraud_hold: true }) })).toEqual(['+ result: JSON in a string', '+   fraud_hold: true']);
    // Where only one side's string reads as JSON, the two values are its two lines.
    expect(lines({ content: 'not found' }, { content: '{"id":7}' }).map((l) => l.replace(/[[\]]/g, ''))).toEqual(['- content: "not found"', '+ content: "{\\"id\\":7}"']);
  });

  it('marks the words that differ: a UUID whole, its quotes not, a lone joiner with the words around it', () => {
    expect(wordMarks(`"${UUID_A}"`, `"${UUID_B}"`)).toEqual([
      [
        { text: '"', marked: false },
        { text: UUID_A, marked: true },
        { text: '"', marked: false },
      ],
      [
        { text: '"', marked: false },
        { text: UUID_B, marked: true },
        { text: '"', marked: false },
      ],
    ]);
    expect(wordMarks('"refund within 50 EUR"', '"refund within 100 EUR"')[1]).toEqual([
      { text: '"refund within ', marked: false },
      { text: '100', marked: true },
      { text: ' EUR"', marked: false },
    ]);
    // A joiner between two kept words stays unmarked.
    expect(wordMarks('order-1042', 'order-1043')[1]).toEqual([
      { text: 'order-', marked: false },
      { text: '1043', marked: true },
    ]);
  });

  it('keeps a value with no space in it whole, and only that', () => {
    const [was, now] = jsonDiff({ user_id: UUID_A }, { user_id: UUID_B });
    expect([was.whole, now.whole]).toEqual([true, true]);
    expect(jsonDiff({ note: 'a b' }, { note: 'a c' }).every((l) => !l.whole)).toBe(true);
  });

  it('cuts an unchanged value past a line with …, and never a changed one', () => {
    const long = 'Refund only within the policy limit, and escalate anything above it to a person.';
    const [context, , added] = jsonDiff({ system: long, model: 'a' }, { system: long, model: 'b' });
    expect(context.value[0].text).toHaveLength(CUT);
    expect(context.value[0].text.endsWith('…')).toBe(true);
    expect(added.value.map((p) => p.text).join('')).toBe('"b"');
    const changed = jsonDiff({ system: long }, { system: `${long} Always.` });
    expect(changed.map((l) => l.value.map((p) => p.text).join(''))).toEqual([JSON.stringify(long), JSON.stringify(`${long} Always.`)]);
  });

  it('draws a long object one side alone has as its keys under its own, each with the sign', () => {
    const policy = { region: 'EU', refund_limit: 100, approval: 'tier2', escalate_to: 'refunds-team', currency: 'EUR' };
    expect(lines({}, { policy })).toEqual(['+ policy:', '+   region: "EU"', '+   refund_limit: 100', '+   approval: "tier2"', '+   escalate_to: "refunds-team"', '+   currency: "EUR"']);
    expect(lines({}, { short: { a: 1 } })).toEqual(['+ short: {"a":1}']);
  });

  it('folds a changed array’s unchanged items into one line, by their indexes', () => {
    const messages = (last: string) => [{ role: 'user', content: 'Refund order 1042' }, { role: 'assistant', content: 'Looking it up' }, { role: 'user', content: 'Thanks' }, { role: 'user', content: last }];
    const out = jsonDiff({ messages: messages('ok') }, { messages: messages('done') });
    expect(out.map(said)).toEqual(['  messages[0–2]: [ … ]', '  messages[3]:', '    role: "user"', '-   content: "[ok]"', '+   content: "[done]"']);
    expect(out[0]).toMatchObject({ fold: true, path: '$.messages[0]' });
    // A single unchanged item stays a line of its own.
    expect(lines(['a', 'b'], ['a', 'c'])[0]).toBe('  [0]: "a"');
  });

  it('pairs a removed line with the added one that replaces it, side by side', () => {
    const rows = splitRows(jsonDiff({ region: 'EU', model: 'a' }, { region: 'EU', model: 'b', extra: 1 }));
    expect(rows.map(([l, r]) => [l && said(l), r && said(r)])).toEqual([
      ['  region: "EU"', '  region: "EU"'],
      ['- model: "[a]"', '+ model: "[b]"'],
      [null, '+ extra: 1'],
    ]);
  });
});
