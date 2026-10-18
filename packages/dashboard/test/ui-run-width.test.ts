import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CallRow } from '../ui/types.js';
import { Inspector } from '../ui/run/Inspector.js';

/**
 * A long command line or model id never makes a run's page wider than the window: a 266-character
 * command and a fine-tuned model id made it 2,191 px wide at 1440, its command cut at the window's
 * edge with nothing to read the rest by, the inspector's tokens and latency cut off, and at 390 the
 * whole page scrolled sideways.
 */

const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8');

/** The declarations of the rule for `selector` at the top level of the stylesheet (not inside a media query). */
function topRule(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        const head = css.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (head.split(',').map((s) => s.trim()).includes(selector)) return css.slice(i + 1, css.indexOf('}', i));
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    }
  }
  throw new Error(`no top-level rule for ${selector}`);
}

const MODEL = 'ft:gpt-4o-mini-2024-07-18:northwind-support:refund-agent-v3:9XyZabcd';

describe('a run page with a long command and model id', () => {
  it('wraps the header’s command at every width, three lines at most', () => {
    const rule = topRule('.rhead .meta > code.cmd');
    expect(rule).toMatch(/white-space: normal/);
    expect(rule).toMatch(/overflow-wrap: anywhere/);
    expect(rule).toMatch(/max-width: 100%/);
    expect(rule).toMatch(/-webkit-line-clamp: 3/);
  });

  it('cuts a metric’s note rather than the page', () => {
    expect(topRule('.metric')).toMatch(/min-width: 0/);
    expect(topRule('.metric span')).toMatch(/text-overflow: ellipsis/);
  });

  it('lets the model id give way in the inspector, keeping its tokens and latency in view', () => {
    expect(topRule('.ihead .isum')).toMatch(/min-width: 0/);
    expect(topRule('.ihead .isum .im')).toMatch(/text-overflow: ellipsis/);
    expect(topRule('.ihead .isum .ir')).toMatch(/flex: none/);
    const call = { callNo: 1, kind: 'api', name: 'POST /v1/chat/completions', origin: 'live', effect: null, outcome: 'ok', model: MODEL, latencyMs: 812, usage: { input: 1200, output: 56, cacheRead: 0, cacheWrite: 0 }, attempts: 1 } as unknown as CallRow;
    const html = renderToStaticMarkup(createElement(Inspector, { runId: 'R', call, calls: [call], detail: null, error: null, tab: 'conversation', onTab: () => undefined, onStep: () => undefined, change: null, live: false }));
    const isum = /<span class="isum" title="([^"]*)">(.*?)<\/span><\/div>/.exec(html);
    expect(isum?.[1]).toBe(`${MODEL} · 1.2k → 56 · 812 ms`);
    expect(isum?.[2]).toContain(`<span class="im">${MODEL}</span>`);
    expect(isum?.[2]).toContain('<span class="ir"> · 1.2k → 56 · 812 ms</span>');
  });
});
