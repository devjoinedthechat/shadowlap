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
  const MARKS = ['.cells button', '.ms i', '.gs i', '.segbar i', '.oleg i', '.tl-row .bar', '.legend i.lg', '.org'];
  const mark = (m: string, o: string) => (m === '.org' ? '.org.' + o + ' i' : `${m}.${o}`);

  it('draws a blocked write as a neutral hatch, fenced by its outline where a mark is big enough to show one', () => {
    for (const m of MARKS) expect(value(mark(m, 'block'), 'background'), m).toBe('var(--o-block-fill)');
    for (const m of ['.cells button', '.segbar i', '.oleg i', '.tl-row .bar', '.legend i.lg', '.org']) expect(value(mark(m, 'block'), 'box-shadow'), m).toBe('inset 0 0 0 1px var(--o-block)');
    expect(value(':root', '--o-block-fill')).toMatch(/^repeating-linear-gradient\(135deg, var\(--o-block\)/);
    // under 6px, where the hatch can't draw, its tone as a solid
    expect(css).toMatch(/@container \(max-width: 5\.99px\) \{ :is\([^)]*\)\.block::before \{[^}]*background: var\(--o-block-solid\)/);
  });

  it('draws a failed call as its tint ringed in the one red, never a solid red that reads as replayed under deuteranopia', () => {
    for (const m of MARKS.filter((x) => x !== '.org')) expect(value(mark(m, 'fail'), 'background'), m).toBe('var(--o-fail-fill)');
    expect(css).toMatch(/@container \(min-width: 6px\) \{ :is\([^)]*\)\.fail::before \{[^}]*box-shadow: inset 0 0 0 1\.5px var\(--o-fail\)/);
  });

  it('keeps the replayed colour for a replayed call: a verdict is drawn in the consequence colours, a score and a finished step neutral', () => {
    for (const s of ['.pips i', '.st.ok i', '.attempts span i', '.attempts a i', 'td.hist i.pass::before', '.prl i.ok', '.recline .ic']) expect(value(s, 'background'), s).toBe('var(--cq-lime)');
    for (const s of ['.pips i.no', '.attempts span i.no', '.attempts a i.no']) expect(value(s, 'background'), s).toBe('var(--cq-red)');
    for (const s of ['.sbar i', '.stepper .done .k i', '.psteps .done i']) expect(value(s, 'background'), s).toBe('var(--dim)');
    const misused = rules().filter((r) => /var\(--o-rep\)/.test(r.body) && !r.selectors.every((s) => /\.rep\b|\.clean\b|\.metric b\.lime|^:root$/.test(s)));
    expect(misused.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  it('draws a prompt’s cache reads in the quiet neutral, in the Context chart and the Overview’s cache bar alike', () => {
    expect(value(':root', '--c-read')).toBe('color-mix(in srgb, var(--ink) 40%, var(--panel))');
    expect(value('.ovc .segbar i.rep', 'background')).toBe('var(--c-read)');
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

  it('dims what Compare shows the same in the faint ink, which keeps AA’s contrast, never by fading it', () => {
    expect(value('.pcall.same', 'color')).toBe('var(--faint)');
    expect(value('.pcall.same', 'opacity')).toBeNull();
  });

  it('dims what doesn’t apply in the faint ink, never by fading it, and keeps the bar’s words above AA on its amber', () => {
    // The shortcuts a page doesn't offer, and a CI feature turned off: faded, they fell to 2.2 and 4.0:1.
    expect(value('.hgroup.off dd', 'color')).toBe('var(--faint)');
    expect(value('.hgroup.off dd', 'opacity')).toBeNull();
    const faded = rules().filter((r) => r.selectors.some((x) => x.startsWith('.cip.off') || x.startsWith('.hgroup.off')) && /(^|;)\s*opacity\s*:/.test(r.body));
    expect(faded.map((r) => r.selectors.join(', '))).toEqual([]);
    // On the connection bar's amber wash the faint ink is 4.4:1: the dim one.
    expect(value('.connbar .cr', 'color')).toBe('var(--dim)');
  });

  it('keeps a segment, a fix step’s switch and an attempt’s line 24 px tall at least, as WCAG 2.5.8 asks of a target', () => {
    expect(value('.seg button', 'min-height')).toBe('24px');
    expect(value('.seg a', 'min-height')).toBe('24px');
    expect(value('.attempts a', 'min-height')).toBe('24px');
  });

  it('draws stubbed in the stubbed origin’s colour, never the failure red', () => {
    expect(value('.tchip.s em', 'color')).toBe('var(--o-stub)');
    expect(value('.org.stub', 'color')).toBe('var(--o-stub)');
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
    expect(value('.psteps .warn', 'color')).toBe('var(--cq-amber)');
  });

  it('keeps money a receipt, and an inconclusive CI row amber', () => {
    expect(value('.deltas b', 'color')).not.toMatch(/--warn|--cq-amber|--err/);
    expect(value('.cilist li i.warn', 'background')).toBe('var(--cq-amber)');
    expect(value('.cilist li i.err', 'background')).toBe('var(--cq-red)');
  });

  it('draws what is inconclusive in the consequence amber', () => {
    for (const s of ['.st.warn', '.glyph.warn', '.tag.inc', 'pre.report .y']) expect(value(s, 'color'), s).toBe('var(--cq-amber)');
    expect(value('td.hist i.inc::before', 'background')).toBe('var(--cq-amber)');
  });

  it('marks where you are in ink: the current page, run, tab and step, the selected call and turn, the step you are on', () => {
    expect(value('.navlist a[aria-current="page"] svg', 'color')).toBe('var(--ink)');
    for (const s of ['.run[aria-current="true"]::before', '.tabs [aria-selected="true"]::after', '.stabs a[aria-current="page"]::after', '.stepper a[aria-current="step"]::after']) expect(value(s, 'background'), s).toBe('var(--ink)');
    expect(value('table.calls tr[aria-selected="true"] td:first-child', 'box-shadow')).toBe('inset 3px 0 0 var(--ink)');
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
});

describe('lime', () => {
  /** Lime, by its tokens and by its value. */
  const LIME = /var\(--(lime|accent|accent-line|ok|cq-lime)\)|#c4f233|196,\s*242,\s*51/i;
  /** Passed, wherever it is drawn: a verdict's word, dot, cell, mark or ring. */
  const PASSED: Record<string, string> = {
    '.pips i': 'an attempt that passed',
    '.attempts span i': 'an attempt that passed',
    '.attempts a i': 'an attempt that passed',
    '.st.ok i': 'a run that came out well',
    'td.hist i.pass::before': 'a golden that passed at a revision',
    '.gtw .gstrip i.pass': 'a golden that passed at a revision',
    'table.gt .chk .ck.passed .cm': 'a check that passed',
    '.checks': 'a fork’s checks, passed',
    '.callrow .ok .cn': 'a probe that rescued the run',
    '.callrow .ok .pl': 'a probe that rescued the run',
    '.ans div.good': 'the rescued fork’s answer',
    '.wib .iv': 'a gate’s bound that passes',
    '.fdiff em.ok': 'how an attempt came out: passed',
    '.banner .why em.ok': 'how an attempt came out: passed',
    '.badge.ok': 'passed',
    '.verdict.ok': 'a passed verdict',
    '.setupdone': 'a setup that is done: “set up”',
    '.drawer .st2.ok': 'a job that ended well',
    '.drawer pre .ok': 'a job that ended well',
    '.prl i.ok': 'the pull request comment’s line that passed',
    '.recline .ic': 'a setup step’s run that came back',
    '.glyph.fixok': 'a fix that was accepted',
    '.plist.checks li.met::before': 'a requirement met',
    '.runkey .rk.good[aria-pressed="true"]': 'a run labelled good: passed, by your own judgement',
  };
  /** Where lime marks no meaning: the keyboard's focus, a focused field, the text you select. */
  const FOCUS = /:focus(-visible|-within)?\b|^::selection$|^\.labelbar input$/;

  it('means the primary action and passed, and nothing else but where the keyboard is', () => {
    const off: string[] = [];
    for (const r of styleRules()) {
      if (r.selectors.includes(':root')) continue;
      const lime = r.decls.filter(([, v]) => LIME.test(v));
      for (const s of r.selectors) if (lime.length && !/^\.btn\.lime\b/.test(s) && !PASSED[s] && !FOCUS.test(s)) off.push(`${s} { ${lime.map(([p, v]) => `${p}: ${v}`).join('; ')} }`);
    }
    expect(off).toEqual([]);
  });

  it('puts no glow under the lime button', () => {
    const glow = styleRules().filter((r) => r.selectors.some((s) => s.startsWith('.btn.lime')) && r.decls.some(([p, v]) => p === 'box-shadow' && LIME.test(v)));
    expect(glow.map((r) => r.selectors.join(', '))).toEqual([]);
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
    const marks = ['.cells button', '.ms', '.gs', '.segbar', '.org i', '.legend i', '.pips i', '.st i', '.dotlive', '.oleg i', '.grp i', 'td.hist i', '.cal .cd:not(.fut)', '.callrow .cn', '.wib', '.attempts span i', '.tl-row .bar', '.prl i', '.cilist li i'];
    for (const s of marks) expect(forced.get(s)?.get('forced-color-adjust'), s).toBe('none');
  });

  it('marks where you are in the highlight colour, and underlines a chosen option whose fill is lost', () => {
    expect(forced.get('.navlist a[aria-current="page"]::before')?.get('background')).toBe('Highlight');
    expect(forced.get('.run[aria-current="true"]::before')?.get('background')).toBe('Highlight');
    expect(forced.get('table.calls tr[aria-selected="true"]')?.get('outline')).toBe('2px solid Highlight');
    for (const s of ['.seg button[aria-pressed="true"]', '.chips button[aria-pressed="true"]', '.ofilter button[aria-pressed="true"]']) expect(forced.get(s)?.get('text-decoration'), s).toBe('underline 2px');
    expect(forced.get(':is(input, select, textarea, .drop):focus-visible')?.get('outline')).toBe('2px solid Highlight !important');
  });
});
