import { describe, expect, it } from 'vitest';
import { sourceStrings, type SourceLanguage } from '../src/source-strings.js';

/**
 * The strings of JavaScript, TypeScript and Python source, as their parsers read them: where a repair
 * may rewrite text in code (repair-patch.ts). What is not in a string is code, a comment or a regular
 * expression, and a string's `${…}` or f-string `{…}` is code too.
 */

/** Each string's text as the source holds it, with each place of code in it marked ⟨…⟩. */
function texts(source: string, language: SourceLanguage): string[] {
  return sourceStrings(source, language).map((s) => {
    let out = '';
    let at = s.start;
    for (const [from, to] of s.code) {
      out += `${source.slice(at, from)}⟨${source.slice(from, to)}⟩`;
      at = to;
    }
    return out + source.slice(at, s.end);
  });
}

describe('sourceStrings in JavaScript and TypeScript', () => {
  it("reads quoted strings and template literals, and a template literal's ${…} as code with its own strings", () => {
    expect(texts("const a = 'one'; const b = \"two\"; const c = `three ${a + '!'} four`;", 'js')).toEqual(['one', 'two', "three ⟨${a + '!'}⟩ four", '!']);
    // Nested: a template literal in a ${…}, braces in it, and a line break in a template literal.
    expect(texts('const t = `a ${ok ? `b ${c}` : { d: "}" }.d} e\nf`;', 'js')).toEqual(['a ⟨${ok ? `b ${c}` : { d: "}" }.d}⟩ e\nf', 'b ⟨${c}⟩', '}']);
    expect(texts("const s = 'it\\'s', d = \"say \\\"hi\\\"\";", 'js')).toEqual(["it\\'s", 'say \\"hi\\"']);
    // A backslash at the end of a line continues the string, CRLF and all.
    expect(texts("const s = 'one \\\r\ntwo';", 'js')).toEqual(['one \\\r\ntwo']);
  });

  it('skips comments and regular expressions, told from a division by what comes before the slash', () => {
    expect(texts("#!/usr/bin/env node\n// it's a comment\nconst r = /'/g; /* 'not' */ const s = 'yes';", 'js')).toEqual(['yes']);
    expect(texts("const q = a / b / 'c'; const d = (x) / 2 + 'e';", 'js')).toEqual(['c', 'e']);
    expect(texts("if (ok) return /[/']+/.test(s) ? 'q' : \"r\";", 'js')).toEqual(['q', 'r']);
    expect(texts("const n = 1.5 / 2, m = arr[0] / 3, s = 'z';", 'js')).toEqual(['z']);
    // A slash no other closes on its line divides.
    expect(texts("x = y++ / 2; const s = 'k';", 'js')).toEqual(['k']);
  });

  it('ends a quote left open at the end of its line, and a template literal left open at the end of the file', () => {
    expect(texts("const a = 'open\nconst b = 'shut';", 'js')).toEqual(['open', 'shut']);
    expect(texts('const t = `open ${x} to the end\nof the file', 'js')).toEqual(['open ⟨${x}⟩ to the end\nof the file']);
    // JSX text is no string: an apostrophe in it reaches no further than its line.
    expect(texts("const p = <p>Don't</p>;\nconst s = 'real';", 'js')).toEqual(['t</p>;', 'real']);
  });
});

describe('sourceStrings in Python', () => {
  it('reads every kind of string: prefixes in any case, triple quotes, raw and byte strings', () => {
    expect(texts('a = \'one\'\nb = r"two\\""\nc = """three\n\'four\'\n"""\nd = Rb\'five\'\ne = u"six"', 'python')).toEqual(['one', 'two\\"', "three\n'four'\n", 'five', 'six']);
    expect(texts("doc = '''A tool's description.'''", 'python')).toEqual(["A tool's description."]);
  });

  it("reads an f-string's or t-string's {…} as code with its own strings, and {{ as a brace", () => {
    expect(texts('s = f"Refunds above {limit} need {{a manager}}."', 'python')).toEqual(['Refunds above ⟨{limit}⟩ need {{a manager}}.']);
    expect(texts("s = F'{x[\"k\"]} and {y:{w}}'", 'python')).toEqual(["⟨{x[\"k\"]}⟩ and ⟨{y:{w}}⟩", 'k']);
    // Python 3.12 takes the f-string's own quote inside its {…}, and so does a template string.
    expect(texts('s = f"{x["k"]}!"\nt = t"{a} b"', 'python')).toEqual(['⟨{x["k"]}⟩!', 'k', '⟨{a}⟩ b']);
    // In any other string, braces are text.
    expect(texts("s = 'Refunds above {limit}.'.format(limit=1)", 'python')).toEqual(['Refunds above {limit}.']);
  });

  it('skips comments, and a word before a quote that is no prefix', () => {
    expect(texts("# it's a comment\nx = 'a'  # \"b\"\ny = 1 if z else'c'", 'python')).toEqual(['a', 'c']);
    // A quote left open ends at its line; a triple-quoted one at the end of the file.
    expect(texts("a = 'open\nb = 'shut'\nc = '''to the end", 'python')).toEqual(['open', 'shut', 'to the end']);
  });
});
