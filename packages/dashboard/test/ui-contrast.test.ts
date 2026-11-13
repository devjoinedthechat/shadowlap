import { describe, expect, it } from 'vitest';
import { sheet, styleRules } from './css-sheet.js';

/**
 * Every colour the stylesheet sets text in reaches WCAG AA's 4.5:1: on the background its own rule
 * gives it (a lime button's dark text, a toast's), else on every surface text sits on, the page
 * ground, the panels, and a row hovered or picked. Read from the stylesheet as the browser reads it:
 * tokens resolved through the `var()`s that alias them, `color-mix` in sRGB worked out. The real
 * browser checks the pages themselves (browser/a11y.spec.ts).
 */

const css = sheet().replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule, those inside media queries too: its selectors and declarations. */
function rules(text = css): Array<{ selectors: string[]; decls: Map<string, string> }> {
  const out: Array<{ selectors: string[]; decls: Map<string, string> }> = [];
  let depth = 0;
  let start = 0;
  let head = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) {
        head = text.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const body = text.slice(start, i);
        if (head.startsWith('@media') || head.startsWith('@supports')) out.push(...rules(body));
        else if (!head.startsWith('@')) {
          const decls = new Map<string, string>();
          for (const d of body.split(';')) {
            const at = d.indexOf(':');
            if (at > 0) decls.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
          }
          out.push({ selectors: head.split(',').map((x) => x.trim()), decls });
        }
        start = i + 1;
      }
    }
  }
  return out;
}

/** The tokens `:root` defines, the last definition winning, as the browser takes them. */
const tokens = new Map<string, string>();
for (const r of rules()) if (r.selectors.includes(':root')) for (const [k, v] of r.decls) if (k.startsWith('--')) tokens.set(k, v);

type Rgb = [number, number, number];

/** A colour as the browser computes it, or null for one that depends on what is under it (transparent, currentColor). */
function resolve(value: string, depth = 0): Rgb | null {
  const v = value.trim();
  if (depth > 10) throw new Error(`a var() loop at ${value}`);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const n = parseInt(h, 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) {
    const t = tokens.get(ref[1]);
    if (t === undefined) throw new Error(`no token ${ref[1]}`);
    return resolve(t, depth + 1);
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const a = resolve(mix[1], depth + 1);
    const b = resolve(mix[3], depth + 1);
    if (!a || !b) return null;
    const p = Number(mix[2]) / 100;
    return [0, 1, 2].map((i) => Math.round(a[i] * p + b[i] * (1 - p))) as Rgb;
  }
  return null;
}

function ratio(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, b2] = c.map((x) => {
      const s = x / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** What text sits on: the page ground, the panels, code, and a row or control hovered, raised or picked. */
const SURFACES = ['--bg', '--bg2', '--panel', '--raise', '--hover', '--sel', '--code', '--pop'];

/**
 * Text drawn only as decoration, which WCAG 1.4.3 leaves out, hidden from assistive technology
 * where it is drawn: each with why.
 */
const DECORATION: Record<string, string> = {
  '.crumbs i': 'the slash between two crumbs (aria-hidden in TopBar.tsx)',
};

describe('text contrast', () => {
  it('draws faint text at 4.5:1 or more on every surface, as AA asks', () => {
    for (const s of SURFACES) expect(ratio(resolve('var(--faint)')!, resolve(`var(${s})`)!), s).toBeGreaterThanOrEqual(4.5);
  });

  it('sets text in no colour under 4.5:1 on what it is drawn on', () => {
    const low: string[] = [];
    let checked = 0;
    for (const r of rules()) {
      const color = r.decls.get('color');
      if (!color) continue;
      const fg = resolve(color);
      if (!fg) continue;
      const shown = r.selectors.filter((s) => !DECORATION[s] && !s.startsWith(':root'));
      if (!shown.length) continue;
      checked++;
      // A rule that gives its text a background of its own is read against that; any other against every surface.
      const own = resolve(r.decls.get('background-color') ?? r.decls.get('background') ?? '');
      const grounds: Array<[string, Rgb]> = own ? [['its own background', own]] : SURFACES.map((s) => [s, resolve(`var(${s})`)!]);
      for (const [name, bg] of grounds) {
        const x = ratio(fg, bg);
        if (x < 4.5) low.push(`${shown.join(', ')}: ${color} on ${name} is ${x.toFixed(2)}:1`);
      }
    }
    expect(checked).toBeGreaterThan(400);
    expect(low).toEqual([]);
  });

  it('keeps each text token apart from the one above it, so faint still reads as quieter than dim', () => {
    const on = resolve('var(--bg)')!;
    expect(ratio(resolve('var(--dim)')!, on)).toBeGreaterThan(ratio(resolve('var(--faint)')!, on) * 1.3);
    expect(ratio(resolve('var(--ink)')!, on)).toBeGreaterThan(ratio(resolve('var(--dim)')!, on) * 1.3);
  });
});

describe('a field’s edge', () => {
  it('reaches 3:1 on the page, an overlay, the code ground and a field’s own, as WCAG 1.4.11 asks of a control', () => {
    for (const s of ['--bg', '--pop', '--bg2', '--panel']) expect(ratio(resolve('var(--field)')!, resolve(`var(${s})`)!), s).toBeGreaterThanOrEqual(3);
  });

  it('is --field on every input, select, text area, picker, search field and drop zone', () => {
    // A field by its own last compound: the element, or the class that draws it.
    const FIELD = /(^|[\s>])(input|select|textarea)(?=$|[.:[])|\.(rpick|sbtn|cmdin|drop)(?=$|[.:[])/;
    // The label field shows only while a label is typed, with the focus: its edge is a focused field's.
    const FOCUSED = new Set(['.labelbar input']);
    const off: string[] = [];
    for (const r of rules()) {
      const border = r.decls.get('border');
      if (!border || /^(0|none)$/.test(border)) continue;
      const fields = r.selectors.filter((s) => FIELD.test(s.split(/\s+/).at(-1)!) && !/:(hover|focus)/.test(s) && !FOCUSED.has(s));
      if (fields.length && !border.includes('var(--field)')) off.push(`${fields.join(', ')}: ${border}`);
    }
    expect(off).toEqual([]);
  });
});

describe('the design system’s parts', () => {
  /** The colour the last rule naming `selector` gives its text. */
  const colourOf = (selector: string) => {
    let found: string | undefined;
    for (const r of rules()) if (r.selectors.includes(selector) && r.decls.has('color')) found = r.decls.get('color');
    return found;
  };

  it('sets every status, verdict word, fact, attempt line, empty line and control of the shared parts at 4.5:1 on every surface', () => {
    const parts = ['.st.ok', '.st.err', '.st.warn', '.st.mu', '.st.n', '.st.done', '.st.stub', '.st.block', '.vw.ok', '.vw.err', '.vw.warn', '.vw.mu', '.vw.done', '.verdict p', '.verdict > .badge.n', '.metric b.ok', '.emptyline', '.acell', '.alist > .al', '.alist .more2', '.boxcopy', '.xbtn', '.seg button, .seg a', '.eyebrow', '.ph p'];
    const low: string[] = [];
    for (const p of parts) {
      const sel = p.split(', ')[0];
      const c = colourOf(sel);
      expect(c, p).toBeDefined();
      for (const s of SURFACES) {
        const x = ratio(resolve(c!)!, resolve(`var(${s})`)!);
        if (x < 4.5) low.push(`${p} on ${s}: ${x.toFixed(2)}:1`);
      }
    }
    expect(low).toEqual([]);
  });

  it('draws a segmented control’s chosen option in ink on the raised ground, a list’s quiet id part in the faint ink', () => {
    const chosen = rules().find((r) => r.selectors.includes('.seg button[aria-pressed="true"]'))!;
    expect([chosen.decls.get('color'), chosen.decls.get('background')]).toEqual(['var(--ink)', 'var(--raise)']);
    expect(ratio(resolve('var(--ink)')!, resolve('var(--raise)')!)).toBeGreaterThanOrEqual(4.5);
    const id = rules().find((r) => r.selectors.includes('code.rnm.rl'))!;
    expect(id.decls.get('background')).toBe('linear-gradient(90deg, var(--faint) 6ch, var(--id-ink, var(--ink)) 6ch)');
  });
});

describe('an injection test’s words and marks', () => {
  /** The last rule naming `selector`, with its declarations. */
  const last = (selector: string) => rules().filter((r) => r.selectors.includes(selector)).at(-1);

  it('sets the untrusted tag, the canary, the report’s example mask and a gate check’s marks at 4.5:1 on every surface', () => {
    const words = ['.eff.untrusted', '.cnry', '.injmask', '.injmask .del', '.injmask .add', '.injmask .why', '.banner .injline', '.banner .injline .pwhy', 'table.gt .chk .ck.passed .cm', 'table.gt .chk .ck.failed .cm', 'table.gt .chk .ck.inconclusive .cm'];
    const low: string[] = [];
    for (const w of words) {
      const c = last(w)?.decls.get('color');
      expect(c, w).toBeDefined();
      for (const s of SURFACES) {
        const x = ratio(resolve(c!)!, resolve(`var(${s})`)!);
        if (x < 4.5) low.push(`${w} on ${s}: ${x.toFixed(2)}:1`);
      }
    }
    expect(low).toEqual([]);
  });

  it('sets the canary and the planted text at 4.5:1 on their own tint, over every surface: a tint over transparent is the sheet-wide check’s blind spot', () => {
    const low: string[] = [];
    for (const mark of ['mark.cnry', 'mark.ins-plant']) {
      const r = last(mark)!;
      const tint = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*transparent\)$/.exec(r.decls.get('background') ?? '');
      expect(tint, mark).not.toBeNull();
      for (const s of SURFACES) {
        // A tint over transparent shows the surface under it: the colour mixed into that surface.
        const ground = resolve(`color-mix(in srgb, ${tint![1]} ${tint![2]}%, var(${s}))`)!;
        const x = ratio(resolve(r.decls.get('color')!)!, ground);
        if (x < 4.5) low.push(`${mark} on its tint over ${s}: ${x.toFixed(2)}:1`);
      }
    }
    expect(low).toEqual([]);
  });
});

/**
 * Quiet by colour, never by opacity: a faded word drew at a contrast no colour token gives, and nested
 * panels multiplied it. What fades is a control that waits or is off and says why in words (its
 * card, aria-disabled and a toast on a press), a reveal from nothing on hover or focus, a mark with
 * no text, and a toast fading out: each such rule is named here with its reason.
 */
const FADES: Record<string, string> = {
  '.btn[disabled]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.btn[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.linkbtn[disabled]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.linkbtn[disabled]:hover': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.linkbtn[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.linkbtn[aria-disabled="true"]:hover': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.switch:disabled i': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.switch[aria-disabled="true"] i': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.arow:hover .adis[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.arow:focus-within .adis[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.arow .adis[aria-disabled="true"]:focus-visible': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.arow .adis[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.calside .linkbtn[disabled]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.calside .linkbtn[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.set table.ruletable td.num .linkbtn[disabled]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.set table.ruletable td.num .linkbtn[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.fold[disabled]': 'a folder that can’t be added, the line under the list saying why',
  '.pop button[disabled]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.pop button[aria-disabled="true"]': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '[data-why][aria-disabled="true"]:not(.btn, .linkbtn, .rk, .switch, .pop button, .adis)': 'a control that waits or is off, and says why in words: its card, aria-disabled and a toast on a press',
  '.pop .px': 'a control drawn from nothing on its row’s hover or focus, whole once shown',
  '.arow .adis': 'a control drawn from nothing on its row’s hover or focus, whole once shown',
  'table.gt .chk .cka': 'a control drawn from nothing on its row’s hover or focus, whole once shown',
  '.trusttab .trustbtn': 'a control drawn from nothing on its row’s hover or focus, whole once shown, and always on a touch screen',
  '.cal.has-sel button.cd:not(.on)': 'a calendar day outside the days picked: a mark with no text',
  '.cal.hist.has-sel button.cd.hb:not(.on)': 'a calendar day outside the days picked: a mark with no text',
  '.cells button.dim': 'a strip cell the filter leaves out: a mark with no text',
  '.callrow li.dim > :not(.cl)': 'a call’s dot outside blame’s scope; its number stays in the faint text colour',
  '.toast.out': 'a toast fading out as it goes',
  '.toast .tx': 'the toast’s ×, a control: 3:1 or more at .7 on the toast’s ground, checked below',
};

describe('quiet by colour', () => {
  it('fades nothing under full opacity but the rules named with their reasons', () => {
    const faded = styleRules().flatMap((r) => (r.decls.some(([p, v]) => p === 'opacity' && Number(v) < 1) ? r.selectors : []));
    expect(faded.filter((s) => !(s in FADES))).toEqual([]);
    expect(Object.keys(FADES).filter((s) => !faded.includes(s))).toEqual([]);
  });

  it('draws the toast’s × at 3:1 or more on the toast’s ground, faded to .7 as it is', () => {
    const [ink, ground] = [resolve('var(--bg)')!, resolve('var(--ink)')!];
    const x = [0, 1, 2].map((i) => Math.round(ink[i] * 0.7 + ground[i] * 0.3)) as Rgb;
    expect(ratio(x, ground)).toBeGreaterThanOrEqual(3);
  });
});
