import { describe, expect, it } from 'vitest';
import { sheet } from './css-sheet.js';

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
const SURFACES = ['--bg', '--bg2', '--panel', '--raise', '--hover', '--sel', '--code'];

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
