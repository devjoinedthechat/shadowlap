import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CLEAN_GATE, cleanRule } from '@shadowlap/engine';
import { PageHeader } from '../ui/components/bits.js';
import { Code, CODE_SET, CodeText, Command, Copy, LongWord, Words } from '../ui/components/Copy.js';
import { Dialog } from '../ui/components/Dialog.js';
import { DialogFacts, DialogSteps } from '../ui/components/DialogFacts.js';
import { DotParts } from '../ui/components/DotParts.js';
import { namedIn } from '../ui/components/Id.js';
import { EmptyState } from '../ui/components/States.js';
import { ToastWords } from '../ui/components/Toast.js';
import { dotParts, RuleText } from '../ui/components/Verdict.js';
import { FixTitle } from '../ui/fixes/parts.js';
import { EditorButton } from '../ui/revert/EditorButton.js';
import { AppContext, type AppState } from '../ui/state.js';
import { planCopy } from '../ui/typeset-lines.js';
import { SMALL } from '../ui/typeset.js';
import { styleRules } from './css-sheet.js';
import { shell } from './ui-overlays-page.js';
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

  it('keeps an agent’s scope tag whole on its line, and in the inspector’s one-line head lets it give way as the call’s name does', () => {
    expect(values('.scopetag', 'white-space')).toEqual(['nowrap']);
    expect([values('.ihead .scopetag', 'min-width'), values('.ihead .scopetag', 'overflow'), values('.ihead .scopetag', 'text-overflow')]).toEqual([['0'], ['hidden'], ['ellipsis']]);
  });

  it('sets an opened cell’s messages each under its role at 340px and under, so a short tool call’s arguments kept whole fit inside the cell', () => {
    const stacked = rules.filter((x) => x.selectors.includes('.dconv .msg') && x.conditions.some((c) => /max-width:\s*340px/.test(c)));
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

  it('keeps a small word with the name in code after it in a dialog’s quiet part, so the name never ends its row alone', async () => {
    await draw(createElement(DialogFacts, { rows: [{ label: 'Config', value: 'unchanged', quiet: 'the fix keeps its check in the store, not in `shadowlap.config.json`' }] }));
    const quiet = r!.one('small');
    expect(quiet.textContent.replace(/\u00a0/g, ' ')).toBe('the fix keeps its check in the store, not in shadowlap.config.json');
    expect(quiet.textContent).toContain('in\u00a0shadowlap.config.json');
    expect(r!.one('small code').className).toBe('ts-code');
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

  it('draws a key with a URL in a tool call’s arguments whole where its line holds it, and else broken after a dot or a slash, so it never runs past a run’s inspector at 320', () => {
    const markup = (code: string) => renderToStaticMarkup(createElement(CodeText, { children: code }));
    // 30 characters with its brace, 216px in the inspector's 12px code, where a line at 320 holds 210
    const html = markup('{"url":"https://example.com/a"}');
    expect(html).toMatch(/^<code class="ts-ct"><span class="nw">\{<\/span><wbr\/><ts-w class="ts-long">/);
    expect([...html.matchAll(/<ts-p class="ts-seg">([^<]*)<\/ts-p>/g)].map((m) => m[1].replace(/&quot;/g, '"'))).toEqual(['"url":"https://example.', 'com/', 'a"}']);
    expect(html).not.toContain('class="nw">&quot;url');
    // one that a line holds, or with nowhere to break, stays one nowrap piece
    expect(markup('{"query":"shadowlap replay"}')).toBe('<code class="ts-ct"><span class="nw">{&quot;query&quot;:&quot;shadowlap replay&quot;}</span></code>');
    expect(markup('{"path":"notes.md"}')).toBe('<code class="ts-ct"><span class="nw">{&quot;path&quot;:&quot;notes.md&quot;}</span></code>');
  });

  it('draws a tool call’s arguments past a few lines as written, one text a browser breaks where it must, never thousands of pieces', () => {
    const say = { path: 'notes/refund.md', content: 'The refund went out above the limit, so it waits for a manager. '.repeat(40) };
    const json = JSON.stringify(say);
    expect(json.length).toBeGreaterThan(CODE_SET);
    expect(renderToStaticMarkup(createElement(CodeText, { children: json }))).toBe(`<code class="ts-ct long">${json.replace(/"/g, '&quot;')}</code>`);
    expect(values('code.ts-ct.long', 'overflow-wrap')).toEqual(['anywhere']);
    // up to the cap it is still set in pieces
    expect(renderToStaticMarkup(createElement(CodeText, { children: json.slice(0, CODE_SET) }))).toContain('<span class="nw">');
  });

  it('splits a toast at its dots, each part kept whole with its dot, all in the one words span', async () => {
    await draw(createElement('span', null, createElement(ToastWords, { text: 'Removed support-agent · nothing on disk changed', glued: true })));
    expect(r!.all('.tp').map((p) => p.textContent.replace(/\u00a0/g, ' '))).toEqual(['Removed support-agent ·', 'nothing on disk changed']);
  });

  it('never balances a block whose every word is kept whole: it sets it pretty', () => {
    const plan = planCopy([{ text: 'refund-in-limit escalate-over-limit send-email-once' }], { width: 30, text: (s) => s.length, atom: () => 0 });
    expect(plan.wrap).toBe('ts-pretty');
  });

  it('glues a page’s string title by Words and sets its lead by Copy, unless the lead is a message the server wrote', async () => {
    await draw(createElement(PageHeader, { title: 'Runs of the support agent', text: 'It passed in 3 of 4 attempts. Open one to see why.' }));
    expect([r!.one('h1').textContent.includes('\u00a0'), r!.one('h1').textContent.replace(/\u00a0/g, ' ')]).toEqual([true, 'Runs of the support agent']);
    expect(r!.one('.ph p').textContent).toContain('3\u00a0of\u00a04\u00a0attempts');
    // each sentence a unit of its own, which a screen reader reads on as one paragraph
    expect(r!.one('.ph p').children.map((c) => [c.tagName, c.className, c.getAttribute('role')])).toEqual([
      ['TS-S', 'snt', 'none'],
      ['TS-S', 'snt', 'none'],
    ]);
    await r!.unmount();
    await draw(createElement(PageHeader, { title: 'Can’t open support-agent', text: 'run_8f3a: not in the store after 3 of 4 tries', copy: false }));
    expect(r!.one('.ph p').textContent).toBe('run_8f3a: not in the store after 3 of 4 tries');
  });

  it('describes a dialog by its lead as written, in a hidden span read last, and shows the lead set', async () => {
    const lead = 'Runs 3 of 4 tools live from the fork.';
    await draw(shell({}, createElement(Dialog, { key: 'd', title: 'Fork from #5', lead, warn: { text: 'Spends about $0.40 of your key.' }, ok: 'Fork', onOk: () => undefined, onClose: () => undefined })));
    const [written, shown] = r!.all('[role="dialog"] header p > span');
    const ids = (r!.one('[role="dialog"]').getAttribute('aria-describedby') ?? '').split(' ');
    expect([written.props['hidden'], written.textContent, ids.at(-1), ids[0]]).toEqual([true, lead, written.getAttribute('id'), r!.one('.dwarn').getAttribute('id')]);
    expect(shown.textContent).toContain('3\u00a0of\u00a04\u00a0tools');
  });

  it('glues a dialog row’s value and a step’s what and where, so a count stays with its noun', async () => {
    const facts = createElement(DialogFacts, { key: 'f', rows: [{ label: 'Attempts', value: 'passed in 3 of 4 attempts' }] });
    await draw(createElement('div', null, facts, createElement(DialogSteps, { key: 's', steps: [{ what: 'Replays 3 of 4 runs', where: 'on 2 machines' }] })));
    expect([r!.one('.dfacts dd').textContent, r!.one('.steps li > span').textContent, r!.one('.steps li > small').textContent]).toEqual([
      expect.stringContaining('3\u00a0of\u00a04\u00a0attempts'),
      expect.stringContaining('3\u00a0of\u00a04\u00a0runs'),
      expect.stringContaining('2\u00a0machines'),
    ]);
  });

  it('draws a command’s prompt as a $ the selection leaves out, kept with the program', async () => {
    await draw(createElement('pre', null, createElement(Command, { cmd: 'shadowlap store check --bucket s3://acme-runs' })));
    expect(r!.one('.cmdp > b').textContent).toBe('$');
    expect(r!.one('.cmdp').className).toBe('nw cmdp');
    expect(values('.cmdp > b', 'user-select')).toEqual(['none']);
    expect(values('.cmdp > b', '-webkit-user-select')).toEqual(['none']);
  });
});

describe('where a line may end', () => {
  it('never breaks before a phrase where a small word would end the line', () => {
    const lead = 'Adds the text after what the tool returned, and runs the agent on from there three times.';
    for (const width of [40, 44, 46]) {
      const plan = planCopy([{ text: lead }], { width, text: (s) => s.length, atom: () => 0 }, { phrases: true });
      const ends = (plan.units ?? []).map((u) => plan.text.slice(u.from, u.to).split(/[\s\u00a0]+/).at(-1)!.toLowerCase());
      expect([width, ends.filter((w) => SMALL.has(w)), plan.text.includes('on\u00a0from')]).toEqual([width, [], true]);
    }
  });

  it('sets a dialog’s title that names a run as copy, the name whole and the small word before it kept with it, named by its id', async () => {
    await draw(shell({}, createElement(Dialog, { key: 'd', title: namedIn('Find breaking commit for 01M7870JTF', '01M7870JTF'), ok: 'Find', onOk: () => undefined, onClose: () => undefined })));
    const h3 = r!.one('[role="dialog"] header h3');
    expect([h3.getAttribute('id'), h3.textContent.replace(/\u00a0/g, ' '), r!.one('[role="dialog"] header h3 code').textContent]).toEqual([r!.one('[role="dialog"]').getAttribute('aria-labelledby'), 'Find breaking commit for 01M7870JTF', '01M7870JTF']);
    expect(h3.textContent).toContain('for\u00a001M7870JTF');
  });

  it('keeps a history gate’s “from” with its last sessions, so no line ends on it', async () => {
    await draw(createElement('p', null, createElement(RuleText, { rule: 'fails a drop of 15+ points from its last 10 sessions once 95% likely, from 5 attempts up to 40' })));
    expect(drawn()).toContain('from\u00a0its\u00a0last\u00a010\u00a0sessions');
    expect(drawn()).toContain('from\u00a05\u00a0attempts\u00a0up\u00a0to\u00a040');
  });

  it('keeps a --clean gate’s figures with their words as the engine words its rule, so Find cause’s Gate row breaks only between them', async () => {
    await draw(createElement('p', null, createElement(RuleText, { rule: cleanRule(CLEAN_GATE)! })));
    for (const figure of ['tells a write gone in 80%+', 'of clean attempts', 'from one gone in 20%-,', 'at <= 5% risk', 'up to 10 attempts']) expect(drawn()).toContain(figure.replace(/ /g, '\u00a0'));
  });

  it('glues a dialog’s warning and each part of its cost line, and draws a warning the server wrote as written', async () => {
    const ask = { key: 'd', title: 'Pack', ok: 'Pack', onOk: () => undefined, onClose: () => undefined };
    await draw(shell({}, createElement(Dialog, { ...ask, warn: { text: 'It replays 3 of 4 runs live from the fork' }, cost: { price: 'About $0.40', parts: ['3 attempts from #5'] } })));
    expect(r!.one('.dwarn').textContent).toContain('3\u00a0of\u00a04\u00a0runs');
    expect(r!.all('.dcp').map((p) => p.textContent.replace(/ ·$/, ''))).toEqual([expect.stringContaining('About\u00a0$0.40'), expect.stringContaining('3\u00a0attempts')]);
    await r!.unmount();
    const said = 'shadowlap test goldens/x is running: pack it as a golden once it is done';
    await draw(shell({}, createElement(Dialog, { ...ask, warn: { text: said, written: true } })));
    expect(r!.one('.dwarn').textContent).toBe(said);
  });

  it('toasts an editor that wouldn’t open as an error, its message as the server wrote it', async () => {
    const toasts: unknown[][] = [];
    const app = { meta: { editor: 'code --goto <file>:<line>' }, exported: false, client: { editor: { open: () => Promise.reject(new Error('no editor: set $VISUAL or $EDITOR')) } }, toast: (...a: unknown[]) => toasts.push(a) } as unknown as AppState;
    await draw(createElement(AppContext.Provider, { value: app }, createElement(EditorButton, { change: { path: 'refund.py', line: 12 } })));
    await r!.click(r!.one('button'));
    await r!.until('the toast', () => toasts.length > 0);
    expect(toasts).toEqual([['no editor: set $VISUAL or $EDITOR', 'error']]);
  });
});
