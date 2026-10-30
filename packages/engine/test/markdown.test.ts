import { describe, expect, it } from 'vitest';
import { markdownCode, markdownFence, markdownText, titleText } from '../src/markdown.js';
import { repairMarkdown } from '../src/repair.js';
import { repairReport } from './fix-fixtures.js';
import { HOSTILE, HOSTILE_TITLES } from './markdown-cases.js';

/**
 * Text a run, a model or a tool wrote goes into the Markdown GitHub renders: a fix pull request's
 * body, the Action's comment and its job summary. These hold the escaper to "shows as it is, makes
 * nothing": no image, link, mention, issue reference, raw HTML, code span, math, emphasis or emoji,
 * in a paragraph, a heading, a table cell or an HTML block. The same cases, in each of those
 * places and as code spans, went through GitHub's own renderer (its Markdown API, in a repository
 * with issues), which made nothing of any of them; unescaped, it made images, links, mentions,
 * issue links, footnotes, math and emphasis of them.
 */

/** What GitHub would read in Markdown text as something other than the text itself. */
function active(out: string): string[] {
  // The escaper's own marks taken out: the empty span that splits, and the character references it writes.
  const text = out.replace(/<span><\/span>/g, '').replace(/&#?\w+;/g, '');
  const found: string[] = [];
  for (const [what, re] of [
    ['a link, an image or a footnote', /[[\]]/],
    ['a code span or an escape', /[`]|\\(?!\|)/],
    ['emphasis', /[*~]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/],
    ['raw HTML', /<[A-Za-z/!?]/],
    ['a line break', /[\n\r\u2028\u2029]/],
    ['a hidden or reordering character', /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/],
    ['a table cell boundary', /(?<!\\)\|/],
  ] as const) if (re.test(text)) found.push(what);
  // What GitHub finds once it has rendered the text, and the links it makes as it parses: each mark
  // split from what follows by the empty span, and two dollar signs apart, so the text it scans has none.
  for (const [what, re] of [
    ['math', /\$(?!<span><\/span>)/],
    ['math a paragraph of its own makes', /\$<span><\/span>\$/],
  ] as const) if (re.test(out)) found.push(what);
  for (const [what, re] of [
    ['a mention or an email address', /@[A-Za-z0-9]/],
    ['an issue or pull request reference', /(?<!&)#\d|\bGH-\d/i],
    ['an emoji', /:[A-Za-z0-9_+-]+:/],
    ['a URL', /[A-Za-z]:\/\//],
    ['a www. address', /\bwww\./i],
  ] as const) if (re.test(out.replace(/&#?\w+;/g, ''))) found.push(what);
  return found;
}

/** The text a reader sees: the spans and the word joiner between two dollar signs, which show nothing, gone, the character references read, the cell's escaped pipe a pipe. */
function shown(out: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };
  return out
    .replace(/<span><\/span>/g, '')
    .replace(/\$&#8288;/g, '$')
    .replace(/\\\|/g, '|')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&(\w+);/g, (m, name: string) => named[name] ?? m);
}

describe('markdownText', () => {
  it('shows what a run or a model wrote as it is, in one line, and makes nothing of it: no image, link, mention, reference, HTML, code, math or emphasis', () => {
    for (const raw of HOSTILE) {
      const out = markdownText(raw);
      expect(active(out), `${JSON.stringify(raw)} → ${out}`).toEqual([]);
      const oneLine = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
      expect(shown(out), raw).toBe(oneLine);
    }
    // Prose a check or a gate writes reads the same in the Markdown it renders as.
    expect(markdownText('passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts')).toBe('passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    expect(markdownText('check failed: issue_refund called 0 times, but called 1 time')).toBe('check failed: issue_refund called 0 times, but called 1 time');
  });

  it('splits what GitHub finds in the text it has rendered with an empty span, which a table cell keeps, and two dollar signs with a word joiner', () => {
    // GitHub reads character references before it looks for math, mentions, references and emoji,
    // and in a table cell it drops an HTML comment first: of the three, only a span splits the text
    // it looks in everywhere. A paragraph whose text starts and ends with `$$` is math, spans or not.
    expect(markdownText('@alice #5 GH-3 :smile: https://x.example www.x.example')).toBe('@<span></span>alice #<span></span>5 GH-<span></span>3 :<span></span>smile: https:<span></span>//x.example www<span></span>.x.example');
    expect(markdownText('$$x$$')).toBe('$<span></span>&#8288;$<span></span>x$<span></span>&#8288;$<span></span>');
    expect(markdownText('costs $5 and $10')).toBe('costs $<span></span>5 and $<span></span>10');
  });

  it('writes a code span its own backticks cannot end, and a fence no line inside can close', () => {
    expect(markdownCode('goldens/refund-flow')).toBe('`goldens/refund-flow`');
    expect(markdownCode('a ``b`` c')).toBe('```a ``b`` c```');
    expect(markdownCode('`edge`')).toBe('`` `edge` ``');
    // A table needs a code span's pipe escaped; prose shows the backslash, so there it stays as it is.
    expect(markdownCode('refund|flow', { cell: true })).toBe('`refund\\|flow`');
    expect(markdownCode('refund|flow')).toBe('`refund|flow`');
    expect(markdownFence('- a ```diff\n+ b', 'diff')).toBe('````diff\n- a ```diff\n+ b\n````');
  });
});

describe('titleText', () => {
  it("titles a pull request on one line, within GitHub's limit, a mention, a reference and a workflow command's start split by a character that shows nothing", () => {
    expect(titleText('Escalate refunds over $500 to @finance-leads, see #12')).toBe('Escalate refunds over $500 to @\u2060finance-leads, see #\u206012');
    expect(titleText('::stop-commands::x\nApprove it\u202e')).toBe(':\u2060:stop-commands:\u2060:x Approve it');
    expect(titleText('##[error]x, see GH-4')).toBe('#\u2060#[error]x, see GH-\u20604');
    // Nothing left: the pull request is named by its branch instead.
    expect(['\u200b\u200e\u2060\ufeff', '   ', ''].map(titleText)).toEqual(['', '', '']);
    for (const raw of [...HOSTILE, ...HOSTILE_TITLES]) {
      const title = titleText(raw);
      expect([...title].length, raw).toBeLessThanOrEqual(256);
      expect(title, raw).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2061-\u2064\u2066-\u2069\ufeff]|@[A-Za-z0-9]|#\d|##\[|::|\bGH-\d/i);
      // What it shows is what was written, white space run together and hidden characters left out: the joiners show nothing.
      const written = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      const shown = title.replace(/\u2060/g, '');
      expect(title.endsWith('…') ? written.startsWith(shown.slice(0, -1)) : shown === written, raw).toBe(true);
    }
  });
});

describe('repairMarkdown and what the repairer and the runs wrote', () => {
  it('puts it in a pull request body as text GitHub renders, links and mentions nothing in', () => {
    const report = repairReport({ targets: ['01M540RX39NC308SMAJ73MN8RB'] });
    const accepted = report.candidates.find((c) => c.id === report.accepted)!;
    Object.assign(accepted, {
      strategy: 'Escalate refunds @northwind/security-team ![x](https://evil.example/a.png)',
      why: 'Approved by #1. See https://evil.example and <img src=x>.',
      after: 'Follow the policy. ``` and [docs](https://evil.example) @alice',
      reason: null,
    });
    report.diagnosis = 'The model read [this](https://evil.example) from a tool, cc @bob';
    report.targets[0] = { ...report.targets[0], recorded: 'called issue_refund with {"note":"![](https://evil.example/t.png)"}', rescued: 'escalated: www.evil.example' };
    const body = repairMarkdown(report);
    // Outside the fenced diff, where GitHub renders nothing, nothing is left to render.
    const outside = body.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '');
    expect(outside).not.toContain('```');
    expect(outside).not.toMatch(/!\[|\]\(|<img|@(?:alice|bob|northwind)|https?:\/\/|www\.evil|(?<!&)#1\b/);
    // The title, cut to a commit title's length, then escaped.
    expect(body).toContain('## Escalate refunds @<span></span>northwind/security-team !&#91;x&#93;(https:<span></span>//evil.example/a.p…\n');
    // The diff is a fence its own backticks can't close.
    expect(body).toContain('````diff\n- ');
    expect(body).toContain('+ Follow the policy. ``` and [docs](https://evil.example) @alice\n````');
  });
});
