import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandParts, type CmdPiece } from '../ui/cmdline.js';
import { AttemptsCell, type Attempt } from '../ui/components/AttemptsCell.js';
import { PageHeader } from '../ui/components/bits.js';
import { CodeBox } from '../ui/components/CodeBox.js';
import { Code, CodeText, Command, Copy } from '../ui/components/Copy.js';
import { factOrder, factTip } from '../ui/components/Facts.js';
import { Id } from '../ui/components/Id.js';
import { Link } from '../ui/components/Link.js';
import { Section } from '../ui/components/Section.js';
import { SegmentedControl } from '../ui/components/Segmented.js';
import { EmptyLine, EmptyState, ErrorState, Skeleton } from '../ui/components/States.js';
import { Status, verdictTone } from '../ui/components/Status.js';
import { Switch } from '../ui/components/Switch.js';
import { glossed, Term } from '../ui/components/Term.js';
import { VerdictLine } from '../ui/components/VerdictLine.js';
import { GLOSSARY, glossPieces, termCard } from '../ui/glossary.js';
import { AppContext, type AppState } from '../ui/state.js';
import { codePieces, glue, greedyLines, inlineCodePieces, isShortCopy, sentences, setSentences, type Piece } from '../ui/typeset.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * The design system's shared parts (MISSING §16 One page language), each built once: a page's
 * header and facts, a section, a status and a verdict line, one switch and one segmented control,
 * the code box with its one Copy, a link, a run's id and its list form, a glossary term defined at
 * its first use, an attempts cell, the three states, and the render-time line-break parts. Drawn
 * here through test/ui-render.ts: their markup, what a screen reader is told, and their words.
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
/** What an element shows: its text but a hidden element's (a term's definition, for a screen reader), its no-break spaces as plain ones. */
const shown = (el: FakeElement): string => el.childNodes.map((n) => ('tagName' in n ? (n.hasAttribute('hidden') ? '' : shown(n)) : n.textContent)).join('').replace(/\u00a0/g, ' ');
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

describe('a page’s header and its facts', () => {
  it('draws the eyebrow, the title, one line and the actions, then the facts named by the page, money last', async () => {
    const facts = [
      { value: '$16.24', words: 'spent live', money: true, tip: { title: 'Spent live, the last 7 days', parts: ['$1.73 not re-spent'] }, was: '$0.44 last week' },
      { value: 4, words: 'failures reproduced', href: '#/fixes', tip: { title: 'Failures reproduced', parts: ['replayed exactly', '3 still open'] }, was: '1 last week' },
      { value: 1, words: 'fix verified', tone: 'ok' as const },
    ];
    await draw(createElement(PageHeader, { eyebrow: 'support-agent · this week', title: 'Overview', text: 'What failed, what got fixed and proven, and what it cost.', actions: createElement('button', { className: 'btn' }, 'Watch live'), facts }));
    const ph = r!.one('.ph');
    expect(ph.children.map((c) => c.className)).toEqual(['phl', 'actions']);
    expect(r!.one('.ph .eyebrow').textContent).toBe('support-agent · this week');
    // no square of its own: the eyebrow is words
    expect(r!.one('.ph .eyebrow').children).toEqual([]);
    expect(r!.one('.ph h1').textContent).toBe('Overview');
    const row = r!.one('section.metrics.pfacts');
    expect(row.getAttribute('aria-label')).toBe('Overview in figures');
    expect(row.children.map((m) => [m.tagName, m.querySelector('b')!.className, text(m)])).toEqual([
      ['A', '', '4failures reproduced'],
      ['SPAN', 'ok', '1fix verified'],
      ['SPAN', 'q', '$16.24spent live'],
    ]);
    expect(row.children[0].getAttribute('href')).toBe('#/fixes');
    // what each is made of and what it was before are on its hover, and nothing beside the figure
    expect(JSON.parse(row.children[0].getAttribute('data-tip')!)).toEqual({ t: 'Failures reproduced', s: 'replayed exactly · 3 still open · 1 last week' });
    expect(row.children[1].getAttribute('data-tip')).toBeNull();
  });

  it('orders money last and words a fact’s hover from its parts', () => {
    const order = factOrder([{ value: '$1', words: 'spent', money: true }, { value: 2, words: 'runs' }]);
    expect(order.map((f) => f.words)).toEqual(['runs', 'spent']);
    expect(factTip({ value: 1, words: 'x', was: '3 last week' })).toBe(JSON.stringify({ t: '', s: '3 last week' }));
  });

  it('has no facts row when the page gives none', async () => {
    await draw(createElement(PageHeader, { eyebrow: 'support-agent · goldens', title: 'Tests' }));
    expect(r!.all('.pfacts')).toEqual([]);
  });
});

describe('a section', () => {
  it('is a hairline section headed by its title, its sub and its actions in its header, no card and no landmark', async () => {
    await draw(createElement(Section, { title: 'Probes', sub: 'gate: rescue at 60%+', actions: createElement('a', { className: 'more', href: '#/runs' }, 'All runs') }, createElement('table', { className: 't' })));
    const s = r!.one('section');
    expect(s.className).toBe('panel sec');
    // its heading gives the page its outline; named, every section would be a region of its own
    expect([s.getAttribute('aria-labelledby'), s.getAttribute('aria-label')]).toEqual([null, null]);
    expect(r!.one('section header h2').textContent).toBe('Probes');
    expect(r!.one('header .sub').textContent).toBe('gate: rescue at 60%+');
    expect(r!.one('header .actions a').textContent).toBe('All runs');
    expect(s.children.map((c) => c.tagName)).toEqual(['HEADER', 'TABLE']);
  });
});

describe('a status and a verdict line', () => {
  it('draws a status as a dot and a word in the word’s tone', async () => {
    await draw(createElement('div', null, createElement(Status, { tone: 'ok', children: 'passed' }), createElement(Status, { tone: 'warn', tip: '{"t":"why"}', children: 'inconclusive' })));
    const [ok, warn] = r!.all('.st');
    expect([ok.className, ok.textContent, ok.children[0].getAttribute('aria-hidden')]).toEqual(['st ok', 'passed', 'true']);
    expect([warn.className, warn.getAttribute('data-tip')]).toEqual(['st warn', '{"t":"why"}']);
  });

  it('takes a verdict word’s tone from decision 9’s vocabulary', () => {
    expect(['passed', 'rescued', 'fixed', 'kept', 'accepted'].map(verdictTone)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(['inconclusive', 'unsettled', 'stopped'].map(verdictTone)).toEqual(['warn', 'warn', 'warn']);
    expect(['failed', 'lost', 'not fixed', 'broken', 'rejected'].map(verdictTone)).toEqual(['err', 'err', 'err', 'err', 'err']);
    expect(verdictTone('not applicable')).toBe('mu');
  });

  it('leads a verdict with its word in its colour, then the sentence in a heading that names the word too, its facts under it and its step at the right', async () => {
    const step = createElement('button', { className: 'btn lime' }, 'Find breaking commit');
    await draw(createElement(VerdictLine, { word: 'failed', tone: 'err', facts: 'shadowlap test · 10:02', actions: step, children: '3 of 7 goldens passed · refund-in-limit diverged at call 1' }));
    const v = r!.one('.verdict');
    expect(v.className).toBe('verdict');
    expect(v.children.map((c) => c.className)).toEqual(['vw err', '', 'actions']);
    expect(v.children[0].getAttribute('aria-hidden')).toBe('true');
    // a screen reader moving by headings hears the word with the sentence
    expect(text(r!.one('.verdict h2'))).toBe('failed 3 of 7 goldens passed · refund-in-limit diverged at call 1');
    // a sentence given as text is glued, a golden's name kept whole; its facts keep their spaces as they are
    expect(r!.one('.verdict h2').textContent).toContain('3\u00a0of\u00a07\u00a0goldens');
    expect(r!.all('.verdict h2 ts-w').map((w) => w.textContent)).toEqual(['refund-in-limit']);
    expect(r!.one('.verdict h2 .sr').textContent).toBe('failed ');
    expect(r!.one('.verdict p').textContent).toBe('shadowlap test · 10:02');
    expect(r!.one('.verdict p').textContent).not.toContain('\u00a0');
    expect(r!.one('.verdict .actions button').textContent).toBe('Find breaking commit');
  });

  it('draws a report’s own verdict a step smaller, its heading an h3', async () => {
    await draw(createElement(VerdictLine, { word: 'passed', tone: 'ok', report: true, children: 'every check held' }));
    expect(r!.one('.verdict').className).toBe('verdict gv');
    expect(r!.all('.verdict h2')).toEqual([]);
    expect(text(r!.one('.verdict h3'))).toBe('passed every check held');
  });
});

describe('the choice controls', () => {
  it('draws one switch: a button with the switch role that keeps the focus as it toggles', async () => {
    const seen: boolean[] = [];
    await draw(createElement(Switch, { on: false, onChange: (v: boolean) => void seen.push(v) }, 'Format JSON'));
    const sw = r!.one('button.switch');
    expect([sw.getAttribute('role'), sw.getAttribute('aria-checked'), sw.getAttribute('type'), sw.textContent]).toEqual(['switch', 'false', 'button', 'Format JSON']);
    // its words name it, so no label of its own
    expect(sw.getAttribute('aria-label')).toBeNull();
    await r!.click(sw);
    expect(seen).toEqual([true]);
    expect(r!.focused()).toBe(sw);
  });

  it('names a switch with no words beside it by its label, or by its row', async () => {
    await draw(createElement('div', null, createElement(Switch, { on: true, onChange: () => undefined, label: 'Alerts' }), createElement(Switch, { on: false, onChange: () => undefined, labelledBy: 'ci-alerts-name', describedBy: 'ci-alerts-help', disabled: true, title: 'Read-only' })));
    const [a, b] = r!.all('.switch');
    expect([a.getAttribute('aria-label'), a.getAttribute('aria-checked')]).toEqual(['Alerts', 'true']);
    expect([b.getAttribute('aria-labelledby'), b.getAttribute('aria-describedby'), b.disabled, b.getAttribute('title')]).toEqual(['ci-alerts-name', 'ci-alerts-help', true, 'Read-only']);
  });

  it('draws a segmented control as pressed options in a named group', async () => {
    const seen: string[] = [];
    const items = [
      { key: 'chart', label: 'Chart' },
      { key: 'table', label: 'Table' },
    ] as const;
    await draw(createElement(SegmentedControl<'chart' | 'table'>, { items, value: 'chart', onChange: (k) => void seen.push(k), label: 'Show as' }));
    expect(r!.one('.seg').getAttribute('role')).toBe('group');
    expect(r!.one('.seg').getAttribute('aria-label')).toBe('Show as');
    expect(r!.all('.seg button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Chart', 'true'],
      ['Table', 'false'],
    ]);
    await r!.click(r!.byText('.seg button', 'Table'));
    expect(seen).toEqual(['table']);
  });
});

describe('the code box', () => {
  const writes: string[] = [];
  const clipboard = () => {
    writes.length = 0;
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) } });
  };

  it('copies a command with one Copy named by what it copies, never the $, and says so with the article', async () => {
    clipboard();
    await draw(createElement(CodeBox, { command: 'shadowlap blame 01K5CQ4N7G --expect \'{"tools":{"send_email":1}}\'' }));
    const copy = r!.one('.cmdline button.boxcopy');
    expect(r!.one('.cmdline').children[0]).toBe(copy);
    expect(copy.getAttribute('aria-label')).toBe('Copy command');
    expect(JSON.parse(copy.getAttribute('data-tip')!)).toEqual({ t: 'Copy command' });
    // the prompt sits with the program, never copied with it
    expect(r!.one('.cmdline .cmdp').textContent).toBe('$shadowlap');
    await r!.click(copy);
    await r!.wait(0);
    expect(writes).toEqual(['shadowlap blame 01K5CQ4N7G --expect \'{"tools":{"send_email":1}}\'']);
    expect(said).toEqual(['Copied the command']);
    expect(r!.all('button')).toHaveLength(1);
  });

  it('copies several commands one a line, the whole one where it shows a shortened one, and names what the box says it holds', async () => {
    clipboard();
    await draw(createElement('div', null, createElement(CodeBox, { command: ['cd agent', 'shadowlap run -- node agent.mjs'] }), createElement(CodeBox, { command: 'shadowlap check 01K… 01M…', full: 'shadowlap check 01K5CQ4N7G 01M5GRZKRY' }), createElement(CodeBox, { command: 'shadowlap policy show', what: 'the policy' })));
    const [many, cut, policy] = r!.all('button.boxcopy');
    expect([many, cut, policy].map((b) => b.getAttribute('aria-label'))).toEqual(['Copy commands', 'Copy whole command', 'Copy policy']);
    expect(r!.all('.cmdline .cstep').map((s) => s.textContent)).toEqual(['$cd agent', '$shadowlap run -- node agent.mjs']);
    await r!.click(many);
    await r!.click(cut);
    await r!.click(policy);
    await r!.wait(0);
    expect(writes).toEqual(['cd agent\nshadowlap run -- node agent.mjs', 'shadowlap check 01K5CQ4N7G 01M5GRZKRY', 'shadowlap policy show']);
    expect(said).toEqual(['Copied the commands', 'Copied the whole command', 'Copied the policy']);
  });

  it('puts a block’s Copy in its corner, a file’s at the end of its header, and none on a box that shows a change', async () => {
    clipboard();
    await draw(createElement('div', null, createElement(CodeBox, { code: '{"a":1}' }), createElement(CodeBox, { file: '.github/workflows/goldens.yml', code: 'on: push', what: 'the CI step' }), createElement(CodeBox, { code: '+ store', change: true })));
    expect(r!.one('.boxwrap button.boxcopy').getAttribute('aria-label')).toBe('Copy code');
    expect(r!.one('.codewrap .codehead span').textContent).toBe('.github/workflows/goldens.yml');
    expect(r!.one('.codewrap .codehead button').textContent).toBe('Copy CI step');
    expect(r!.all('pre.codebox')).toHaveLength(3);
    expect(r!.all('button')).toHaveLength(2);
    await r!.click(r!.one('.codewrap .codehead button'));
    await r!.wait(0);
    expect(writes).toEqual(['on: push']);
    expect(said).toEqual(['Copied the CI step']);
  });
});

describe('a link and a run’s id', () => {
  it('reads a link in ink, one that names where it goes ending in a → kept with its last word', async () => {
    await draw(createElement('p', null, createElement(Link, { href: '#/runs', to: true, children: 'All runs' }), createElement(Link, { href: '#/run/01K', quiet: true, children: 'its parent' })));
    const [to, quiet] = r!.all('a');
    expect([to.className, to.textContent]).toEqual(['more', 'All runs\u00a0→']);
    expect(quiet.className).toBe('dlink');
  });

  it('keeps a list’s id one text, the id as it is, so it copies, searches and reads whole', async () => {
    await draw(createElement('div', null, createElement(Id, { id: '01K5CQ6L0P', list: true, about: 'Refund the order' }), createElement(Id, { id: '01K5CQ8S2C', list: true, href: '#/run/01K5CQ8S2C' })));
    const [plain, linked] = r!.all('code.rnm');
    expect(plain.className).toBe('rnm rl');
    // no element inside it: the quiet part is drawn by its ground, and a screen reader is told the whole id
    expect(plain.childNodes.map((n) => n.textContent)).toEqual(['01K5CQ6L0P']);
    expect(plain.children).toEqual([]);
    expect(plain.getAttribute('aria-hidden')).toBeNull();
    expect(plain.getAttribute('title')).toBe('Refund the order');
    expect(linked.parentNode!.className).toBe('more rlink');
    expect(linked.parentNode!.getAttribute('href')).toBe('#/run/01K5CQ8S2C');
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

  it('defines the word on a tap without opening the row it sits in', async () => {
    const opened: string[] = [];
    await draw(createElement('div', { className: 'page' }, createElement('p', { onClick: () => void opened.push('row') }, createElement(Term, { k: 'kept' }), ' and ', createElement(Term, { k: 'kept' }))));
    await r!.wait(0);
    const [defined, plain] = r!.all('.term');
    await r!.click(defined);
    expect(opened).toEqual([]);
    await r!.click(plain);
    expect(opened).toEqual(['row']);
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

describe('an attempts cell', () => {
  const runs = (n: number, failed: number[] = [], unsure: number[] = []): Attempt[] =>
    Array.from({ length: n }, (_, i) => ({ runId: `01M5GRZK${String(i).padStart(2, '0')}`, href: `#/run/01M5GRZK${String(i).padStart(2, '0')}`, outcome: failed.includes(i) ? 'failed' : unsure.includes(i) ? 'inconclusive' : 'passed', note: failed.includes(i) ? 'issue_refund called' : null }));

  it('draws the tally and its bound whole, the interval’s bar, and the attempts on request', async () => {
    await draw(createElement('div', { className: 'page' }, createElement(AttemptsCell, { tally: '3 of 4', bound: 'rate >= 0.30 (95%)', interval: { lo: 0.3, hi: 0.99 }, marks: [0.1, 0.6], tone: 'ok', attempts: runs(4, [2]) })));
    await r!.wait(0);
    expect(r!.one('.acell').children.filter((c) => c.className === 'nw').map(shown)).toEqual(['3 of 4 ·', 'rate >= 0.30 (95%)']);
    // the bound, the first on the page, is the defined term
    expect(r!.one('.acell .term.on').getAttribute('data-term')).toBe('bound');
    expect(r!.one('.acell .ibx .wib').className).toBe('wib ok');
    const toggle = r!.one('.acell .xbtn');
    expect([toggle.getAttribute('aria-expanded'), toggle.getAttribute('aria-label'), toggle.getAttribute('aria-controls')]).toEqual(['false', 'Show 4 attempts', null]);
    expect(r!.all('.alist')).toEqual([]);
    await r!.click(toggle);
    expect([toggle.getAttribute('aria-expanded'), toggle.getAttribute('aria-label')]).toEqual(['true', 'Hide 4 attempts']);
    const list = r!.one('.alist');
    expect(toggle.getAttribute('aria-controls')).toBe(list.getAttribute('id'));
    expect(r!.all('.alist .al').map((l) => [l.children[0].className, l.querySelector('a')!.getAttribute('href'), text(l)])).toEqual([
      ['', '#/run/01M5GRZK00', '01M5GRZK00 · passed'],
      ['', '#/run/01M5GRZK01', '01M5GRZK01 · passed'],
      ['no', '#/run/01M5GRZK02', '01M5GRZK02 · issue_refund called · failed'],
      ['', '#/run/01M5GRZK03', '01M5GRZK03 · passed'],
    ]);
  });

  it('draws more than six attempts a cell each, with lines for the first that failed', async () => {
    await draw(createElement(AttemptsCell, { tally: '9 of 12', bound: 'rate 0.43 to 0.95 (95%)', interval: { lo: 0.43, hi: 0.95 }, marks: [0.7, 0.9], tone: 'warn', attempts: runs(12, [1, 4, 7], [10]) }));
    expect(r!.one('.wib').className).toBe('wib y');
    await r!.click(r!.one('.xbtn'));
    const cells = r!.all('.astrip a.ac');
    expect(cells.map((c) => c.className)).toEqual(['ac', 'ac no', 'ac', 'ac', 'ac no', 'ac', 'ac', 'ac no', 'ac', 'ac', 'ac inc', 'ac']);
    expect(cells[1].getAttribute('aria-label')).toBe('Attempt 2, 01M5GRZK01, failed, issue_refund called');
    expect(r!.one('.astrip').getAttribute('aria-label')).toBe('12 attempts, each opens its run');
    expect(r!.all('.alist .al').map((l) => l.querySelector('code')!.textContent)).toEqual(['01M5GRZK10', '01M5GRZK01', '01M5GRZK04']);
    expect(r!.one('.alist .more2').textContent).toBe('1 more failed · 8 passed · each attempt is a cell above');
  });

  it('leaves the list to a row that holds the toggle, and draws no bar where no gate decided', async () => {
    const seen: boolean[] = [];
    await draw(createElement(AttemptsCell, { tally: '2 of 2 passed, attempt 3 not judged', tone: 'warn', attempts: runs(3), open: false, onToggle: (o: boolean) => void seen.push(o), listId: 'v-1' }));
    expect(r!.all('.wib')).toEqual([]);
    await r!.click(r!.one('.xbtn'));
    expect(seen).toEqual([true]);
    expect(r!.all('.alist')).toEqual([]);
  });
});

describe('the three states', () => {
  it('says nothing is here yet in a section: its heading, a sentence, the one step and the command quiet under it', async () => {
    await draw(createElement(EmptyState, { title: 'No runs yet', text: 'Every recording shows here.', step: createElement('a', { className: 'btn lime', href: '#/' }, 'Set up triage-bot'), command: 'shadowlap run -- <command>' }));
    const s = r!.one('section.panel.stepempty');
    expect(r!.one('.stepempty h2').textContent).toBe('No runs yet');
    expect(text(r!.one('.stepempty p'))).toBe('Every recording shows here.');
    // its sentence set as copy is: kept whole on its line
    expect(r!.all('.stepempty p ts-s').map((x) => x.className)).toEqual(['snt']);
    expect(r!.one('.stepempty .actions a').textContent).toBe('Set up triage-bot');
    expect(r!.one('.stepempty .cli').textContent).toBe('or in a terminal$ shadowlap run -- <command>');
    expect(s.querySelector('.cmdline')).toBeNull();
  });

  it('gives the command its box where there is no step, and says a list that matches nothing in a line', async () => {
    await draw(createElement('div', null, createElement(EmptyState, { title: 'No goldens yet', text: 'Pack a run.', command: 'shadowlap pack 01K --name escalates' }), createElement(EmptyLine, null, 'No runs match.')));
    expect(r!.one('.stepempty .cmdline button.boxcopy').getAttribute('aria-label')).toBe('Copy command');
    expect(r!.one('p.emptyline').textContent).toBe('No runs match.');
  });

  it('draws what is loading as quiet bars, or as its own shape held still, and says what loads', async () => {
    await draw(createElement('div', null, createElement(Skeleton, { what: 'the goldens', title: 'Goldens', lines: 4 }), createElement(Skeleton, { what: 'the runs' }, createElement('table', { className: 't' }))));
    const [bars, shape] = r!.all('.skel');
    expect([bars.className, bars.getAttribute('aria-busy')]).toEqual(['panel sec skel', 'true']);
    expect(bars.querySelector('[role="status"]')!.textContent).toBe('Loading the goldens…');
    expect(bars.querySelector('header h2')!.textContent).toBe('Goldens');
    expect(bars.querySelectorAll('.skbars i')).toHaveLength(4);
    expect(shape.className).toBe('skel');
    const skin = shape.querySelector('.skin')!;
    expect([skin.hasAttribute('inert'), skin.getAttribute('aria-hidden')]).toEqual([true, 'true']);
  });

  it('says what couldn’t be read in a line, its word first, and Retry waits for the server', async () => {
    const tried: number[] = [];
    await draw(createElement(ErrorState, { retry: () => void tried.push(1), children: 'The goldens didn’t come from the dashboard server.' }));
    const line = r!.one('.loaderr');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.querySelector('.st.err')!.textContent).toBe('couldn’t load');
    expect(line.querySelector('p span:not(.st)')!.textContent).toBe('The goldens didn’t come from the dashboard server.');
    await r!.click(r!.byText('.loaderr button', 'Retry'));
    expect([guarded, tried]).toEqual([['guard'], [1]]);
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
