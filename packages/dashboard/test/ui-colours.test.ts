import { describe, expect, it } from 'vitest';
import { sheet, styleRules } from './css-sheet.js';

/**
 * Each colour means one thing (the mock's tokens): red only what failed or changed for real, amber
 * only what needs a look or is inconclusive, lime the primary action and passed. Where a call's
 * answer came from has colours of its own: replayed the logo's second colour, stubbed a steel blue,
 * a blocked write a neutral hatch, a failed call a red ring on its tint. A write is teal, its own
 * kind of call, never the failure red; money is a receipt, never amber; the blamed call is marked in
 * ink, since it rescued the run. Read from the stylesheet as the browser would: the last top-level
 * rule that names a selector wins.
 */

const css = sheet().replace(/\/\*[\s\S]*?\*\//g, '');

/** Every top-level rule (outside media queries): its selectors and its declarations. */
function rules(): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  let depth = 0;
  let start = 0;
  let head = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        head = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (!head.startsWith('@')) out.push({ selectors: head.split(',').map((x) => x.trim()), body: css.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return out;
}

/** The value a property takes on a selector at the top level, the last rule naming it winning: a list split as CSS splits it. */
function final(selector: string, prop: string): string | null {
  let found: string | null = null;
  for (const r of styleRules()) if (!r.conditions.length && r.selectors.includes(selector)) for (const [p, v] of r.decls) if (p === prop) found = v;
  return found;
}

/** The value a property takes on a selector, the last rule naming it winning. */
function value(selector: string, prop: string): string | null {
  let found: string | null = null;
  for (const r of rules()) {
    if (!r.selectors.includes(selector)) continue;
    for (const decl of r.body.split(';')) {
      const at = decl.indexOf(':');
      if (at > 0 && decl.slice(0, at).trim() === prop) found = decl.slice(at + 1).trim();
    }
  }
  return found;
}

describe('the colour tokens', () => {
  it('has consequence colours of their own, and a write’s deeper teal', () => {
    for (const token of ['--cq-red', '--cq-amber', '--cq-muted', '--cq-lime', '--k-write']) expect(value(':root', token), token).not.toBeNull();
    expect(value(':root', '--k-write')).toBe('#13ad9c');
    // An error is the one red, never a colour of its own.
    expect(value(':root', '--k-err')).toBe('var(--err)');
  });

  it('draws the grounds, tints and lines as the page’s ground with ink mixed in, darkest first', () => {
    const order = ['--bg2', '--panel', '--hover', '--raise', '--sel', '--line', '--line2', '--pop-edge', '--field'];
    const shares = order.map((t) => Number(/^color-mix\(in srgb, var\(--ink\) (\d+)%, var\(--bg\)\)$/.exec(value(':root', t) ?? '')?.[1]));
    expect(shares.every((n) => n > 0), order.join(' ')).toBe(true);
    expect([...shares].sort((a, b) => a - b)).toEqual(shares);
    expect(value(':root', '--pop')).toBe('var(--bg)');
    expect(value(':root', '--faint')).toBe('#8e8c79');
  });

  it('colours each origin as its own: replayed the logo’s second colour, stubbed steel blue, blocked neutral, failed the one red', () => {
    expect(value(':root', '--shadow')).toBe('#86ad12');
    expect(value(':root', '--o-rep')).toBe('var(--shadow)');
    expect(value(':root', '--o-stub')).toBe('#6fa3c7');
    expect(value(':root', '--o-block')).toBe('var(--dim)');
    expect(value(':root', '--o-fail')).toBe('var(--err)');
    // A diff's added text is ink on a faint ink ground; what it removes, the one red.
    expect(value(':root', '--add')).toBe('var(--ink)');
    expect(value(':root', '--del')).toBe('var(--err)');
  });
});

describe('where a call’s answer came from', () => {
  /** Every cell, bar and swatch an origin is drawn in. */
  const MARKS = ['.cells button', '.ms i', '.segbar i', '.oleg i', '.tl-row .bar', '.legend i.lg', '.org'];
  const mark = (m: string, o: string) => (m === '.org' ? '.org.' + o + ' i' : `${m}.${o}`);

  it('draws a recording’s calls by kind in the kind’s own token, in the strip, its key and the Timeline alike', () => {
    for (const m of ['.cells button', '.legend i.lg', '.tl-row .bar']) for (const k of ['k-model', 'k-read', 'k-write', 'k-err']) expect(value(`${m}.${k}`, 'background'), `${m}.${k}`).toBe(`var(--${k})`);
  });

  it('draws a blocked write as a neutral hatch, fenced by its outline where a mark is big enough to show one', () => {
    for (const m of MARKS) expect(value(mark(m, 'block'), 'background'), m).toBe('var(--o-block-fill)');
    for (const m of ['.cells button', '.segbar i', '.oleg i', '.tl-row .bar', '.legend i.lg', '.org']) expect(value(mark(m, 'block'), 'box-shadow'), m).toBe('inset 0 0 0 1px var(--o-block)');
    expect(value(':root', '--o-block-fill')).toMatch(/^repeating-linear-gradient\(135deg, var\(--o-block\)/);
    // under 6px, where the hatch can't draw, its tone as a solid
    expect(css).toMatch(/@container \(max-width: 5\.99px\) \{ :is\([^)]*\)\.block::before \{[^}]*background: var\(--o-block-solid\)/);
  });

  it('draws a failed call as its tint ringed in the one red, never a solid red that reads as replayed under deuteranopia', () => {
    for (const m of MARKS.filter((x) => x !== '.org')) expect(value(mark(m, 'fail'), 'background'), m).toBe('var(--o-fail-fill)');
    // a key's swatch rings it always; a cell, segment or bar from 6px wide, where the ring can show
    for (const m of ['.oleg i', '.legend i.lg']) expect(value(mark(m, 'fail'), 'box-shadow'), m).toBe('inset 0 0 0 1.5px var(--o-fail)');
    expect(css).toMatch(/@container \(min-width: 6px\) \{ :is\([^)]*\)\.fail::before \{[^}]*box-shadow: inset 0 0 0 1\.5px var\(--o-fail\)/);
  });

  it('keeps the replayed colour for a replayed call: a verdict is drawn in the consequence colours, a score and a finished step neutral', () => {
    for (const s of ['.pips i', '.st.ok i', '.attempts span i', '.attempts a i', '.alist > .al > i', '.astrip .ac', 'td.hist i.pass::before', '.prl i.ok', '.recline .ic']) expect(value(s, 'background'), s).toBe('var(--cq-lime)');
    for (const s of ['.pips i.no', '.attempts span i.no', '.attempts a i.no', '.alist > .al > i.no', '.astrip .ac.no']) expect(value(s, 'background'), s).toBe('var(--cq-red)');
    // The row of calls' key says each probe's word in its colour.
    expect(value('.fxleg .lw.ok', 'color')).toBe('var(--cq-lime)');
    expect(value('.fxleg .lw.lost', 'color')).toBe('var(--cq-red)');
    for (const s of ['.sbar i', '.stepper .done .k i', '.psk.done i']) expect(value(s, 'background'), s).toBe('var(--dim)');
    const misused = rules().filter((r) => /var\(--o-rep\)/.test(r.body) && !r.selectors.every((s) => /\.rep\b|\.clean\b|\.metric b\.lime|^:root$/.test(s)));
    expect(misused.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  it('draws a prompt’s cache reads in the quiet neutral, in the Context chart and the Overview’s cache bar alike', () => {
    expect(value(':root', '--c-read')).toBe('color-mix(in srgb, var(--ink) 40%, var(--panel))');
    expect(value('.segbar i.cread', 'background')).toBe('var(--c-read)');
  });
});

describe('what each colour may mean', () => {
  it('draws a write in teal, on the run page, in Compare and in Settings → Tools, never in the failure red', () => {
    expect(value('.eff.write', 'color')).toBe('var(--k-write)');
    expect(value('.tchip.w em', 'color')).toBe('var(--k-write)');
    // What a fork did differently: the change of rank 1 is a write, its words and its tool teal.
    expect(value('.fdiff li.r1 .rk', 'color')).toBe('var(--k-write)');
    expect(value('.fdiff b.w', 'color')).toBe('var(--k-write)');
  });

  it('marks a line the page has just written into a code box as a diff marks an added line: ink on the faint ink ground, across the box', () => {
    expect(value(':root', '--add-bg')).toBe('color-mix(in srgb, var(--ink) 9%, transparent)');
    expect(value('pre.codebox .add', 'background')).toBe('var(--add-bg)');
    expect(value('ol.setup .codebox .add', 'color')).toBe('var(--add)');
    // out to the box's edges, through the padding the box's own rule gives it
    const pad = value('.codebox', 'padding')!.split(' ')[1];
    expect(value('pre.codebox .add', 'margin')).toBe(`0 -${pad}`);
    expect(value('pre.codebox .add', 'padding')).toBe(`0 ${pad}`);
    expect(value('pre.codebox .add', 'min-width')).toBe(`calc(100% + ${2 * parseFloat(pad)}px)`);
  });

  it('dims what Compare shows the same in the faint ink, which keeps AA’s contrast, never by fading it', () => {
    expect(value('.pside.same', 'color')).toBe('var(--faint)');
    expect(value('.pside.same', 'opacity')).toBeNull();
  });

  it('dims what doesn’t apply in the faint ink, never by fading it, and keeps the bar’s words above AA on its amber', () => {
    // The shortcuts a page doesn't offer, and a CI feature turned off: faded, they fell to 2.2 and 4.0:1.
    expect(value('.hgroup.off dd', 'color')).toBe('var(--faint)');
    expect(value('.hgroup.off dd', 'opacity')).toBeNull();
    // A line single-key shortcuts turned off dims the same way, its key too.
    expect(value('.nosk .help .hgroup:not(.off) .sk', 'color')).toBe('var(--faint)');
    expect(value('.nosk .help .hgroup:not(.off) .sk', 'opacity')).toBeNull();
    expect(value('.nosk .help .hgroup:not(.off) .sk kbd', 'color')).toBe('var(--faint)');
    const faded = rules().filter((r) => r.selectors.some((x) => x.startsWith('.cip.off') || x.startsWith('.hgroup.off')) && /(^|;)\s*opacity\s*:/.test(r.body));
    expect(faded.map((r) => r.selectors.join(', '))).toEqual([]);
    // On the connection bar's amber wash the faint ink is 4.4:1: the dim one.
    expect(value('.connbar .cr', 'color')).toBe('var(--faint)');
  });

  it('keeps a segment, a fix step’s switch and an attempt’s line 24 px tall at least, as WCAG 2.5.8 asks of a target', () => {
    expect(value('.seg button', 'min-height')).toBe('24px');
    expect(value('.seg a', 'min-height')).toBe('24px');
    expect(value('.attempts a', 'min-height')).toBe('24px');
    // Needs a look's ×, drawn 22px, takes taps a pixel past its edge on each side: 24px.
    expect([value('.arow .adis', 'width'), value('.arow .adis', 'height'), value('.arow .adis', 'position')]).toEqual(['22px', '22px', 'relative']);
    expect([value('.arow .adis::after', 'position'), value('.arow .adis::after', 'inset')]).toEqual(['absolute', '-1px']);
  });

  it('mutes a dismissed row of Needs a look by its colours, never by fading it', () => {
    expect([value('.arow.off .t', 'color'), value('.arow.off .glyph', 'color')]).toEqual(['var(--dim)', 'var(--faint)']);
    const faded = rules().filter((r) => r.selectors.some((x) => x.startsWith('.arow.off')) && /(^|;)\s*opacity\s*:/.test(r.body));
    expect(faded.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  it('hides a × that waits (read-only, offline) at rest as one that runs, and shows it at half strength wherever it shows', () => {
    // The rule for what waits and is no button of its own style leaves the × to its own look, which hides it at rest.
    const waits = styleRules().filter((r) => r.selectors.some((x) => x.startsWith('[data-why][aria-disabled="true"]:not(')));
    expect(waits.flatMap((r) => r.selectors)).toEqual(['[data-why][aria-disabled="true"]:not(.btn, .linkbtn, .rk, .switch, .pop button, .adis)']);
    expect(value('.arow .adis', 'opacity')).toBe('0');
    for (const shown of ['.arow:hover .adis[aria-disabled="true"]', '.arow:focus-within .adis[aria-disabled="true"]', '.arow .adis[aria-disabled="true"]:focus-visible']) expect([value(shown, 'opacity'), value(shown, 'cursor')], shown).toEqual(['.5', 'not-allowed']);
    const touch = styleRules().filter((r) => r.conditions.some((c) => /hover:\s*none/.test(c)));
    expect(touch.find((r) => r.selectors.includes('.arow .adis'))?.decls).toEqual([['opacity', '1']]);
    expect(touch.find((r) => r.selectors.includes('.arow .adis[aria-disabled="true"]'))?.decls).toEqual([
      ['opacity', '.5'],
      ['cursor', 'not-allowed'],
    ]);
  });

  it('tags an untrusted read as its effect is tagged, never in a consequence colour, and marks an injection test in the colours of what it found', () => {
    // Where a read's text came from is a fact of the call, not a finding: dim, one step brighter than its effect's faint.
    expect(value('.eff.untrusted', 'color')).toBe('var(--dim)');
    expect(value('.eff', 'color')).toBe('var(--faint)');
    // The canary, wherever the inspector marks it, is what got out: the one red, on a tint of it.
    expect(value('mark.cnry', 'color')).toBe('var(--cq-red)');
    expect(value('mark.cnry', 'background')).toBe('color-mix(in srgb, var(--cq-red) 16%, transparent)');
    expect(value('.cnry', 'color')).toBe('var(--cq-red)');
    // The planted text is the planted origin's violet, as the turn it changed is: an override, not a failure.
    expect(value('mark.ins-plant', 'color')).toBe('var(--o-over)');
    expect(value('mark.ins-plant', 'background')).toBe('color-mix(in srgb, var(--o-over) 14%, transparent)');
    expect(value('.msg.changed.ov .chg', 'color')).toBe('var(--o-over)');
    // An attempt that ignored it, and a plant's clean replays, are muted: they showed nothing to look at.
    expect(value('.astrip .ac.mu', 'background')).toBe('var(--cq-muted-fill)');
    // The Security report's example mask reads as a diff does: the value struck through in the removed colour, its mask in the added one.
    expect(value('.injmask .del', 'color')).toBe('var(--del)');
    expect(value('.injmask .add', 'color')).toBe('var(--add)');
    // A golden's injection gate is one of its checks (`.ck.injck`), its mark in a check's colours, a hairline above it.
    for (const [status, colour] of [['passed', 'var(--ok)'], ['failed', 'var(--err)'], ['inconclusive', 'var(--warn)']] as const) expect(value(`table.gt .chk .ck.${status} .cm`, 'color'), status).toBe(colour);
    expect(value('table.gt .chk .ck.injck', 'border-top')).toBe('1px solid var(--line)');
    expect(value('table.gt .chk .ck.injck', 'color')).toBeNull();
  });

  it('draws stubbed in the stubbed origin’s colour, never the failure red', () => {
    expect(value('.tchip.s em', 'color')).toBe('var(--o-stub)');
    expect(value('.org.stub', 'color')).toBe('var(--o-stub)');
  });

  it('draws a blocked tool’s result in Calls in the blocked grey, as its origin is, the failure red kept for a call that failed', () => {
    expect(value('table.calls .res.blk', 'color')).toBe('var(--o-block)');
    expect(value('table.calls .res.err', 'color')).toBe('var(--err)');
  });

  it('marks the blamed call in ink with a halo, keeping amber for a probe that couldn’t decide', () => {
    expect(value('.callrow .hot .cn', 'background')).toBe('var(--ink)');
    expect(value('.callrow .hot .pl', 'color')).toBe('var(--ink)');
    expect(value('table.probes tr.hot td', 'background')).toBe('var(--sel)');
    expect(value('.bmk', 'color')).toBe('var(--ink)');
    expect(value('.callrow .unsure .pl', 'color')).toBe('var(--cq-amber)');
  });

  it('draws a step that ran and needs a look in amber, never the grey of one not run yet', () => {
    expect(value('.stepper .warn .k i', 'background')).toBe('var(--cq-amber)');
    expect(value('.psk.warn', 'color')).toBe('var(--cq-amber)');
  });

  it('keeps money a receipt, and an inconclusive CI row amber', () => {
    expect(value('.deltas b', 'color')).not.toMatch(/--warn|--cq-amber|--err/);
    expect(value('.cilist li i.warn', 'background')).toBe('var(--cq-amber)');
    expect(value('.cilist li i.err', 'background')).toBe('var(--cq-red)');
  });

  it('draws what is inconclusive in the consequence amber', () => {
    for (const s of ['.st.warn', '.glyph.warn', '.glyph.fixinc', '.glyph.amb', '.tag.inc', 'pre.report .y']) expect(value(s, 'color'), s).toBe('var(--cq-amber)');
    // An event that failed is red whatever its shape.
    expect(value('.glyph.err', 'color')).toBe('var(--err)');
    expect(value('td.hist i.inc::before', 'background')).toBe('var(--cq-amber)');
  });

  it('marks where you are in ink: the current page, run, tab and step, the selected call and turn, the step you are on', () => {
    expect(value('.navlist a[aria-current="page"] svg', 'color')).toBe('var(--ink)');
    for (const s of ['.run[aria-current="true"]::before', '.tabs [aria-selected="true"]::after', '.stabs a[aria-current="page"]::after', '.stepper a[aria-current="step"]::after']) expect(value(s, 'background'), s).toBe('var(--ink)');
    expect(value('table.calls tr[aria-selected="true"] td:first-child', 'box-shadow')).toBe('inset 3px 0 0 var(--ink)');
    // Under the pointer too, as a held row: the hover's ground is no more specific than the selection's, which comes after it.
    const at = (s: string) => rules().findIndex((r) => r.selectors.includes(s));
    expect(value('table.calls tr:hover td', 'background')).toBe('var(--hover)');
    expect(at('table.calls tr:hover td')).toBeLessThan(at('table.calls tr[aria-selected="true"] td'));
    expect(value('.turn.sel', 'box-shadow')).toBe('inset 3px 0 0 var(--ink)');
    expect(value('ol.setup .cur .sn', 'box-shadow')).toBe('inset 0 0 0 2px var(--ink)');
    expect(value('table.runst tr.picked td', 'background')).toBe('var(--sel)');
  });

  it('reads a link in ink, and draws a fork in ink and a live run in the live colour, never lime or amber', () => {
    for (const s of ['.more', '.attn-more', '.dlink']) expect(final(s, 'color'), s).toBe('var(--ink)');
    expect(value('.cells button.mark', 'box-shadow')).toBe('0 0 0 2px var(--bg), 0 0 0 4px var(--ink)');
    for (const s of ['.cells button .flag', 'table.calls .n .fk', '.banner.fork .bk']) expect(value(s, 'color'), s).toBe('var(--ink)');
    expect(value('.eyebrow', 'color')).toBe('var(--faint)');
    for (const s of ['.dotlive', '.glyph.live i', '.st.live i', '.livebtn .pulse']) expect(value(s, 'background'), s).toBe('var(--o-live)');
  });

  it('underlines a link set in a line of grey words, where ink and the grey differ by colour alone: a fix’s about line’s, and the retirement table’s on Migrate’s start', () => {
    for (const s of ['.ph.fxh .pmeta a.dlink', '.mgstart .mgsrc a.dlink']) expect(final(s, 'text-decoration'), s).toBe('underline');
  });
});

describe('lime', () => {
  /** Lime, by its tokens and by its value. */
  const LIME = /var\(--(lime|accent|accent-line|ok|cq-lime)\)|#c4f233|196,\s*242,\s*51/i;
  /** Passed, wherever it is drawn: a verdict's word, dot, cell, mark or ring. */
  const PASSED: Record<string, string> = {
    '.pips i': 'an attempt that passed',
    '.fxleg .lw.ok': 'the row of calls’ key: a probe that rescued the run',
    '.attempts span i': 'an attempt that passed',
    '.attempts a i': 'an attempt that passed',
    '.st.ok i': 'a run that came out well',
    '.banner.jv .jvw b.ok': 'a judge’s verdict on the run that passed: its ✓',
    '.evl .ed.end.ok': 'the last point of a gate’s evidence line that passed',
    '.st.ok': 'a status that passed: its word, in passed’s colour as its dot is',
    '.vw.ok': 'a verdict line’s word: passed',
    '.metric b.ok': 'a page’s fact that counts what passed (a fix verified)',
    '.rmx-c.ok i': 'a results matrix’s cell that passed: its bar, its word staying quiet',
    '.mxsw.ok': 'a matrix’s key: what passed',
    '.alist > .al > i': 'an attempt that passed',
    '.astrip .ac': 'an attempt that passed',
    'td.hist i.pass::before': 'a golden that passed at a revision',
    '.gtw .gstrip i.pass': 'a golden that passed at a revision',
    'td.hist i.meter.pass b': 'a golden that passed at a revision: the share of its attempts that passed',
    '.gtw .gstrip i.meter.pass': 'a golden that passed at a revision: the share of its attempts that passed',
    'table.gt .chk .ck.passed .cm': 'a check that passed',
    '.rpck .ck.passed .cm': 'a check that passed, in a golden’s report as in its row',
    '.checks': 'a fork’s checks, passed',
    '.callrow .ok .cn': 'a probe that rescued the run',
    '.callrow .ok .pl': 'a probe that rescued the run',
    '.wib .iv': 'a gate’s bound that passes',
    '.fdiff em.ok': 'how an attempt came out: passed',
    '.banner .why em.ok': 'how an attempt came out: passed',
    '.drawer .st2.ok': 'a job that ended well',
    '.status .jobchip.ok i': 'a hidden job that ended well',
    '.drawer pre .ok': 'a job that ended well',
    '.prl i.ok': 'the pull request comment’s line that passed',
    '.cilist li i.ok': 'a gate preview’s attempts that pass it',
    '.recline .ic': 'a setup step’s run that came back',
    '.glyph.fixok': 'a fix that was accepted',
    '.psk.done.s-verify': 'a fix’s Verify step that passed, on its Fixes row',
    '.psk.done.s-verify i': 'a fix’s Verify step that passed, on its Fixes row',
    '.stepper .done.s-verify .k i': 'a fix’s Verify step that passed, its dot in the stepper of the fix’s page',
    '.plist.checks li.met::before': 'a requirement met',
    '.dsv.ok b': 'a preview’s run that verify kept passing or fixed: its word',
    '.dlead .dlv.ok b': 'an opened cell’s run that verify kept passing or fixed: its word',
    '.djudge b.ok': 'a judge check that passed',
    '.prc-g li.pass i': 'the pull request comment’s mark, drawn, of a golden that passed',
    '.prc-i.pass i': 'the pull request comment’s mark, drawn, of an injection gate that passed',
  };
  /** Lime the design rules out that only a later slice's markup can take away, each with the slice that does. */
  const UNTIL: Record<string, string> = {
    '.badge.ok': 'port/primitives, then each page’s slice: Status draws a status as a dot and a word, never a tinted badge',
  };
  /** Where lime marks no meaning: the keyboard's focus, a focused field, the text you select, and the row the keys light in a list whose field keeps the focus (`.kb`: a picker's, the palette's). */
  const FOCUS = /:focus(-visible|-within)?\b|^::selection$|^\.labelbar input$|\.kb \.\w+\.on$/;

  it('means the primary action and passed, and nothing else but where the keyboard is', () => {
    const off: string[] = [];
    for (const r of styleRules()) {
      if (r.selectors.includes(':root')) continue;
      const lime = r.decls.filter(([, v]) => LIME.test(v));
      for (const s of r.selectors) if (lime.length && !/^\.btn\.lime\b/.test(s) && !PASSED[s] && !UNTIL[s] && !FOCUS.test(s)) off.push(`${s} { ${lime.map(([p, v]) => `${p}: ${v}`).join('; ')} }`);
    }
    expect(off).toEqual([]);
  });

  it('draws a chosen label and a fix’s answers in ink, never as a verdict', () => {
    expect(value('.runkey .rk[aria-pressed="true"]', 'color')).toBe('var(--ink)');
    expect(value('.runkey .rk[aria-pressed="true"]', 'background')).toBe('var(--raise)');
    expect(value('.ans div', 'border-top')).toBe('1px solid var(--line)');
    expect(value('.ans code', 'color')).toBe('var(--ink)');
  });

  it('puts no glow under the lime button', () => {
    const glow = styleRules().filter((r) => r.selectors.some((s) => s.startsWith('.btn.lime')) && r.decls.some(([p, v]) => p === 'box-shadow' && LIME.test(v)));
    expect(glow.map((r) => r.selectors.join(', '))).toEqual([]);
  });
});

describe('amber', () => {
  /** Amber, by its tokens and by its value: the warning colour and the consequence amber. */
  const AMBER = /var\(--(warn|cq-amber)\)|#f2c94c|#c98500|242,\s*201,\s*76|201,\s*133,\s*0/i;
  /** Needs a look or inconclusive, wherever it is drawn: a word, dot, cell, mark, line or banner. */
  const LOOK: Record<string, string> = {
    '.glyph.warn': 'a glyph that needs a look',
    '.verdict.tv p .tstale': 'Tests’ verdict tested a commit your working tree has moved on from: run them again',
    '.evl .ed.y': 'an attempt the provider cut short, counted against either verdict, never the agent’s failure',
    '.evl .ed.end.y': 'the last point of a gate’s evidence line that ran out between its bounds',
    '.glyph.fixinc': 'a fix whose verify couldn’t decide',
    '.glyph.retire': 'a model the goldens use that retires',
    '.glyph.amb': 'an event that couldn’t decide, stopped or needs a look, whatever its shape',
    '.pips i.unsure': 'an attempt that couldn’t decide',
    '.pips i.part': 'an attempt that partly passed: inconclusive',
    '.legend i.lg.unsure': 'the probes’ key: an attempt that couldn’t decide',
    '.fxleg .lw.unsure': 'the row of calls’ key: a probe that couldn’t decide',
    '.attempts span i.unsure': 'an attempt that couldn’t decide',
    '.attempts a i.unsure': 'an attempt that couldn’t decide',
    '.st.warn': 'a status that needs a look',
    '.st.warn i': 'a status that needs a look',
    '.vw.warn': 'a verdict line’s word: inconclusive',
    '.dstop.diff': 'a decision’s stop that differs from the other side’s, which needs a look',
    '.alist > .al > i.inc': 'an attempt that couldn’t be judged',
    '.astrip .ac.inc': 'an attempt that couldn’t be judged',
    '.tag.inc': 'an inconclusive status chip',
    '.wib.y .iv': 'a gate’s bound that can’t yet say pass or fail',
    '.run .r2 em.inc': 'a run that came out inconclusive',
    '.rrow .rr2 em.inc': 'a recent run that came out inconclusive',
    'table.runst .rline em.inc': 'a run that came out inconclusive',
    '.banner.inc': 'a run that came out inconclusive',
    '.banner.inc .bk': 'a run that came out inconclusive',
    '.banner.inc .bn': 'a run that came out inconclusive',
    '.banner .why em.inc': 'an attempt that came out inconclusive',
    '.fnode .f2 em.inc': 'a fork that came out inconclusive',
    '.fdiff em.warn': 'how an attempt came out: needs a look',
    '.fdiff li.r2 .rk': 'a change of rank 2, a stop that changed: a look, as the design ranks them',
    '.banner.fork': 'the design keeps a fork banner’s faint tint: the calls after a fork may differ from the recording',
    '.callrow .unsure .cn': 'a probe that couldn’t decide',
    '.callrow .unsure .pl': 'a probe that couldn’t decide',
    '.psk.warn': 'a step that ran and needs a look',
    '.psk.warn i': 'a step that ran and needs a look',
    '.stepper .warn .k i': 'a step that ran and needs a look',
    '.fxwarn': 'what a fix asks you to look at',
    '.fxwarn.bad li.unsure': 'what a fix couldn’t decide',
    'td.hist i.inc::before': 'a golden inconclusive at a revision',
    '.gtw .gstrip i.inc': 'a golden inconclusive at a revision',
    'td.hist i.meter.inc b': 'a golden inconclusive at a revision: the share of its attempts that passed',
    '.gtw .gstrip i.meter.inc': 'a golden inconclusive at a revision: the share of its attempts that passed',
    'table.gt .chk .ck.inconclusive .cm': 'a check that couldn’t decide',
    '.rpck .ck.inconclusive .cm': 'a check that couldn’t decide, in a golden’s report as in its row',
    'table.gt td.glast .gpre.warn': 'a golden whose last test needs a look',
    'pre.report .y': 'a report’s inconclusive line',
    '.drawer .st2.warn': 'a job that ended needing a look',
    '.status .jobchip.warn i': 'a hidden job that ended needing a look',
    '.drawer pre .y': 'a job’s inconclusive line',
    '.cilist li i.warn': 'an inconclusive CI run',
    '.kpi b.warn': 'a count of goldens that need a look',
    '.cstats b.warn': 'a prompt cache miss that cost: a look',
    '.cbar .miss': 'a prompt cache miss that cost: a look',
    '.cnote b': 'a prompt cache miss that cost: a look',
    'table.ctab tr.miss td': 'a prompt cache miss that cost: a look',
    '.prov .warn': 'a recording’s provenance that needs a look',
    '.rnote.warn': 'a run note that needs a look',
    '.rnote.warn .bk': 'a run note that needs a look',
    '.rntools .eff.unknown': 'a tool whose effect no rule says: a look',
    '.fieldnote.warn': 'a field’s value that needs a look',
    'ol.setup .sb > p.fieldnote.warn': 'a setup field’s value that needs a look',
    '.warnline > p > b': 'a warning in a step: its first words, the rest of its line in the step’s own colour',
    'ol.setup.storesetup dd .warnt': 'a store setting that needs a look',
    '.agentfiles .warn': 'a coding agent’s file that needs a look',
    '.skrow > div:first-child > span.warn': 'a skill that needs a look',
    '.cip .offnote': 'a CI feature that is off: a look',
    '.wfpanel .wfstate b': 'the lines Your workflow changes in the repository’s file: a look before Write file',
    '.set > .kvs dd small.warn': 'a setting that needs a look',
    '.egrp.mcp td small.mnote.warn': 'an MCP server that needs a look',
    '.trow.warn > span:last-child': 'a row that needs a look',
    '.dialog .dwarn': 'a dialog’s one line: where it can’t help yet, or what to look at before pressing',
    '.dialog .dfacts .amber dt': 'a row of a dialog that runs someone else’s command: a look',
    '.connbar .cdot': 'the dashboard can’t be reached: a look',
    '.paloff .cdot': 'the palette’s line saying the server can’t be reached: a look',
    '.status .off': 'the dashboard can’t be reached: a look',
    '.rmx-c.warn i': 'a results matrix’s cell that was inconclusive or influenced: its bar',
    '.rmx-c.warn b': 'a results matrix’s cell that was inconclusive or influenced: its word',
    '.mxsw.warn': 'a matrix’s key: what was inconclusive or influenced',
    '.cb-units li.bad .cb-ul code': 'a rule the check builder refuses, in the engine’s words: Save waits until it is fixed',
    '.cb-notes li.y': 'a note against the agent’s recordings that needs a look before the check is saved',
    '.cb-row .cm.inc': 'a recording the check being built can’t decide',
    '.cb-row.y .cb-d': 'a fix’s run the check being built would change for it: a failing run it passes, a good one it fails, or one it can’t settle',
    '.cb-warn': 'shadowlap.config.json changed since the check builder read it: the change is shown against it again',
    'i.dg.s': 'a preview key’s swatch for a change of rank 2, a stop, hand-over or judged change: a look, as the design ranks them',
    'i.dg.jw': 'a preview key’s swatch for a step that waits on a judge: its ring',
    '.dc.s': 'a decision cell of rank 2, a stop, hand-over or judged change: a look, as the design ranks them',
    '.dc.jw': 'a decision cell that waits on a judge: its ring',
    '.dc.split i.s': 'a split decision cell’s samples of rank 2: a look',
    '.dsd.q2': 'a preview row’s most telling change, of rank 2: a look',
    '.dsy': 'what a preview couldn’t ask or judge: a run it refused, a step that waits on a judge, a warning',
    '.mgrows .mgleft': 'a golden the switch leaves behind: it diverges on `$.model` until updated',
    '.mgalso': 'a field What to set says to leave out that the patch can’t: left for the hand',
    '.dsv.y b': 'a preview’s run that verify found inconclusive: its word',
    '.dnotes': 'the warnings under a preview’s matrix: what couldn’t be asked or judged',
    '.dlead .dlv.y b': 'an opened cell’s run that verify found inconclusive: its word',
    '.drk.q2': 'a change of rank 2’s label: a look',
    '.dside.q2': 'an opened cell’s decision now, of rank 2: its edge, a look',
    '.djudge b.y': 'a judge check that couldn’t decide',
    '.prc b.inc': 'the pull request comment’s decisions, drawn, where only reads or text changed or no step was asked: their mark, a look',
    '.prc-g li.inc i': 'the pull request comment’s mark, drawn, of a golden that couldn’t decide',
    '.prc-i.inc i': 'the pull request comment’s mark, drawn, of an injection gate that couldn’t decide',
    '.prc-rk.r2': 'a step of rank 2’s label in the pull request comment’s decisions: a look, as the design ranks them',
    '.vdflag': 'a session whose pull request merged though it failed or couldn’t decide',
  };
  /** Amber the design rules out that only a later slice can take away, each with the slice that does. */
  const UNTIL: Record<string, string> = {
    '.badge.y': 'port/primitives, then each page’s slice: Status draws a status as a dot and a word, never a tinted badge',
  };

  it('means needs a look or inconclusive, and nothing else: never a fork, stubbed or blame', () => {
    const off: string[] = [];
    for (const r of styleRules()) {
      if (r.selectors.includes(':root')) continue;
      const amber = r.decls.filter(([, v]) => AMBER.test(v));
      for (const s of r.selectors) if (amber.length && !LOOK[s] && !UNTIL[s]) off.push(`${s} { ${amber.map(([p, v]) => `${p}: ${v}`).join('; ')} }`);
    }
    expect(off).toEqual([]);
  });

  it('draws a message a fork changed without amber', () => {
    expect(value('.msg.changed', 'background')).toBeNull();
    expect(value('.msg.changed', 'box-shadow')).toBeNull();
  });
});

describe('grounds, tints and lines', () => {
  /** A ground's, a tint's or a line's colour: a background's or a border's (rings and outlines aside). */
  const PROPS = /^(background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?)$/;
  /** A colour mixed from a neutral: an ink, a ground, the live colour's off-white, white or black. */
  const NEUTRAL = /var\(--(ink|dim|faint|o-live|bg|bg2|code|panel|hover|raise|sel|line|line2|pop|pop-edge|field)\)|#fff\b|#ffffff\b|#000\b|#000000\b|\bwhite\b|\bblack\b/i;
  const MIX = /color-mix\((?:[^()]|\([^()]*\))*\)/g;
  /** The tints that remain outside the tokens, each with its reason: later slices shrink this list. */
  const TINTS: Record<string, string> = {
    '.btn.danger:hover:not([disabled], [aria-disabled="true"])': 'the red button under the pointer, a step darker',
    '.btn.lime:hover:not([disabled], [aria-disabled="true"])': 'the lime button under the pointer, a step lighter',
    '.av.t1': 'an avatar’s colour on the raised ground',
    '.av.t2': 'an avatar’s colour on the raised ground',
    '.av.t3': 'an avatar’s colour on the raised ground',
    '.av.t4': 'an avatar’s colour on the raised ground',
    '.cal .cd.l1': 'the Runs calendar’s ramp over its empty day',
    '.cal .cd.l2': 'the Runs calendar’s ramp over its empty day',
    '.cal .cd.l3': 'the Runs calendar’s ramp over its empty day',
    '.cal .cd.hb .hn': 'a bar of Runs’ row of days, the ink faint over whatever ground it sits on',
    '.cal button.cd.hb:hover .hn': 'a bar of Runs’ row of days under the pointer, the ink a step stronger',
    '.tag.live': 'a live run’s chip, ringed in the live colour',
    '.banner.live': 'a live run’s banner, faintly in the live colour',
    '.connblock': 'the page behind the offline bar, veiled in its own ground',
    '.scrim': 'the page dimmed behind a dialog',
    '.msheet': 'the page dimmed behind a phone’s menu sheet',
    '.toast .tx:hover': 'on the toast’s ink ground, the page’s ground as its tint',
    '.toast .tx:focus-visible': 'on the toast’s ink ground, the page’s ground as its tint',
    '.toast .tbtn:hover': 'on the toast’s ink ground, the page’s ground as its tint',
    '.pdiff mark': 'a prompt’s changed words, marked in ink over the code ground',
    '.grp:hover::before': 'a chart group under the pointer, over its bars',
    '.cbar:hover::before': 'a Context bar under the pointer, over its bars',
    '.cbar.sel::before': 'the chosen Context bar, over its bars',
    '.banner.n': 'a banner that says nothing is wrong, a shade off the page',
  };
  /** Tints the design drops with the part they draw, each with the slice that does. */
  const UNTIL: Record<string, string> = {};

  it('draws every ground, tint and line from the tokens, the tints that remain each with its reason', () => {
    const off: string[] = [];
    for (const r of styleRules()) {
      if (r.selectors.includes(':root')) continue;
      for (const [p, v] of r.decls) {
        if (!PROPS.test(p)) continue;
        const mixed = [...v.matchAll(MIX)].some((m) => NEUTRAL.test(m[0]));
        const raw = /#[0-9a-f]{3,8}\b|rgba?\(/i.test(v.replace(MIX, ''));
        if (mixed || raw) for (const s of r.selectors) if (!TINTS[s] && !UNTIL[s]) off.push(`${s} { ${p}: ${v} }`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe('forced colours', () => {
  /** The rules a high-contrast theme applies: selector → property → value. */
  const forced = new Map<string, Map<string, string>>();
  for (const r of styleRules()) {
    if (!r.conditions.some((c) => /forced-colors:\s*active/.test(c))) continue;
    for (const s of r.selectors) for (const [p, v] of r.decls) forced.set(s, (forced.get(s) ?? new Map<string, string>()).set(p, v));
  }

  it('keeps the colour of every mark that says something by its colour alone, edged so it shows on any ground', () => {
    const marks = ['.cells button', '.ms', '.segbar', '.org i', '.legend i', '.pips i', '.st i', '.dotlive', '.oleg i', '.grp i', 'td.hist i', '.cal .cd:not(.fut)', '.callrow .cn', '.wib', '.attempts span i', '.alist > .al > i', '.astrip .ac', '.astrip .acsep', '.tl-row .bar', '.prl i', '.cilist li i', '.rmx-c i', '.mxsw', '.dc', 'i.dg'];
    for (const s of marks) expect(forced.get(s)?.get('forced-color-adjust'), s).toBe('none');
  });

  it('marks where you are in the highlight colour, and underlines a chosen option whose fill is lost', () => {
    expect(forced.get('.navlist a[aria-current="page"]::before')?.get('background')).toBe('Highlight');
    expect(forced.get('.run[aria-current="true"]::before')?.get('background')).toBe('Highlight');
    expect(forced.get('table.calls tr[aria-selected="true"]')?.get('outline')).toBe('2px solid Highlight');
    // A folded row in Calls that holds the open call is outlined as the open call's row is.
    expect(forced.get('table.calls tr.held')?.get('outline')).toBe('2px solid Highlight');
    // A run's Decisions view outlines the step it shows, as Calls does its open call.
    expect(forced.get('.dvstep.sel')?.get('outline')).toBe('2px solid Highlight');
    for (const s of ['.seg button[aria-pressed="true"]', '.chips button[aria-pressed="true"]', '.legend.lfilter button[aria-pressed="true"]', '.runkey .rk[aria-pressed="true"]']) expect(forced.get(s)?.get('text-decoration'), s).toBe('underline 2px');
    expect(forced.get(':is(input, select, textarea, .drop):focus-visible')?.get('outline')).toBe('2px solid Highlight !important');
    // The structural diff's marked words, which say what changed by their ground alone.
    expect(forced.get('mark.jdw')?.get('text-decoration')).toBe('underline 2px');
    // What the working tree adds to a prompt in Preview changed prompt, drawn on the added lines' ground.
    expect(forced.get('.dprompt ins')?.get('text-decoration')).toBe('underline');
  });

  it('outlines every overlay in the user’s text colour, since its edge is a shadow the theme drops', () => {
    for (const s of ['.pop', '.dialog', '.palette', '.help', '.tip', '.toast']) expect(forced.get(s)?.get('outline'), s).toBe('1px solid CanvasText');
  });

  it('stands every overlay on one surface: the page’s ground, one edge and its shadow, a clear border showing as the edge where the theme drops the shadow', () => {
    const rule = (sel: string) => new Map(styleRules().filter((r) => !r.conditions.length && r.selectors.includes(sel)).flatMap((r) => r.decls));
    for (const sel of ['.pop', '.dialog', '.palette', '.help', '.tip', '.bulkbar', '.connblock .cb', '.skip']) {
      const decls = rule(sel);
      expect(decls.get('background'), sel).toBe('var(--pop)');
      expect(decls.get('box-shadow'), sel).toBe('var(--shadow-pop)');
    }
    for (const sel of ['.bulkbar', '.connblock .cb', '.skip']) expect(rule(sel).get('border'), sel).toBe('1px solid transparent');
    // A row's own tint, as the page's rows: the pointer's, then where you are, with the keyboard's ring inside it.
    expect(rule('.pop button:hover:not([disabled], [aria-disabled="true"])').get('background')).toBe('var(--hover)');
    expect(rule('.pop button:focus-visible').get('background')).toBe('var(--sel)');
    expect(rule('.pop button:focus-visible').get('outline-offset')).toBe('-2px');
    // Two menu widths only, and the figures on a card as the CLI prints them.
    expect(rule('.pop').get('width')).toBe('340px');
    expect(rule('.pop.narrow').get('width')).toBe('280px');
    expect(rule('.tip').get('font-variant-ligatures')).toBe('none');
  });
});
