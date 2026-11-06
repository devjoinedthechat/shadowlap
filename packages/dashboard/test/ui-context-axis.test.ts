import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CallRow, RunDetail } from '../ui/api.js';
import { inputTicks, outputTop, tickLabel } from '../ui/run/context-axis.js';
import { ContextView } from '../ui/run/ContextView.js';

/** Context's axes: the input's ticks by a round step, and the output's own scale, as the mock draws them. */
describe('Context’s axes', () => {
  it('ticks the input by the first round step that gives at most four above 0', () => {
    expect(inputTicks(300)).toEqual([0, 100, 200, 300]);
    expect(inputTicks(400)).toEqual([0, 100, 200, 300, 400]);
    expect(inputTicks(401)).toEqual([0, 200, 400]);
    expect(inputTicks(1_800)).toEqual([0, 500, 1000, 1500]);
    expect(inputTicks(38_000)).toEqual([0, 10000, 20000, 30000]);
    // Past 200,000 tokens, by 100,000.
    expect(inputTicks(350_000)).toEqual([0, 100000, 200000, 300000]);
    expect(inputTicks(0)).toEqual([0]);
  });

  it('reads a thousand as 1k', () => {
    expect([0, 500, 1000, 1500, 20000].map(tickLabel)).toEqual(['0', '500', '1k', '1.5k', '20k']);
  });

  it('tops the output’s axis at the next 50 up, at least 50', () => {
    expect(outputTop(0)).toBe(50);
    expect(outputTop(40)).toBe(50);
    expect(outputTop(50)).toBe(50);
    expect(outputTop(51)).toBe(100);
    expect(outputTop(1_234)).toBe(1250);
  });
});

describe('Context’s chart', () => {
  const call = (callNo: number, cacheRead: number, cacheWrite: number, input: number, output: number) => ({ callNo, kind: 'api', outcome: 'ok', usage: { input, output, cacheRead, cacheWrite } }) as unknown as CallRow;
  const run = { run: { divergence: null }, cache: { misses: [] } } as unknown as RunDetail;
  /** The words of the axis drawn by the element that opens with `open`. */
  const axis = (html: string, open: string) => {
    const at = html.indexOf(open);
    return at < 0 ? null : html.slice(at, html.indexOf('</div>', at)).split(/<[^>]*>/).filter((t) => t.trim());
  };

  it('labels the input’s axis with its gridlines, and the output’s own axis down from the baseline, both for the eye alone', () => {
    // The largest context is 1,800 tokens, so the input ticks by 500; the largest output is 120, so its axis tops at 150.
    const html = renderToStaticMarkup(createElement(ContextView, { run, calls: [call(1, 0, 1200, 300, 40), call(2, 1200, 400, 200, 120)], selected: 2, onSelect: () => undefined }));
    expect(axis(html, '<div class="yaxis" aria-hidden="true">')).toEqual(['0', '500', '1k', '1.5k']);
    expect(html.match(/<span class="gl" style="bottom:(.*?)"/g)).toEqual(['27.78%', '55.56%', '83.33%'].map((b) => `<span class="gl" style="bottom:${b}"`));
    expect(axis(html, '<div class="yaxis yout" aria-hidden="true">')).toEqual(['75', '150']);
    // Each output hangs from the baseline on its own scale: 40 and 120 of 150.
    const outs = html.slice(html.indexOf('<div class="couts">'), html.indexOf('</div>', html.indexOf('<div class="couts">')));
    expect(outs).toBe('<div class="couts"><i style="height:26.67%"></i><i style="height:80.00%"></i>');
    expect(html.indexOf('<div class="cplot">')).toBeGreaterThan(-1);
  });

  it('draws no axis without a model call to chart', () => {
    const empty = renderToStaticMarkup(createElement(ContextView, { run, calls: [], selected: null, onSelect: () => undefined }));
    expect(empty).toContain('No model calls yet.');
    expect(axis(empty, '<div class="yaxis"')).toBeNull();
  });
});
