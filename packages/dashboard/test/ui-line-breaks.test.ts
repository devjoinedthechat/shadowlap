import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Code, CodeText, LongWord, Words } from '../ui/components/Copy.js';
import { DialogFacts } from '../ui/components/DialogFacts.js';
import { DotParts } from '../ui/components/DotParts.js';
import { dotParts } from '../ui/components/Verdict.js';
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
