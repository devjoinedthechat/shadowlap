import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandParts, type CmdPiece } from '../ui/cmdline.js';
import { Code, CodeText, Command, Copy } from '../ui/components/Copy.js';
import { glossed, Term } from '../ui/components/Term.js';
import { GLOSSARY, glossPieces, termCard } from '../ui/glossary.js';
import { AppContext, type AppState } from '../ui/state.js';
import { codePieces, glue, greedyLines, inlineCodePieces, isShortCopy, sentences, setSentences, type Piece } from '../ui/typeset.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * The render-time line-break parts (MISSING §16 Line breaks) and the glossary: a short copy's
 * sentences, the no-break joins of rule 3, the lines a text sets in, inline code, a command and code
 * shown as text, each copying as written, and a word the glossary defines at its first use on a
 * page. Drawn here through test/ui-render.ts: their markup, what a screen reader is told, their words.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

const said: string[] = [];
const guarded: string[] = [];
function app(): AppState {
  said.length = 0;
  guarded.length = 0;
  return {
    toast: (t: string) => void said.push(t),
    guard: (fn: () => void) => {
      guarded.push('guard');
      fn();
    },
  } as unknown as AppState;
}
const inApp = (el: ReactElement) => createElement(AppContext.Provider, { value: app() }, el);
const draw = async (el: ReactElement) => (r = await render(inApp(el)));
/** An element's text, its no-break spaces as plain ones. */
const text = (el: FakeElement) => el.textContent.replace(/\u00a0/g, ' ');
/** Pieces drawn as text: a piece kept whole in brackets, a place to break `|`. */
const drawn = (pieces: ReadonlyArray<Piece | CmdPiece>) => pieces.map((p) => ('wbr' in p ? '|' : p.whole ? `[${p.text}]` : p.text)).join('');

describe('the glossary', () => {
  it('finds its words whole in a line, goldens as golden and a bound as one term, never inside a longer word or a name', () => {
    expect(glossPieces('lost at #5, blocked by the fork')).toEqual([{ term: 'lost', text: 'lost' }, ' at #5, ', { term: 'blocked', text: 'blocked' }, ' by the fork']);
    expect(glossPieces('3 goldens · rate >= 0.73 (95%)')).toEqual(['3 ', { term: 'golden', text: 'goldens' }, ' · ', { term: 'bound', text: 'rate >= 0.73 (95%)' }]);
    expect(glossPieces('rate\u00a00.56\u00a0to\u00a00.95\u00a0(95%) · not\u00a0re-spent')).toEqual([{ term: 'bound', text: 'rate\u00a00.56\u00a0to\u00a00.95\u00a0(95%)' }, ' · ', { term: 'not re-spent', text: 'not\u00a0re-spent' }]);
    expect(glossPieces('lost-at blockedness re-kept')).toEqual(['lost-at blockedness re-kept']);
  });

  it('heads a bound’s card with the bound as written, any other word’s with the word', () => {
    expect(termCard('bound', 'rate\u00a0>=\u00a00.73\u00a0(95%)')).toEqual({ t: 'rate >= 0.73 (95%)', s: GLOSSARY.bound });
    expect(termCard('stubbed', 'stubbed').t).toBe('stubbed');
    expect(GLOSSARY.stubbed).toBe('A write after the fork that never ran: the agent got a stand-in result back.');
  });
});

describe('a glossary term', () => {
  /** The element a term's aria-describedby names. */
  const definition = (term: FakeElement) => r!.all('[id]').find((x) => x.getAttribute('id') === term.getAttribute('aria-describedby'))!;

  it('defines a word at its first use on a page, on hover, to the keyboard and to a screen reader, and leaves the rest plain', async () => {
    await draw(createElement('div', { className: 'page' }, createElement('p', null, createElement(Term, { k: 'stubbed' })), createElement('p', null, 'send_email ', createElement(Term, { k: 'stubbed' }))));
    await r!.wait(0);
    const [first, later] = r!.all('.term');
    expect([first.className, first.getAttribute('tabindex'), first.getAttribute('data-term')]).toEqual(['term on', '0', 'stubbed']);
    expect(JSON.parse(first.getAttribute('data-tip')!)).toEqual({ t: 'stubbed', s: GLOSSARY.stubbed });
    const def = definition(first);
    expect(def.hasAttribute('hidden')).toBe(true);
    expect(def.textContent).toBe(GLOSSARY.stubbed);
    expect([later.className, later.getAttribute('tabindex'), later.getAttribute('aria-describedby'), later.getAttribute('data-tip')]).toEqual(['term', null, null, null]);
  });

  it('never defines one in a control or a place with a hover card of its own, and counts a dialog’s apart from the page’s', async () => {
    await draw(
      createElement(
        'div',
        { className: 'page' },
        createElement('button', null, createElement(Term, { k: 'lost' })),
        createElement('span', { 'data-tip': '{"t":"x"}' }, createElement(Term, { k: 'lost' })),
        createElement('p', null, createElement(Term, { k: 'lost' })),
        createElement('div', { className: 'dialog' }, createElement(Term, { k: 'lost' })),
      ),
    );
    await r!.wait(0);
    expect(r!.all('.term').map((t) => t.className)).toEqual(['term', 'term', 'term on', 'term on']);
  });

  it('defines the next use once the first goes, and heads a bound’s card with the bound', async () => {
    function Lines({ first }: { first: boolean }) {
      return createElement('div', { className: 'page' }, first ? createElement('p', { key: 'a' }, glossed('lost at #5')) : null, createElement('p', { key: 'b' }, glossed('lost · rate <= 0.49 (95%)')));
    }
    r = await render(inApp(createElement(Lines, { first: true })));
    await r.wait(0);
    expect(r.all('.term.on').map((t) => t.textContent)).toEqual(['lost', 'rate <= 0.49 (95%)']);
    expect(JSON.parse(r.all('.term.on')[1].getAttribute('data-tip')!).t).toBe('rate <= 0.49 (95%)');
    await r.unmount();
    r = await render(inApp(createElement(Lines, { first: false })));
    await r.wait(0);
    expect(r.all('.term.on').map((t) => t.textContent)).toEqual(['lost', 'rate <= 0.49 (95%)']);
  });
});

describe('sentences and glue', () => {
  it('finds a short copy’s sentences, never after an abbreviation or inside a quotation', () => {
    expect(sentences('Connect a bucket you own, push your runs and add CI. About fifteen minutes, with nothing to install or host.')).toEqual(['Connect a bucket you own, push your runs and add CI.', 'About fifteen minutes, with nothing to install or host.']);
    expect(sentences('Use a flag, e.g. --fail-at. It forks there.')).toEqual(['Use a flag, e.g. --fail-at.', 'It forks there.']);
    expect(sentences('It answered “Done. Refunded.” Then it stopped.')).toEqual(['It answered “Done. Refunded.”', 'Then it stopped.']);
    expect(sentences('It cost $0.34. 3 runs failed.')).toEqual(['It cost $0.34.', '3 runs failed.']);
    expect(sentences('version 0.1.0 ships')).toEqual(['version 0.1.0 ships']);
    expect(isShortCopy('One. Two. Three. Four.')).toBe(true);
    expect(isShortCopy('One. Two. Three. Four. Five.')).toBe(false);
  });

  it('joins what belongs together with a no-break space: a number and its unit, a tally, a separator, a small word, the last two words', () => {
    const joins = (s: string) => glue(s).replace(/\u00a0/g, '~');
    expect(joins('12 calls replayed')).toBe('12~calls~replayed');
    expect(joins('failed in 3 of 4 attempts')).toBe('failed in~3~of~4~attempts');
    expect(joins('Removed support-agent · nothing on disk changed')).toBe('Removed support-agent~· nothing on~disk~changed');
    expect(joins('the gate held at call 5 again')).toBe('the~gate held at~call~5~again');
    // an operator holds the word before it, and what follows it, so no line starts or ends on one
    expect(joins('amount 240 > limit 100 here')).toBe('amount 240~>~limit 100~here');
    expect(joins('open a pull request with --fail-at 5 now')).toBe('open a~pull~request with~--fail-at~5~now');
    // a clause's end always lets a line break, and a sentence's last two words hold
    expect(joins('Asked again, it escalated. Then it passed.')).toBe('Asked again, it~escalated. Then it~passed.');
  });

  it('gives up the weakest join of a run wider than its line, and a small word’s join where it costs a short block a line', () => {
    const fits = (s: string) => s.length <= 12;
    // "at call 5 again" is one run; it breaks at its weakest join, nearest its middle, where both sides fit
    expect(glue('held at call 5 again', { fits }).replace(/\u00a0/g, '~')).toBe('held at call~5~again');
    // two lines without the small words' joins, three with them: the small words give way
    const lines = (s: string) => Math.ceil(s.split(/ /).reduce((n, w) => n + w.length + 1, 0) / 24);
    expect(glue('for the 56 model calls in the run', { fits: () => true, lines }).includes('\u00a0in')).toBe(false);
  });

  it('counts the lines a text sets in, breaking at plain spaces only, and sets each sentence by them', () => {
    const w = (s: string) => s.length;
    expect(greedyLines('aaaa bbbb cccc', 9, w)).toBe(2);
    expect(greedyLines('aaaa\u00a0bbbb cccc', 9, w)).toBe(2);
    expect(greedyLines('aaaa bbbb', 20, w)).toBe(1);
    // a sentence that fits a line is whole; one of two lines balanced on its own line, or flowing where the line before it would be left under half full
    expect(setSentences([30, 150], [1, 2], 100, 4)).toEqual(['whole', 'flow']);
    expect(setSentences([60, 150], [1, 2], 100, 4)).toEqual(['whole', 'balanced']);
    expect(setSentences([300], [3], 100, 4)).toEqual(['flow']);
  });
});

describe('code, commands and code shown as text', () => {
  it('keeps short inline code whole, and lets a long path break only after a slash or a dot', () => {
    expect(drawn(inlineCodePieces('goldens/refund-in-limit'))).toBe('[goldens/refund-in-limit]');
    expect(drawn(inlineCodePieces('s3://northwind-agent-runs/support-agent/runs'))).toBe('[s3://]|[northwind-agent-runs/]|[support-agent/]|[runs]');
    expect(drawn(inlineCodePieces('shadowlap-db.northwind.internal.example.com'))).toBe('[shadowlap-db.]|[northwind.]|[internal.]|[example.]|[com]');
  });

  it('breaks code shown as text at its spaces and after its commas and braces, never before an operator or a number its word names', () => {
    expect(drawn(codePieces('check failed: issue_refund #6: amount 240 > get_policy.result.limit 100 (#4)'))).toBe('[check] [failed:] [issue_refund #6:] [amount 240 >] [get_policy.result.limit 100] [(#4)]');
    expect(drawn(codePieces('escalate({"reason":"above the refund limit","to":"tier 2"})'))).toBe('[escalate({]|["reason":"above the refund limit",]|["to":"tier 2"})]');
    expect(drawn(codePieces('{"amount":240}'))).toBe('[{"amount":240}]');
    // never a place to break right before a space, which offers the same break
    expect(codePieces('a, b').some((p, i, all) => 'wbr' in p && !('wbr' in (all[i + 1] ?? WBR_STOP)) && (all[i + 1] as { text: string }).text.startsWith(' '))).toBe(false);
  });

  it('keeps a command’s head whole and -- with the command it introduces', () => {
    const cmd = (c: string) => drawn(commandParts(c));
    expect(cmd(`shadowlap test 'goldens/*' --junit report.xml`)).toBe(`[shadowlap] [test 'goldens/*'] [--junit ][report.xml]`);
    expect(cmd('shadowlap run -- node agent.mjs')).toBe('[shadowlap] [run] [-- ][node] [agent.mjs]');
    expect(cmd('shadowlap blame 01K5CQ4N7G2W8XRM6E3V7NQB5D --expect x')).toBe('[shadowlap] [blame] [01K5CQ4N7G2W8XRM6E3V7NQB5D] [--expect ][x]');
    expect(commandParts('shadowlap test --update').map((p) => ('wbr' in p ? '' : p.text)).join('')).toBe('shadowlap test --update');
  });

  it('draws code, a command and code as text, each copying as written', async () => {
    await draw(createElement('div', null, createElement(Code, null, 'refund-in-limit'), createElement(Code, null, 's3://northwind-agent-runs/support-agent/runs'), createElement(Command, { cmd: 'shadowlap replay 01K5CQ4N7G', inline: true }), createElement(CodeText, null, 'amount 240 > limit 100')));
    const [short, long] = r!.all('code.ts-code, code.ts-cb');
    expect([short.className, short.textContent]).toEqual(['ts-code', 'refund-in-limit']);
    expect([long.className, long.textContent, long.querySelectorAll('wbr').length]).toEqual(['ts-cb', 's3://northwind-agent-runs/support-agent/runs', 3]);
    // set as code in a line, a command has no prompt unless it asks for one
    const command = r!.one('code.ts-cmd');
    expect(command.querySelector('b')).toBeNull();
    expect(command.textContent).toBe('shadowlap replay 01K5CQ4N7G');
    expect(r!.one('code.ts-ct').textContent).toBe('amount 240 > limit 100');
  });
});

describe('a piece of copy', () => {
  it('sets each sentence of short copy apart, its words glued and a hyphenated name kept whole, as one paragraph', async () => {
    await draw(createElement(Copy, { className: 'lead', children: 'Adds a check to refund-in-limit. It runs 3 of 4 attempts.' }));
    const p = r!.one('p.lead');
    const s = p.children.filter((c) => c.tagName === 'TS-S');
    expect(s.map((x) => [x.className, x.getAttribute('role')])).toEqual([
      ['snt', 'none'],
      ['snt', 'none'],
    ]);
    expect(r!.all('ts-w').map((w) => w.textContent)).toEqual(['refund-in-limit.']);
    expect(text(p)).toBe('Adds a check to refund-in-limit. It runs 3 of 4 attempts.');
    expect(p.textContent).toContain('3\u00a0of\u00a04\u00a0attempts.');
  });

  it('keeps longer prose as it flows', async () => {
    const long = 'One. Two. Three. Four. Five.';
    await draw(createElement(Copy, { as: 'div', children: long }));
    expect(r!.all('ts-s')).toEqual([]);
    expect(text(r!.one('div'))).toBe(long);
  });
});

/** A piece that ends a list of pieces, for reading the one after the last. */
const WBR_STOP: Piece = { text: '', whole: false };
