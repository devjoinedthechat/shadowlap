import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chips } from '../ui/components/bits.js';
import { COPY_FILTER_PLACEHOLDER, FILTER_PLACEHOLDER, matchWords, RunsFilterField } from '../ui/runspage/FilterField.js';
import { RunsTable, RunsTableEmpty, type TableRun } from '../ui/runspage/RunsTable.js';
import { RUN_CHIPS, type RunChip } from '../ui/runs.js';
import type { ChipCounts } from '../ui/types.js';
import { styleRules } from './css-sheet.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Runs' table as the design draws it: a section with no card of its own, close under the chips; the
 * checkbox's whole cell picks its row, a 44px target on a touch screen, and never opens the run; a
 * list with nothing to show says so in a line from the left; a phone's row marks what needs a look as
 * the sidebar's does, so it gives way the same; and the chips say the design's words, a space a
 * screen reader says before each count.
 */

const RUN = '01K8RG00000000000000000001';
const ROW = { runId: RUN, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node agent.mjs', codeVersion: null, startedAt: 0, calls: 6, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'recording', outcome: { kind: 'lost', callNo: 9 }, failed: true, about: { text: 'refund flow', from: 'user' } } as unknown as TableRun;

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

function addressBar() {
  const location = { hash: '#/runs', search: '', pathname: '/' };
  vi.stubGlobal('location', location);
  return location;
}

async function table(onPick: (run: TableRun, on: boolean) => void) {
  r = await render(createElement(RunsTable, { rows: [ROW], picked: new Set<string>(), selectable: true, byColumn: false, sort: 'when', onSort: () => undefined, onPick, onPickAll: () => undefined, now: 60_000 }));
  return r;
}

describe('a run’s row', () => {
  it('picks the run from anywhere in the checkbox’s cell, and opens it from anywhere else', async () => {
    const at = addressBar();
    const t = await table(() => undefined);
    const cell = t.one('tbody td.selcell');
    expect(cell.children[0]?.tagName).toBe('LABEL');
    expect(t.one('tbody td.selcell label.selhit input[type="checkbox"]').getAttribute('aria-label')).toBe('Select 01K8RG0000');
    // The cell's padding is the checkbox's target too: a press there leaves the page where it is.
    await t.click(cell);
    expect(at.hash).toBe('#/runs');
    await t.click(t.one('tbody td.selcell input'));
    expect(at.hash).toBe('#/runs');
    await t.click(t.one('tbody td.abcell'));
    expect(at.hash).toBe(`#/run/${RUN}`);
  });

  it('marks what needs a look after a phone’s about line as one that gives way, as the sidebar’s', async () => {
    const t = await table(() => undefined);
    expect(t.one('tbody .rline .rso').getAttribute('data-gives')).toBe('');
  });
});

describe('a list with nothing to show', () => {
  const counts = { all: 3 } as ChipCounts;
  const said = async (props: Parameters<typeof RunsTableEmpty>[0]) => {
    r = await render(createElement('div', null, createElement(RunsTableEmpty, props)));
    const el = r.all('p.emptyline, div.empty')[0];
    const out = el ? [el.tagName, el.textContent] : null;
    await r.unmount();
    r = null;
    return out;
  };

  it('says why in a line from the left, and keeps the reading and the failing in the table’s box', async () => {
    const base = { error: null, loaded: true, shown: 0, counts, days: null };
    expect(await said(base)).toEqual(['P', 'No runs match.']);
    expect(await said({ ...base, counts: { all: 0 } as ChipCounts, days: { from: '2026-10-20', to: '2026-10-22' } })).toEqual(['P', 'No runs on the days picked.']);
    expect(await said({ ...base, counts: { all: 0 } as ChipCounts })).toEqual(['DIV', 'No runs yet. Record one with shadowlap run -- <command>.']);
    expect(await said({ ...base, loaded: false })).toEqual(['DIV', 'Loading runs…']);
    expect(await said({ ...base, error: new Error('the store is busy') })).toEqual(['DIV', 'The runs could not be read: the store is busy']);
    // Rows still shown while another page fails say nothing over them.
    expect(await said({ ...base, shown: 2, error: new Error('the store is busy') })).toBeNull();
  });
});

describe('the chips', () => {
  it('say the design’s words, with a space only a screen reader says before each count', async () => {
    expect(RUN_CHIPS.map(([, label]) => label)).toEqual(['All', 'Recordings', 'Forks', 'Clean replays', 'Test replays', 'Captures', 'Failed', 'Local']);
    const items = RUN_CHIPS.slice(0, 2).map(([key, label], i) => ({ key, label, count: 1200 * (i + 1) }));
    r = await render(createElement(Chips<RunChip>, { label: 'Kind of run', items, value: 'all', onChange: () => undefined }));
    const all = r.all('.chips button')[0];
    expect(all.childNodes[0]?.textContent).toBe('All');
    expect(all.textContent).toBe('All 1,200');
    expect(r.all('.chips button .srsp > .sr').map((s) => s.textContent)).toEqual([' ', ' ']);
  });

  it('are flat words, the one picked on a raised ground with a ring, each kept on one line', () => {
    const rules = styleRules().filter((x) => !x.conditions.length);
    const decl = (selector: string, prop: string) => rules.filter((x) => x.selectors.includes(selector)).flatMap((x) => x.decls.filter(([p]) => p === prop).map(([, v]) => v)).at(-1);
    expect(decl('.chips button', 'border')).toBe('0');
    expect(decl('.chips button', 'border-radius')).toBe('6px');
    expect(decl('.chips button', 'white-space')).toBe('nowrap');
    expect(decl('.chips button[aria-pressed="true"]', 'box-shadow')).toBe('0 0 0 1px var(--line2)');
    expect(decl('.srsp > .sr', 'white-space')).toBe('pre');
  });
});

describe('the table’s section', () => {
  it('has no card and no hairline under the chips, and gives the checkbox a 44px target on a touch screen', () => {
    const rules = styleRules();
    const decl = (selector: string, prop: string, condition?: string) =>
      rules
        .filter((x) => x.selectors.includes(selector) && (condition ? x.conditions.some((c) => c.includes(condition)) : !x.conditions.length))
        .flatMap((x) => x.decls.filter(([p]) => p === prop).map(([, v]) => v))
        .at(-1);
    expect(decl('.tbar ~ .panel.sec.runsec', 'border-top')).toBe('0');
    expect(decl('.tbar ~ .panel.sec.runsec', 'margin-top')).toBe('4px');
    expect(decl('table.runst td.selcell .selhit', 'width', 'pointer: coarse')).toBe('44px');
    expect(decl('table.runst td.selcell .selhit', 'min-height', 'pointer: coarse')).toBe('44px');
    expect(decl('.panel.sec .attn-more', 'padding-left')).toBe('0');
  });
});

describe('the filter', () => {
  const field = async (props: Partial<Parameters<typeof RunsFilterField>[0]>) => {
    r = await render(createElement(RunsFilterField, { value: '', onChange: () => undefined, settled: '', total: 207, loaded: true, ...props }));
    return r;
  };

  it('says what it takes, and on hover what each term does', async () => {
    const f = await field({});
    const input = f.one('.rqw label.tin.rq input#runsQuery');
    expect(input.getAttribute('type')).toBe('search');
    expect(input.getAttribute('placeholder')).toBe('Filter: words, label:, status:, type: or tool:');
    expect(input.getAttribute('title')).toBeNull();
    expect(JSON.parse(input.getAttribute('data-tip')!)).toMatchObject({ t: 'Filter runs', s: 'label:refund-bug · status:failed · type:fork · tool:issue_refund · words, which also search what runs recorded. Each narrows the others.' });
    expect(f.one('.rqw label .sr').textContent).toBe('Filter runs');
  });

  it('counts the runs that match while its words hold a term, its live region kept while it says nothing', async () => {
    let f = await field({});
    expect(f.one('.rqw .qn[role="status"]').textContent).toBe('');
    await f.unmount();
    f = await field({ value: 'status:failed refund', settled: 'status:failed refund' });
    expect(f.one('.rqw .qn[role="status"]').textContent).toBe('207 runs match');
    await f.unmount();
    // Still reading the table: no count until it is in.
    f = await field({ value: 'label:good', settled: 'label:good', loaded: false });
    expect(f.one('.rqw .qn').textContent).toBe('');
    expect([matchWords(1), matchWords(1200), matchWords(0)]).toEqual(['1 run matches', '1,200 runs match', '0 runs match']);
  });

  it('in an exported copy takes no tool:, and its card says no recorded text', async () => {
    const f = await field({ copy: true });
    const input = f.one('input#runsQuery');
    expect(input.getAttribute('placeholder')).toBe(COPY_FILTER_PLACEHOLDER);
    expect(COPY_FILTER_PLACEHOLDER).toBe('Filter: words, label:, status: or type:');
    expect(FILTER_PLACEHOLDER).toContain('tool:');
    expect(JSON.parse(input.getAttribute('data-tip')!).s).not.toMatch(/tool:|recorded/);
  });
});
