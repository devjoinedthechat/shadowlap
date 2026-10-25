import { describe, expect, it } from 'vitest';
import { junitXml } from '../src/junit.js';

/**
 * `shadowlap test --junit`: a report CI dashboards parse with a standard XML parser, so it has to be
 * well-formed XML 1.0 whatever the agent printed. XML 1.0 has no way to write most C0 control
 * characters, not even escaped, so an ESC from a coloured logger makes the whole file unreadable.
 */

/** The XML 1.0 Char production: tab, line feed, carriage return and the rest of Unicode but surrogates, U+FFFE and U+FFFF. */
const NOT_XML_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10ffff}]/u;

/**
 * A strict reading of the subset of XML the report uses: a declaration, then elements with quoted
 * attributes, text and CDATA sections. Throws, as an XML parser would, on what XML doesn't allow.
 */
function parse(xml: string): { name: string; attrs: Record<string, string>; text: string; children: unknown[] } {
  const bad = NOT_XML_CHAR.exec(xml);
  if (bad) throw new Error(`invalid Char value ${bad[0].codePointAt(0)} at ${bad.index}`);
  let i = 0;
  const decl = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/.exec(xml);
  if (!decl) throw new Error('no XML declaration');
  i = decl[0].length;
  const entity = (s: string, where: string) => {
    if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(s)) throw new Error(`a bare & in ${where}`);
    if (s.includes('<')) throw new Error(`a bare < in ${where}`);
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };
  type El = { name: string; attrs: Record<string, string>; text: string; children: El[] };
  const element = (): El => {
    const open = /^<([A-Za-z][\w-]*)((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*(\/?)>/.exec(xml.slice(i));
    if (!open) throw new Error(`not a start tag at ${i}: ${JSON.stringify(xml.slice(i, i + 40))}`);
    i += open[0].length;
    const attrs: Record<string, string> = {};
    for (const m of open[2].matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) attrs[m[1]] = entity(m[2], `attribute ${m[1]}`);
    const el: El = { name: open[1], attrs, text: '', children: [] };
    if (open[3]) return el;
    for (;;) {
      if (xml.startsWith('<![CDATA[', i)) {
        const end = xml.indexOf(']]>', i);
        if (end < 0) throw new Error('an unclosed CDATA section');
        el.text += xml.slice(i + 9, end);
        i = end + 3;
      } else if (xml.startsWith(`</${el.name}>`, i)) {
        i += el.name.length + 3;
        return el;
      } else if (xml[i] === '<') {
        el.children.push(element());
      } else {
        const next = xml.indexOf('<', i);
        if (next < 0) throw new Error(`${el.name} is never closed`);
        const text = xml.slice(i, next);
        if (text.includes(']]>')) throw new Error("the sequence ']]>' is not allowed in content");
        el.text += entity(text, el.name);
        i = next;
      }
    }
  };
  const root = element();
  if (xml.slice(i).trim()) throw new Error('content after the root element');
  return root;
}

describe('junitXml', () => {
  it('reports an inconclusive verdict CI lets through as skipped, neither passed nor failed', () => {
    const xml = junitXml('shadowlap', [
      { name: 'refund', classname: 'shadowlap.replay', timeSeconds: 2, skipped: { message: 'inconclusive · 33 of 40 · rate 0.68 to 0.91 (95%) & so on' }, systemOut: '[shadowlap] pass^5 0.39' },
      { name: 'triage', classname: 'shadowlap.replay', timeSeconds: 1 },
    ]);
    const doc = parse(xml);
    expect(doc.attrs).toMatchObject({ tests: '2', failures: '0', skipped: '1' });
    const [skipped] = doc.children as Array<{ children: Array<{ name: string; attrs: Record<string, string> }> }>;
    expect(skipped.children[0]).toMatchObject({ name: 'skipped', attrs: { message: 'inconclusive · 33 of 40 · rate 0.68 to 0.91 (95%) & so on' } });
    // A suite with nothing skipped says nothing about it, as before.
    expect(junitXml('shadowlap', [{ name: 'triage', classname: 'shadowlap.replay', timeSeconds: 1 }])).not.toContain('skipped');
  });

  it('stays well-formed XML when the output carries escape codes and other control bytes', () => {
    const coloured = '\u001b[32mINFO\u001b[0m starting\n\u0007bell\u0000nul\ttab\r\nend';
    const xml = junitXml('shadowlap', [
      { name: 'goldens/01M584ZMKN', classname: 'shadowlap.\u001b[1mgoldens', timeSeconds: 0.25, systemOut: coloured },
      {
        name: 'goldens/refund\u001b[31m',
        classname: 'shadowlap.goldens',
        timeSeconds: 1.5,
        failure: { message: 'diverged at \u001b[33m#3\u001b[0m & <tool>', details: `divergence\u001b[0m ]]> and more\n${coloured}` },
        systemOut: 'lone surrogate \ud800 and ￿',
      },
    ]);
    const doc = parse(xml);
    expect(doc.name).toBe('testsuite');
    expect(doc.attrs).toMatchObject({ tests: '2', failures: '1' });
    const [ok, failed] = doc.children as Array<{ attrs: Record<string, string>; children: Array<{ name: string; attrs: Record<string, string>; text: string }> }>;
    // What the agent printed stays readable: each control character shows as its escape, as the Markdown report shows it.
    expect(ok.attrs).toMatchObject({ name: 'goldens/01M584ZMKN', classname: 'shadowlap.\\x1b[1mgoldens' });
    expect(ok.children[0]).toMatchObject({ name: 'system-out', text: '\\x1b[32mINFO\\x1b[0m starting\n\\x07bell\\x00nul\ttab\nend' });
    expect(failed.attrs.name).toBe('goldens/refund\\x1b[31m');
    const failure = failed.children.find((c) => c.name === 'failure')!;
    expect(failure.attrs.message).toBe('diverged at \\x1b[33m#3\\x1b[0m & <tool>');
    expect(failure.text).toContain('divergence\\x1b[0m ]]> and more');
    // What XML has no character for at all becomes the replacement character.
    expect(failed.children.find((c) => c.name === 'system-out')!.text).toBe('lone surrogate � and �');
  });

  it('writes plain output as it is', () => {
    const doc = parse(junitXml('shadowlap', [{ name: 'goldens/a', classname: 'shadowlap.goldens', timeSeconds: 0, systemOut: 'ok "quoted" & <b>\n' }]));
    expect((doc.children[0] as { children: Array<{ text: string }> }).children[0].text).toBe('ok "quoted" & <b>\n');
  });
});
