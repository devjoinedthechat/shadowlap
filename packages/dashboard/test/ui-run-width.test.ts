import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CallRow } from '../ui/types.js';
import { glued } from '../ui/format.js';
import { bannerFor } from '../ui/run/banner.js';
import { Inspector } from '../ui/run/Inspector.js';
import { DiffPanel } from '../ui/run/parts.js';
import { sheet, styleRules } from './css-sheet.js';

/**
 * A long command line or model id never makes a run's page wider than the window: a 266-character
 * command and a fine-tuned model id made it 2,191 px wide at 1440, its command cut at the window's
 * edge with nothing to read the rest by, the inspector's tokens and latency cut off, and at 390 the
 * whole page scrolled sideways.
 */

const css = sheet();

/** The declarations of every rule that names `selector` at the top level of the stylesheet (not inside a media query). */
function topRule(selector: string): string {
  let depth = 0;
  let start = 0;
  const found: string[] = [];
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        const head = css.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (head.split(',').map((s) => s.trim()).includes(selector)) found.push(css.slice(i + 1, css.indexOf('}', i)));
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    }
  }
  if (!found.length) throw new Error(`no top-level rule for ${selector}`);
  return found.join(';');
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

describe('a fork made with a long flag value, as every attempt of injection --clean is', () => {
  // At 390 px, a clean attempt's page was 414 px wide: its banner's flag, the --override of the
  // neutral page it was served, has no space to break at.
  const flag = '--override 7={"url":"https://example.com/a","title":"","text":""}';

  it('names the flag whole in its banner, which shows it as code', () => {
    const banner = bannerFor({
      status: 'completed',
      type: 'fork',
      divergence: { callNo: 9, type: 'request_changed', name: 'POST /v1/messages', replayedBefore: 8, diff: [{ path: '$.messages[4].content[0].content' }] },
      intervention: { flag: '--override', value: '7={"url":"https://example.com/a","title":"","text":""}', callNo: 7 },
      interventions: [{ flag: '--override', value: '7={"url":"https://example.com/a","title":"","text":""}', callNo: 7 }, { flag: '--writes', value: 'stub', callNo: null }],
      flagCall: { kind: 'tool', name: 'fetch_page', attempts: 0 },
      rescued: null,
      blame: null,
      notRecorded: null,
      checks: [],
      fix: null,
      upstreamRequests: 3,
    });
    expect(banner).toMatchObject({ kind: 'fork', flag, why: `tool #7 overridden with ${flag} · writes stubbed · 8 calls replayed before it` });
  });

  it('breaks the flag and a path anywhere where the banner wraps, so a phone never scrolls sideways', () => {
    expect(topRule('.banner')).toMatch(/flex-wrap: wrap/);
    expect(topRule('.banner .why code')).toMatch(/overflow-wrap: anywhere/);
    expect(topRule('.banner .path')).toMatch(/overflow-wrap: anywhere/);
  });
});

describe('a header line that wraps on a phone', () => {
  // At 390 px, the fork's banner went on with "· 16 calls replayed before it" and the fix's line
  // with "· verified 18:52": a line that starts with a separator reads as a slip.
  it('holds each separator to the item before it, so a wrapped line never starts with one', () => {
    expect(glued('tool #16 overridden · 16 calls replayed before it')).toBe('tool #16 overridden · 16 calls replayed before it');
    expect(glued('3 failing runs · 1 good · opened Oct 21')).toBe('3 failing runs · 1 good · opened Oct 21');
  });

  it('sets a run’s id in the face every other id is in, where 0 and O differ', () => {
    expect(topRule('.rtitle h1')).toMatch(/var\(--mono\)/);
  });
});

describe("a fork's diff panel", () => {
  // Each value is a block of its own (.val, .add), so it starts a line by itself: a line break before
  // it as well would put an empty line between a path and its value when the pane is copied.
  it('puts each value right after its path, the block starting its line', () => {
    const run = { run: { divergence: { type: 'request_changed', callNo: 17, kind: 'api', name: 'POST /v1/messages', replayedBefore: 16, counterpart: { callNo: 17 }, diff: [{ path: '$.messages[2].content[0].content', op: 'changed', before: 'EU limit: $150', after: 'EU limit: $50' }] } }, parent: null } as never;
    const html = renderToStaticMarkup(createElement(DiffPanel, { run }));
    expect(html).toContain('<span>$.messages[2].content[0].content<span class="val">');
    expect(html).toContain('<span>$.messages[2].content[0].content<span class="add">');
    expect(html).not.toMatch(/content\n<span/);
    expect(topRule('.diffpanel .val')).toMatch(/display: block/);
    expect(topRule('.diffpanel .add')).toMatch(/display: block/);
  });
});

describe('the status bar', () => {
  it('is drawn over the views pane, so a switch scrolled under it (Format JSON at 1180) never paints over it', () => {
    const bar = topRule('.status');
    expect(bar).toMatch(/position:\s*relative/);
    expect(bar).toMatch(/z-index:\s*[1-9]/);
  });
});

describe('Compare on a phone', () => {
  it('wraps what made a fork inside the prefix line, a quoted tool result and all, rather than run past the window', () => {
    const line = topRule('.prefix > span:last-child');
    expect(line).toMatch(/min-width:\s*0/);
    expect(line).toMatch(/overflow-wrap:\s*anywhere/);
    // A run id named where no run is: it breaks too.
    expect(topRule('.stepempty p code')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('what wraps rather than runs past its box', () => {
  it('wraps a job’s output in its drawer, and the folders it names, every line read whole', () => {
    expect(topRule('.drawer pre')).toMatch(/white-space:\s*pre-wrap/);
    expect(topRule('.drawer pre')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(topRule('.drawer .jfiles code')).not.toMatch(/nowrap|ellipsis/);
  });

  it('lets the note on what a run did not record take a phone’s whole width, its hint a sentence', () => {
    // At a phone's width the note goes under its label, as wide as the page: no baseline alignment left to hold it at its text's width.
    expect(css).toMatch(/@media \(max-width: 760px\) \{ \.rnote \{ flex-direction: column; align-items: stretch;/);
    // The hint wraps as text does, never as boxes, one of which would start a line with ". Or declare".
    expect(topRule('.rnhint')).not.toMatch(/display:\s*flex/);
    // Its code too, the config line to copy among it: a code in a sentence otherwise keeps to one line.
    expect(topRule('.rnhint code')).toMatch(/white-space:\s*normal/);
  });
});

describe('a call’s row in Calls', () => {
  it('draws a replayed call’s recorded duration in grey, the replay having waited for none of it', () => {
    expect(topRule('table.calls .num.was')).toMatch(/color:\s*var\(--faint\)/);
  });

  it('sets its number, details and time at 12.5px and the result under it at 11px, as the design does', () => {
    for (const s of ['table.calls .n', 'table.calls .det', 'table.calls .num']) expect(topRule(s)).toMatch(/font:\s*12\.5px var\(--mono\)/);
    expect(topRule('table.calls .res')).toMatch(/font:\s*11px var\(--mono\)/);
  });
});

/** A declaration of the rule for `selector` under exactly the media `conditions`, the last one set. */
function under(conditions: string[], selector: string, prop: string): string | null {
  let found: string | null = null;
  for (const r of styleRules()) if (r.conditions.join(' ') === conditions.join(' ') && r.selectors.includes(selector)) for (const [p, v] of r.decls) if (p === prop) found = v;
  return found;
}
const FROM_1001 = ['@media (min-width: 1001px)'];
const MID = ['@media (min-width: 1001px) and (max-width: 1159px)'];

describe('a run page’s views at every width', () => {
  it('scrolls the page from 1001px when the window is short, the views keeping 420px and the strip at the top', () => {
    expect(under(FROM_1001, '.rv', 'overflow-y')).toBe('auto');
    expect(under(FROM_1001, '.work', 'min-height')).toBe('420px');
    expect(under(FROM_1001, '.strip', 'position')).toBe('sticky');
    // Under the run id's card (30) and the job's drawer (35).
    expect(Number(under(FROM_1001, '.strip', 'z-index'))).toBeLessThan(30);
    // While a job's log shows, from 1281px, where the inspector sits beside the calls.
    expect(under(['@media (min-width: 1281px)'], 'body.docked:not(.dockfold) .work', 'min-height')).toBe('240px');
  });

  it('keeps the calls and the inspector side by side down to 1160px, the inspector at least 360px', () => {
    const side = ['@media (min-width: 1160px) and (max-width: 1280px)'];
    expect(under(side, '.work', 'grid-template-columns')).toBe('minmax(0, 1fr) minmax(360px, .62fr)');
    expect(under(side, '.views > .tabs button', 'padding-left')).toBe('8px');
    expect(under(['@media (max-width: 1159px)'], '.work', 'grid-template-rows')).toBe('minmax(280px, 1fr) minmax(320px, 1fr)');
  });

  it('keeps the calls list a box of its own height wherever the views take their content’s, so it draws only the rows in view', () => {
    expect(under(MID, '.work', 'flex')).toBe('none');
    expect(under(MID, '.vbody', 'max-height')).toBe('max(300px, 50vh)');
    expect(under(['@media (max-width: 1000px)'], '.vbody', 'max-height')).toBe('70vh');
    // 1001 to 1159px overrides the rules from 1001px and to 1159px, so it comes after both.
    const at = (c: string[]) => styleRules().findIndex((r) => r.conditions.join(' ') === c.join(' ') && r.selectors.includes('.work'));
    expect(at(MID)).toBeGreaterThan(at(FROM_1001));
    expect(at(MID)).toBeGreaterThan(at(['@media (max-width: 1159px)']));
  });

  it('keeps the strip’s key on a narrow screen, under cells that stay at the window’s top', () => {
    const narrow = ['@media (max-width: 1000px)'];
    expect(under(narrow, '.strip', 'display')).toBe('contents');
    expect(under(narrow, '.strip .cells', 'position')).toBe('sticky');
    expect(styleRules().some((r) => r.selectors.includes('.strip .legend') && r.decls.some(([p, v]) => p === 'display' && v === 'none'))).toBe(false);
  });

  it('fits a phone: no scope column, an origin’s word hidden inside its cell, the inspector’s tabs scrolling in their row', () => {
    expect(under(['@media (max-width: 640px)'], 'table.calls .hide-sm', 'display')).toBe('none');
    expect(under(['@media (max-width: 400px)'], 'table.calls .org .orgw', 'position')).toBe('absolute');
    expect(under(['@media (max-width: 400px)'], 'table.calls .org', 'position')).toBe('relative');
    expect(under(['@media (max-width: 359px)'], '.insp .tabs', 'overflow-x')).toBe('auto');
    expect(topRule('table.calls .scopecell code')).toMatch(/max-width:\s*140px/);
  });
});
