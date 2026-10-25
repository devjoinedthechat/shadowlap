import { describe, expect, it } from 'vitest';
import { markdownCode, markdownFence, markdownText } from '../src/markdown.js';
import { repairMarkdown } from '../src/repair.js';
import { repairReport } from './fix-fixtures.js';
import { HOSTILE } from './markdown-cases.js';

/**
 * Text a run, a model or a tool wrote goes into the Markdown GitHub renders: a fix pull request's
 * body, the Action's comment and its job summary. These hold the escaper to "shows as it is, makes
 * nothing": no image, link, mention, issue reference, raw HTML, code span, math or emphasis, in a
 * paragraph, a heading, a table cell or an HTML block. The same cases ran through cmark-gfm,
 * GitHub's own renderer, with its mention and reference filters played on the text it rendered.
 */

/** What GitHub would read in Markdown text as something other than the text itself. */
function active(out: string): string[] {
  const text = out.replace(/<!-- -->/g, '').replace(/&#?\w+;/g, '');
  const found: string[] = [];
  for (const [what, re] of [
    ['a link, an image or a footnote', /[[\]]/],
    ['a code span or an escape', /[`]|\\(?!\|)/],
    ['math', /\$/],
    ['emphasis', /[*~]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/],
    ['raw HTML', /<[A-Za-z/!?]/],
    ['a line break', /[\n\r\u2028\u2029]/],
    ['a hidden or reordering character', /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/],
    ['a table cell boundary', /(?<!\\)\|/],
  ] as const) if (re.test(text)) found.push(what);
  // Mentions, references, URLs and addresses are split by the empty comment, so the text GitHub scans has none.
  for (const [what, re] of [
    ['a mention or an email address', /@[A-Za-z0-9]/],
    ['an issue or pull request reference', /(?<!&)#\d|\bGH-\d/i],
    ['a URL', /[A-Za-z]:\/\//],
    ['a www. address', /\bwww\./i],
  ] as const) if (re.test(out.replace(/&#?\w+;/g, ''))) found.push(what);
  return found;
}

/** The text a reader sees: the comments gone, the character references read, the cell's escaped pipe a pipe. */
function shown(out: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };
  return out
    .replace(/<!-- -->/g, '')
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
    expect(body).toContain('## Escalate refunds @<!-- -->northwind/security-team !&#91;x&#93;(https:<!-- -->//evil.example/a.p…\n');
    // The diff is a fence its own backticks can't close.
    expect(body).toContain('````diff\n- ');
    expect(body).toContain('+ Follow the policy. ``` and [docs](https://evil.example) @alice\n````');
  });
});
