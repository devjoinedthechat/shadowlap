import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Code, CodeText, Command, Copy, LongWord, Words } from '../ui/components/Copy.js';
import { DialogFacts } from '../ui/components/DialogFacts.js';
import { DotParts } from '../ui/components/DotParts.js';
import { EmptyState } from '../ui/components/States.js';
import { ToastWords } from '../ui/components/Toast.js';
import { dotParts } from '../ui/components/Verdict.js';
import { FixTitle } from '../ui/fixes/parts.js';
import { planCopy } from '../ui/typeset-lines.js';
import { styleRules } from './css-sheet.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The line-break rules the copy parts and the stylesheet hold beyond what ui-typeset and
 * ui-primitives pin: controls on one line, no balanced block of nowrap pieces beside a part that may
 * break anywhere, a key's value broken inside a word only where it must, a dot kept with the part
 * before it, an id or a digest whole where its line holds it, a flag as code, an operator kept with
 * the word before it, and a dialog's quiet clause set by its measure. browser/line-breaks.spec.ts
 * reads the lines a browser draws from them at 320 to 430 px.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});
const draw = async (el: ReactElement) => (r = await render(el));
/** What was drawn, its no-break spaces kept. */
const drawn = () => r!.document.body.textContent;

const rules = styleRules();
/** A property's values in the top-level rules naming a selector, in the stylesheet's order. */
const values = (selector: string, prop: string) => rules.filter((x) => !x.conditions.length && x.selectors.includes(selector)).flatMap((x) => x.decls.filter(([p]) => p === prop).map(([, v]) => v));

describe('the stylesheet', () => {
  it('keeps every control on one line', () => {
    for (const s of ['.btn', '.ibtn', '.linkbtn', '[role="tab"]']) expect(values(s, 'white-space'), s).toContain('nowrap');
  });

  it('never balances a block of nowrap pieces beside a part that may break anywhere, which crashed Chromium', () => {
    for (const s of ['.kvs dd', '.attn .d', '.fnode .f2', '.pside .pdec.wrap']) expect(values(s, 'text-wrap'), s).not.toContain('balance');
    expect(values('.kvs dd', 'text-wrap')).toContain('pretty');
  });

  it('breaks a key’s value inside a word only where its line can’t hold the word whole, as the mock does', () => {
    expect(values('.kvs dd', 'overflow-wrap')).toContain('anywhere');
    expect(values('.kvs dd', 'word-break')).not.toContain('break-all');
    // a finding's flag is Code, broken between its arguments: never anywhere, which broke its line before the dot after it
    expect(rules.some((x) => x.selectors.includes('.banner .why code'))).toBe(false);
  });

  it('wraps prose pretty and headings balanced, a step’s line of whole parts pretty, and a title’s last clause as an inline block', () => {
    expect(values('body', 'text-wrap')).toContain('pretty');
    for (const s of ['h1', 'h4']) expect(values(s, 'text-wrap'), s).toContain('balance');
    expect(values('.stepper .m', 'text-wrap')).toEqual(['pretty']);
    expect(values('.clause', 'display')).toEqual(['inline-block']);
  });

  it('stacks Context’s figures under 400px', () => {
    const stacked = rules.filter((x) => x.selectors.includes('.cstats') && x.conditions.some((c) => /max-width:\s*400px/.test(c)));
    expect(stacked.flatMap((x) => x.decls)).toContainEqual(['grid-template-columns', 'minmax(0, 1fr)']);
  });

  it('stacks a key and value list at 340px and under', () => {
    const stacked = rules.filter((x) => x.selectors.includes('.kvs') && x.conditions.some((c) => /max-width:\s*340px/.test(c)));
    expect(stacked.flatMap((x) => x.decls)).toContainEqual(['grid-template-columns', 'minmax(0, 1fr)']);
  });
});

describe('a line of dot parts', () => {
  it('keeps a part of 44 characters or fewer whole with its dot, and a longer one’s dot with its last word', async () => {
    const long = 'the refund agent forked 5 attempts, 5 passed.';
    expect(long).toHaveLength(45);
    const parts = dotParts(['cost ≈$0.054', long, 'now'].join(' · '));
    expect(parts.map((p) => p.keep)).toEqual(['whole', null, 'whole']);
    expect(parts[1].text.endsWith('passed.\u00a0·')).toBe(true);
    // a soft part, kept whole where its line holds it, keeps its dot with it too
    expect(dotParts(`${long} · now`, 44, 60)[0]).toEqual({ text: `${long}\u00a0·`, keep: 'soft' });
    await draw(createElement(DotParts, { parts: ['cost ≈$0.054', long, 'now'] }));
    expect(drawn()).toContain('passed.\u00a0·');
    expect(drawn()).toContain('≈$0.054\u00a0·');
  });

  it('keeps a part whole up to the `max` it is given', async () => {
    await draw(createElement(DotParts, { parts: ['forked 5 attempts, 5 passed', 'now'], max: 24 }));
    // past 24 characters, the part's words are glued and kept whole by Words, its dot with its last word
    expect(drawn()).toContain('passed\u00a0·');
    expect(drawn()).toContain('5\u00a0attempts');
  });
});

describe('the parts kept whole', () => {
  it('draws an id or a digest as one long piece, whole where its line holds it and broken only where it must', async () => {
    const digest = 'f8e038d3a26d3d58fe7032e55ccf0b3e67b7a45b3d784aadc2309c52e8d2a165';
    await draw(createElement(LongWord, { children: digest }));
    expect(r!.one('ts-w').className).toMatch(/\bts-long\b/);
    expect(r!.all('ts-w ts-p').map((p) => p.textContent)).toEqual([digest]);
  });

  it('sets a flag with its value as code that never breaks, up to 32 characters', async () => {
    await draw(createElement(Code, { children: '--fail-at 19=529' }));
    expect(r!.one('code').className).toBe('ts-code');
  });

  it('keeps an operator in code shown as text with the word before it, so no line starts with one', async () => {
    await draw(createElement(CodeText, { children: 'when lookup_order has result.amount > 100: issue_refund called 0 times' }));
    const t = drawn();
    expect(t.replace(/\u00a0/g, ' ')).toBe('when lookup_order has result.amount > 100: issue_refund called 0 times');
    expect(r!.all('code .nw').map((s) => s.textContent).find((piece) => piece.includes('>'))).toMatch(/result\.amount >/);
  });

  it('glues a count to its noun in words no Copy sets', async () => {
    await draw(createElement(Words, { children: 'a replay runs the 4 tools they asked for live' }));
    expect(drawn()).toContain('4\u00a0tools');
  });

  it('sets a dialog’s quiet clause after a dot by its measure, never one run glued past its row', async () => {
    await draw(createElement(DialogFacts, { rows: [{ label: 'As', value: 'part of the last user turn', quiet: '`claude-sonnet-5` · no system message mid-session' }] }));
    const clause = r!.one('.dph');
    expect(clause.textContent.replace(/\u00a0/g, ' ')).toBe('no system message mid-session');
    // set by Copy, which measures its row in a browser (browser/line-breaks.spec.ts reads it at 320); here, unmeasured, it glues as Words does
    expect(clause.children.map((c) => c.tagName)).toEqual(['SPAN']);
    expect(r!.one('small code').className).toBe('ts-code');
  });
});

describe('copy set by its parts', () => {
  it('gives a Copy its id and reads a docs link inside it as its words', async () => {
    await draw(createElement(Copy, { id: 'leadX', children: ['Runs your agent again from #5. ', createElement('a', { key: 'd', href: '#/docs' }, 'Forks in the docs →')] }));
    expect(r!.one('p').getAttribute('id')).toBe('leadX');
    expect(drawn().replace(/\u00a0/g, ' ')).toBe('Runs your agent again from #5. Forks in the docs →');
    expect(r!.one('ts-w.ts-a a').textContent).toBe('Forks in the docs →');
  });

  it('sets an empty state’s sentence, glued, unless it is a failure’s message the server wrote', async () => {
    await draw(createElement(EmptyState, { title: 'No goldens yet', text: 'Pack a run you trust: it passed in 3 of 4 attempts.' }));
    expect(drawn()).toContain('3\u00a0of\u00a04\u00a0attempts');
    await r!.unmount();
    await draw(createElement(EmptyState, { title: 'Not read', text: 'run_8f3a: not in the store after 3 of 4 tries', copy: false }));
    expect(r!.one('p').textContent).toBe('run_8f3a: not in the store after 3 of 4 tries');
  });

  it('keeps a fix title’s last clause whole from its conjunction, so a narrow heading breaks before it', async () => {
    await draw(createElement(FixTitle, { title: 'Customer emailed before the refund was issued' }));
    expect(r!.one('h1 .clause').textContent.replace(/\u00a0/g, ' ')).toBe('before the refund was issued');
    expect(r!.one('h1').textContent.replace(/\u00a0/g, ' ')).toBe('Customer emailed before the refund was issued');
    await r!.unmount();
    await draw(createElement(FixTitle, { title: 'issue_refund called with amount 240' }));
    expect(r!.all('.clause')).toEqual([]);
  });

  it('breaks a tool call’s arguments only after a comma or a brace, never before a space, its short values whole', () => {
    const markup = (code: string) => renderToStaticMarkup(createElement(CodeText, { children: code }));
    expect(markup('{"order":"A-1042"}')).not.toContain('<wbr/>');
    const html = markup(JSON.stringify({ order: 'A-1042', reason: 'above the refund limit', amount: 240 }));
    // each piece nowrap, a break after its comma or the opening brace, the short quoted value whole in its piece
    expect(html).toMatch(/^<code class="ts-ct"><span class="nw">\{<\/span><wbr\/>/);
    expect(html).toMatch(/,<\/span><wbr\/>/);
    expect(html).not.toMatch(/<wbr\/>\s/);
    expect(html).toMatch(/<span class="nw">&quot;reason&quot;:&quot;above the refund limit&quot;,<\/span>/);
  });

  it('splits a toast at its dots, each part kept whole with its dot, all in the one words span', async () => {
    await draw(createElement('span', null, createElement(ToastWords, { text: 'Removed support-agent · nothing on disk changed', glued: true })));
    expect(r!.all('.tp').map((p) => p.textContent.replace(/\u00a0/g, ' '))).toEqual(['Removed support-agent ·', 'nothing on disk changed']);
  });

  it('never balances a block whose every word is kept whole: it sets it pretty', () => {
    const plan = planCopy([{ text: 'refund-in-limit escalate-over-limit send-email-once' }], { width: 30, text: (s) => s.length, atom: () => 0 });
    expect(plan.wrap).toBe('ts-pretty');
  });

  it('draws a command’s prompt as a $ the selection leaves out, kept with the program', async () => {
    await draw(createElement('pre', null, createElement(Command, { cmd: 'shadowlap store check --bucket s3://acme-runs' })));
    expect(r!.one('.cmdp > b').textContent).toBe('$');
    expect(r!.one('.cmdp').className).toBe('nw cmdp');
    expect(values('.cmdp > b', 'user-select')).toEqual(['none']);
    expect(values('.cmdp > b', '-webkit-user-select')).toEqual(['none']);
  });
});
