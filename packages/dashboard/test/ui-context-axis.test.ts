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

  it('labels the open call whatever the step, the labels nearest it giving way, and the next ones on a phone', () => {
    /** Each label under the bars: its class and its words. */
    const labels = (n: number, selected: number) => {
      const html = renderToStaticMarkup(createElement(ContextView, { run, calls: Array.from({ length: n }, (_, i) => call(i + 1, 0, 1000, 100, 20)), selected, onSelect: () => undefined }));
      const row = html.slice(html.indexOf('<div class="clabels'), html.indexOf('</div>', html.indexOf('<div class="clabels')));
      return { cls: /<div class="([^"]*)"/.exec(row)![1], spans: [...row.matchAll(/<span(?: class="([^"]*)")?>([^<]*)<\/span>/g)].map((m) => `${m[1] ? `${m[1]}:` : ''}${m[2]}`) };
    };
    // 30 calls label every second; #6, off the step, keeps its label and #5's and #7's go.
    const off = labels(30, 6);
    expect(off.cls).toBe('clabels thin');
    expect(off.spans.slice(0, 10)).toEqual(['#1', '', 'near:#3', '', '', 'sel:#6', '', '', 'near:#9', '']);
    // #7, on the step: the ones a step away give way on a phone.
    expect(labels(30, 7).spans.slice(2, 11)).toEqual(['#3', '', 'near:#5', '', 'sel:#7', '', 'near:#9', '', '#11']);
    // Up to 22 calls every call is labelled; the stylesheet thins them on a phone.
    const all = labels(15, 4);
    expect(all.cls).toBe('clabels');
    expect(all.spans.slice(0, 5)).toEqual(['#1', '#2', '#3', 'sel:#4', '#5']);
  });

  it('draws no axis without a model call to chart', () => {
    const empty = renderToStaticMarkup(createElement(ContextView, { run, calls: [], selected: null, onSelect: () => undefined }));
    expect(empty).toContain('No model calls yet.');
    expect(axis(empty, '<div class="yaxis"')).toBeNull();
  });
});
