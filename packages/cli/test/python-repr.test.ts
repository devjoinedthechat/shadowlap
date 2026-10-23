import { describe, expect, it } from 'vitest';
import { readPythonRepr } from '../src/python-repr.js';

/**
 * Python's repr() read back. The printed blocks are what the Anthropic SDK for Python (2.1.0) prints
 * for the blocks of a reply, str() of each, beside what each holds (its model_dump()).
 */

describe('reading what Python printed', () => {
  it("reads what the Anthropic SDK prints for a reply's blocks as what they hold", () => {
    const printed: Array<[string, Record<string, unknown>]> = [
      ["TextBlock(citations=None, text='Looking up the order.', type='text')", { citations: null, text: 'Looking up the order.', type: 'text' }],
      [`TextBlock(citations=None, text='It\\'s "quoted" and it\\'s not', type='text')`, { citations: null, text: `It's "quoted" and it's not`, type: 'text' }],
      [`TextBlock(citations=None, text="It's here", type='text')`, { citations: null, text: "It's here", type: 'text' }],
      ["TextBlock(citations=None, text='line one\\nline two\\ttabbed \\\\ backslash \\r\\n', type='text')", { citations: null, text: 'line one\nline two\ttabbed \\ backslash \r\n', type: 'text' }],
      ["TextBlock(citations=None, text='bell \\x07 nul \\x00 del \\x7f esc \\x1b', type='text')", { citations: null, text: 'bell \x07 nul \x00 del \x7f esc \x1b', type: 'text' }],
      ["TextBlock(citations=None, text='café ✓ 😀 \\u2028 sep \\xa0 nbsp \\ufeff bom \\ud800 lone \\U0010ffff', type='text')", { citations: null, text: 'café ✓ 😀   sep \xa0 nbsp ﻿ bom \ud800 lone \u{10ffff}', type: 'text' }],
      ["TextBlock(citations=None, text='', type='text')", { citations: null, text: '', type: 'text' }],
      [
        "TextBlock(citations=[CitationCharLocation(cited_text='policy', document_index=0, document_title=None, end_char_index=6, file_id=None, start_char_index=0, type='char_location')], text='Refunded $240.', type='text')",
        { citations: [{ cited_text: 'policy', document_index: 0, document_title: null, end_char_index: 6, file_id: null, start_char_index: 0, type: 'char_location' }], text: 'Refunded $240.', type: 'text' },
      ],
      ["ToolUseBlock(id='toolu_1', caller=None, input={'order_id': 'A-1042'}, name='lookup_order', type='tool_use', toolset_name=None)", { id: 'toolu_1', caller: null, input: { order_id: 'A-1042' }, name: 'lookup_order', type: 'tool_use', toolset_name: null }],
      [
        `ToolUseBlock(id='toolu_2', caller=None, input={'order_id': 'A-1042', 'amount': 240, 'rate': 0.1, 'big': 12345678901234567890, 'tiny': 1e-07, 'huge': 1e+16, 'neg': -3.5, 'ok': True, 'no': False, 'none': None, 'list': [1, 'two', [3.0]], 'nested': {'k': {'k2': []}}, 'empty': {}, 'quote': "it's", 'both': 'it\\'s "x"'}, name='issue_refund', type='tool_use', toolset_name=None)`,
        {
          id: 'toolu_2',
          caller: null,
          input: { order_id: 'A-1042', amount: 240, rate: 0.1, big: 12345678901234567890, tiny: 1e-7, huge: 1e16, neg: -3.5, ok: true, no: false, none: null, list: [1, 'two', [3]], nested: { k: { k2: [] } }, empty: {}, quote: "it's", both: `it's "x"` },
          name: 'issue_refund',
          type: 'tool_use',
          toolset_name: null,
        },
      ],
      ["ToolUseBlock(id='toolu_4', caller=DirectCaller(type='direct'), input={'q': 1}, name='direct', type='tool_use', toolset_name=None)", { id: 'toolu_4', caller: { type: 'direct' }, input: { q: 1 }, name: 'direct', type: 'tool_use', toolset_name: null }],
      ["ThinkingBlock(signature='c2ln', thinking='Let me think.', type='thinking')", { signature: 'c2ln', thinking: 'Let me think.', type: 'thinking' }],
    ];
    for (const [text, value] of printed) expect(readPythonRepr(text), text).toEqual({ value });
  });

  it('reads nothing from text that is not one value as repr writes it', () => {
    for (const text of [
      'Looking up the order.',
      '',
      "TextBlock(citations=None, text='cut short",
      "TextBlock(text='hi', type='text') and more",
      "TextBlock(text='hi' , type='text')",
      "TextBlock(text = 'hi', type='text')",
      "TextBlock(text='\\q', type='text')",
      "TextBlock(text='\\X41', type='text')",
      "TextBlock(text='raw\nnewline', type='text')",
      "ToolUseBlock(id='toolu_1', input={'a': nan}, name='x', type='tool_use')",
      "ToolUseBlock(id='toolu_1', input={'a': -inf}, name='x', type='tool_use')",
      "ToolUseBlock(id='toolu_1', input={'a': (1, 2)}, name='x', type='tool_use')",
      "ToolUseBlock(id='toolu_1', input={'a': {1, 2}}, name='x', type='tool_use')",
      "ToolUseBlock(id='toolu_1', input={'a': set()}, name='x', type='tool_use')",
      "ToolUseBlock(id='toolu_1', input={1: 'a'}, name='x', type='tool_use')",
      "ToolUseBlock(id='toolu_1', input={'when': datetime.date(2026, 10, 1)}, name='x', type='tool_use')",
      "ToolUseBlock(id='toolu_1', input={'amount': Decimal('240.00')}, name='x', type='tool_use')",
      `ToolUseBlock(id='toolu_1', input={'a': ${'['.repeat(200)}${']'.repeat(200)}}, name='x', type='tool_use')`,
    ]) {
      expect(readPythonRepr(text), text).toBeNull();
    }
  });

  it('keeps every field and key its own, none reaching a prototype', () => {
    const read = readPythonRepr("Block(__proto__={'polluted': True}, input={'__proto__': {'polluted': True}})")!.value as Record<string, unknown>;
    expect(Object.keys(read)).toEqual(['__proto__', 'input']);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    expect(Object.keys(read.input as object)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
