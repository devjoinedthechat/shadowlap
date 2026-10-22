import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { aboutForms, CUT, cutForms, fitLines, hintForms, orderForms, type FitLine } from '../ui/about.js';
import { AboutLine, FitHint } from '../ui/components/About.js';

/**
 * A run's about line, fitted by measured width at whole words (decision 10, the mock's cutForms,
 * byWidth and fitAbouts): its shorter forms keep its first words and its last, never part of a
 * word, never a small word at a cut, and a number when the line has one; a place takes the widest
 * form its room holds, else nothing.
 */

const SMALL = /^(a|an|the|of|for|to|from|and|or|in|on|at|by|with|my|our|your|their|is|was|it)$/i;
const before = (form: string) => form.split(CUT)[0]!.split(' ').at(-1)!;
const after = (form: string) => form.split(CUT)[1]?.trim().split(' ')[0] ?? null;

describe('the shorter forms of an about line', () => {
  const line = 'A customer asks for a refund of order A-1131';

  it('keep the first words and the last, whole, with "…" for what is left out', () => {
    const forms = cutForms(line);
    expect(forms).toContain(`A customer${CUT} order A-1131`);
    for (const f of forms) {
      expect(f.startsWith('A customer')).toBe(true);
      expect(f.startsWith('…')).toBe(false);
      // A small word never ends the first part or starts the last.
      expect(SMALL.test(before(f))).toBe(false);
      const a = after(f);
      if (a) expect(SMALL.test(a)).toBe(false);
      // The line names an order: every form keeps it.
      expect(f).toMatch(/A-1131/);
    }
  });

  it('end on their cut only right after a number, which they keep', () => {
    const forms = cutForms('Ticket T-8812 from customer C-311: order A-1042 ($240) arrived damaged');
    expect(forms).toContain(`Ticket T-8812${CUT}`);
    for (const f of forms.filter((x) => x.endsWith(CUT))) expect(before(f)).toMatch(/\d/);
    // An amount goes only with the order before it: no cut starts with it.
    for (const f of forms) expect(after(f)).not.toBe('($240)');
  });

  it('never cut what a replay or a fork changed, nor a clean replay: they give their place up whole', () => {
    expect(aboutForms({ text: 'override #16', from: 'change' })).toEqual(['override #16', '']);
    expect(aboutForms({ text: 'clean replay', from: 'nothing' })).toEqual(['clean replay', '']);
    const user = aboutForms({ text: line, from: 'user' });
    expect(user[0]).toBe(line);
    expect(user.at(-1)).toBe('');
  });

  it('are tried widest first, the forms that keep the line’s end before those that stop at a number', () => {
    const ordered = orderForms(['Ticket T-8812 arrived damaged today', `Ticket T-8812${CUT} damaged today`, `Ticket T-8812${CUT}`, `Ticket${CUT} today`, ''], (t) => t.length * 7);
    expect(ordered.map((f) => f.t)).toEqual(['Ticket T-8812 arrived damaged today', `Ticket T-8812${CUT} damaged today`, `Ticket${CUT} today`, `Ticket T-8812${CUT}`, '']);
  });

  it('for a command, cut it only at its end after a whole word, so an id is whole or left out', () => {
    expect(hintForms('shadowlap replay 01K5CQ4N7G')).toEqual(['shadowlap replay 01K5CQ4N7G', `shadowlap replay${CUT}`, `shadowlap${CUT}`, '']);
    expect(hintForms('shadowlap diff 01K5CQ4N7G 01K5CQ4P2R', 'against 01K5CQ4N7G')).toEqual(['shadowlap diff 01K5CQ4N7G 01K5CQ4P2R', 'against 01K5CQ4N7G', '']);
  });
});

describe('fitting a line to its room', () => {
  /** A line whose text is 7px a character, in a box `room` wide. */
  const fake = (text: string, room: number, from: 'user' | 'change' = 'user') => {
    const shown: string[] = [];
    const forms = orderForms(aboutForms({ text, from }), (t) => t.length * 7);
    const x: FitLine & { shown: string[] } = { forms, shown, write: (t) => shown.push(t), overflows: () => (shown.at(-1) ?? '').length * 7 > room + 0.25, room: () => room };
    return x;
  };

  it('writes every line whole, then gives each that overflows the widest form its room holds', () => {
    const wide = fake('A customer asks for a refund of order A-1131', 400);
    const narrow = fake('A customer asks for a refund of order A-1131', 190);
    fitLines([wide, narrow]);
    expect(wide.shown).toEqual(['A customer asks for a refund of order A-1131']);
    expect(narrow.shown[0]).toBe('A customer asks for a refund of order A-1131');
    const fitted = narrow.shown.at(-1)!;
    expect(fitted.length * 7).toBeLessThanOrEqual(190);
    expect(fitted).toContain(CUT);
    // The widest that fits: no other form is wider and still fits.
    for (const f of narrow.forms) if (f.w <= 190) expect(f.w).toBeLessThanOrEqual(fitted.length * 7);
  });

  it('gives its place up rather than show part of a word; a change is never cut', () => {
    const tiny = fake('A customer asks for a refund of order A-1131', 20);
    const change = fake('override #16', 40, 'change');
    fitLines([tiny, change]);
    expect(tiny.shown.at(-1)).toBe('');
    expect(change.shown.at(-1)).toBe('');
  });
});

describe('the about line in the page', () => {
  it('keeps the "…" of a cut with the word before it, so no line starts with it', () => {
    expect(CUT).toBe('\u00a0…');
    for (const f of cutForms('A customer asks for a refund of order A-1131')) expect(f).not.toMatch(/ …/);
  });

  it('draws one quiet line with all of it on hover, for the fitter; nothing for a run without one', () => {
    const html = renderToStaticMarkup(createElement(AboutLine, { about: { text: 'Hi, my order A-1042 arrived damaged', from: 'agent' } }));
    expect(html).toContain('class="rab"');
    expect(html).toContain('data-about="Hi, my order A-1042 arrived damaged"');
    expect(html).toContain('data-from="agent"');
    expect(html).toContain('title="Hi, my order A-1042 arrived damaged"');
    expect(renderToStaticMarkup(createElement(AboutLine, { about: null }))).toBe('');
    expect(renderToStaticMarkup(createElement(FitHint, { text: 'shadowlap replay 01K5CQ4N7G' }))).toContain('data-fit="shadowlap replay 01K5CQ4N7G"');
  });
});
