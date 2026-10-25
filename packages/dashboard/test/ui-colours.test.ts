import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Each colour means one thing (the mock's consequence tokens): red only failed or blocked, amber
 * only needs a look or inconclusive, lime passed. A write is teal, its own kind of call, never the
 * failure red; stubbed is the stubbed origin's colour; money is a receipt, never amber; the blamed
 * call is marked in ink, since it rescued the run. Read from the stylesheet as the browser would:
 * the last top-level rule that names a selector wins.
 */

const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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
  it('has consequence colours of their own, and a write’s teal', () => {
    for (const token of ['--cq-red', '--cq-amber', '--cq-muted', '--cq-lime', '--k-write']) expect(value(':root', token), token).not.toBeNull();
    expect(value(':root', '--k-write')).toBe('#2dd4bf');
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
});
