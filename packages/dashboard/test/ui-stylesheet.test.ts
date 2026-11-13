import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sheet, sheetFiles, styleRules } from './css-sheet.js';

/**
 * The stylesheet is a file per area of the dashboard (ui/css/), joined by ui/app.css's @imports in an
 * order that keeps every rule after the ones it overrides: app.css holds nothing else, each area file
 * is joined once and imports nothing itself, and what a file loads (the fonts) is where its path says.
 * Its tokens hold the design's locked scales: the type, the radii and the spacing.
 */

const APP = new URL('../ui/app.css', import.meta.url);
const CSS = new URL('../ui/css/', import.meta.url);
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the stylesheet’s files', () => {
  it('joins every area file once, from app.css, which holds nothing but its imports', () => {
    const joined = sheetFiles().map((f) => fileURLToPath(f));
    const files = readdirSync(CSS)
      .filter((f) => f.endsWith('.css'))
      .map((f) => fileURLToPath(new URL(f, CSS)));
    expect([...joined].sort()).toEqual([...files].sort());
    expect(new Set(joined).size).toBe(joined.length);
    expect(joined[0]).toMatch(/tokens\.css$/);
    const rest = strip(readFileSync(APP, 'utf8')).replace(/^@import\s+[^;]+;\s*$/gm, '');
    expect(rest.trim()).toBe('');
  });

  it('imports nothing from an area file, and loads each font from where it is', () => {
    for (const file of sheetFiles()) {
      const text = strip(readFileSync(file, 'utf8'));
      expect(text, fileURLToPath(file)).not.toMatch(/@import/);
      for (const m of text.matchAll(/url\(\s*['"]?(?!data:)([^'")]+)['"]?\s*\)/g)) expect(existsSync(new URL(m[1], file)), `${fileURLToPath(file)}: ${m[1]}`).toBe(true);
    }
    expect(strip(sheet())).toMatch(/@font-face/);
  });
});

describe('the type, radius and spacing tokens', () => {
  /** The value each custom property takes on :root. */
  const root = new Map(styleRules().filter((r) => r.selectors.includes(':root')).flatMap((r) => r.decls));

  it('locks the type scale, its small-caps tracking, the five radii and two shapes, and the spacing', () => {
    const scale = ['--fs-caps', '--fs-label', '--fs-small', '--fs-quiet', '--fs-body', '--fs-section', '--fs-step', '--fs-heading', '--fs-title'].map((t) => root.get(t));
    expect(scale).toEqual(['10px', '11px', '12px', '12.5px', '13.5px', '14px', '15px', '17px', '24px']);
    expect(root.get('--caps')).toBe('.1em');
    expect(['--r-mark', '--r-chip', '--r-control', '--r-box', '--r-overlay', '--r-pill', '--r-dot'].map((t) => root.get(t))).toEqual(['2px', '6px', '8px', '10px', '14px', '999px', '50%']);
    expect(['--gap-text', '--gap-verdict', '--gap-section', '--bleed'].map((t) => root.get(t))).toEqual(['12px', '24px', '32px', '12px']);
  });

  it('sizes inline code no rule sizes at most at the quiet size, and sets bold at 600', () => {
    const base = new Map(styleRules().filter((r) => !r.conditions.length && (r.selectors.includes('code') || r.selectors.includes('b'))).flatMap((r) => r.decls));
    expect(base.get('font-size')).toBe('min(1em, var(--fs-quiet))');
    expect(base.get('font-weight')).toBe('600');
  });

  /** A selector with its :not()s left out, which may hold a list or a space of their own. */
  const shorn = (selector: string) => selector.replace(/:not\([^)]*\)/g, '');
  /** A compound's tag and classes, its :not() left out. */
  const parts = (compound: string) => {
    const c = shorn(compound);
    return { tag: /^[a-z][\w-]*/.exec(c)?.[0] ?? null, classes: [...c.matchAll(/\.([\w-]+)/g)].map((m) => m[1]) };
  };
  /** A selector list split at its own commas, never at one inside a :not(). */
  const listOf = (list: string) => {
    const out = [''];
    let depth = 0;
    for (const ch of list) {
      if (ch === ',' && !depth) out.push('');
      else {
        depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
        out[out.length - 1] += ch;
      }
    }
    return out.map((x) => x.trim()).filter(Boolean);
  };
  /** Whether an element `s` names is one `x` names too: x's last compound in s's, and x's other classes around it. */
  const covers = (x: string, s: string) => {
    const xs = shorn(x).trim().split(/\s+/);
    const ss = shorn(s).trim().split(/\s+/);
    const [xl, sl] = [parts(xs.at(-1)!), parts(ss.at(-1)!)];
    const around = new Set(ss.slice(0, -1).flatMap((c) => parts(c).classes));
    return (!xl.tag || xl.tag === sl.tag) && xl.classes.every((c) => sl.classes.includes(c)) && xs.slice(0, -1).every((c) => parts(c).classes.every((k) => around.has(k)));
  };

  it('raises every label under 11px to the label size on a phone, its avatars’ initials aside', () => {
    const floor = styleRules().find((r) => r.conditions.includes('@media (max-width: 640px)') && r.selectors.some((s) => s.startsWith(':is(#root, body) :is(')) && r.decls.some(([p, v]) => p === 'font-size' && v === 'var(--fs-label)'));
    expect(floor).toBeDefined();
    const raised = floor!.selectors.flatMap((s) => {
      const list = /^:is\(#root, body\) :is\(([\s\S]*)\)$/.exec(s)?.[1];
      return list ? listOf(list) : [];
    });
    const small: string[] = [];
    for (const r of styleRules()) {
      if (r.conditions.some((c) => /forced-colors/.test(c))) continue;
      const font = r.decls.find(([p]) => p === 'font-size' || p === 'font');
      // A size given as a type token (10px for --fs-caps) is read as the token's own.
      const size = font?.[1].replace(/var\((--fs-[\w-]+)\)/g, (_, t: string) => root.get(t) ?? '');
      const px = size ? Number(/(\d+(?:\.\d+)?)px/.exec(size)?.[1]) : NaN;
      if (!(px < 11)) continue;
      // An avatar's initials, and a tick drawn in its circle, keep the size their circle sets.
      for (const s of r.selectors) if (!/\.av\b|\.ondisk(\.steps)? li i$/.test(s) && !raised.some((x) => covers(x, s))) small.push(s);
    }
    // what a pseudo-element can't be raised by inside :is() is raised by a rule of its own
    const own = styleRules().filter((r) => r.conditions.includes('@media (max-width: 640px)') && r.selectors.includes(':is(#root, body) .fxtable td::before'));
    expect(own.flatMap((r) => r.decls).filter(([p]) => p === 'font-size')).toEqual([['font-size', 'var(--fs-label)']]);
    expect(small.filter((s) => s !== '.fxtable td::before')).toEqual([]);
  });

  it('never lowers a column head on a phone: a numeric column’s head is at the label scale already', () => {
    for (const s of ['table.t th.num', 'table.calls th.num', 'table.calls th.n']) {
      const font = styleRules().filter((r) => !r.conditions.length && r.selectors.includes(s)).flatMap((r) => r.decls).filter(([p]) => p === 'font');
      expect(font.at(-1)?.[1], s).toBe('500 10px var(--mono)');
    }
  });
});

describe('reduced motion', () => {
  it('stills every animation and transition, the pseudo-elements’ too: the live tag’s pulse, a switch’s knob, a caret', () => {
    const still = styleRules().find((r) => r.conditions.includes('@media (prefers-reduced-motion: reduce)') && r.selectors.includes('*'));
    expect(still?.selectors).toEqual(['*', '*::before', '*::after']);
    expect(still?.decls).toEqual([
      ['animation', 'none !important'],
      ['transition', 'none !important'],
    ]);
  });
});
