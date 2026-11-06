import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, Store, type BlameReport } from '@shadowlap/engine';
import { blameReport, makeRun } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import type { Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { minuteStamp } from '../ui/format.js';
import { GLOSSARY } from '../ui/glossary.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A fix's steps as they render, from the read model's own answer for a store built here: each opens
 * on its verdict line and the finding under it, then its parts as sections, its rows' attempts in
 * one Attempts cell each, and its receipts in grey lines over its command.
 */

let store: Store;
let r: Rendered | null = null;
const DAY = 24 * 60 * 60 * 1000;
let at = 100 * DAY;
const SEND_ONCE = { tools: { send_email: 1 } };
/** A run of seven calls, a model call every other one, so the probes at #1, #5 and #7 are model calls 1, 3 and 4. */
const CALLS = ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] as const;

beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
});

/** The fixtures read the engine's sources, this file the engine as it is built: one store either way. */
const engineStore = () => store as unknown as Parameters<typeof makeRun>[0];

function app(): AppState {
  const client = {
    fix: (id: string) => Promise.resolve(fixDetail(store, id)),
    jobs: () => Promise.resolve([]),
    attemptGroups: () => Promise.resolve({ blame: null, verify: [], cut: false }),
    startJob: () => new Promise(() => undefined),
  } as unknown as Client;
  return { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
}

async function open(fixId: string, step: string): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app() }, createElement(FixPage, { id: fixId, step, sub: null })));
  await r.until('the fix to load', () => r!.all('h1').length === 1);
  return r;
}

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const tip = (el: FakeElement): string => (JSON.parse(el.getAttribute('data-tip') ?? '{}') as { t?: string }).t ?? '';

/** A run blamed under the fix's check, opening the fix or joining the one its label points to. */
function blamed(o: { report?: (run: string) => BlameReport; label?: string; run?: string } = {}) {
  const run = o.run ?? makeRun(engineStore(), { labels: [o.label ?? 'double-email'], calls: [...CALLS] });
  const report = o.report?.(run) ?? blameReport(run);
  const { fix } = recordBlame(store, { runId: run, report, expect: SEND_ONCE, scope: null, command: `shadowlap blame ${run}`, title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
  return { run, fixId: fix.fixId, at };
}

describe('the Blame step', () => {
  it('opens on its verdict line: blamed in ink, each probe’s tally a part kept whole, where and how sure under it, its links, then what was found', async () => {
    const { run, fixId } = blamed();
    const d = fixDetail(store, fixId)!;
    await open(fixId, 'blame');
    expect(text(r!.one('.verdict .vw'))).toBe('blamed');
    expect(r!.one('.verdict .vw').className).toBe('vw done');
    // The blamed call's tally, then the next one's: each part whole, the head breaking only between them.
    expect(r!.all('.verdict h2 .nw').map(text)).toEqual(['2 of 4 rescued from #5', '0 of 4 from #7']);
    expect(text(r!.one('.verdict p'))).toBe(`#5 · model call 3 of 4 · in ${run.slice(0, 10)} · confidence high`);
    // Why it is that sure is on the confidence's card, not the line's title.
    expect(JSON.parse(r!.one('.verdict p .dtip').getAttribute('data-tip')!)).toMatchObject({ t: 'confidence high', s: d.blame!.confidenceWhy });
    expect(r!.all('.verdict .actions a').map((a) => [text(a), a.getAttribute('href')])).toEqual([
      ['Open run at #5', `#/run/${run}/5`],
      ['Open rescued fork', d.blame!.hrefs.rescued],
    ]);
    expect(text(r!.one('p.fxsay'))).toBe(d.blame!.line.finding!.replace(/\s+/g, ' '));
    // The step's parts are sections, labelled in sentence case.
    expect(r!.all('section.panel.sec > header h2').map(text)).toEqual(['Where the run was lost', 'At call #5', 'Probes']);
    expect(r!.all('.ans .lbl').map(text)).toEqual(['The recording', 'A rescued fork']);
  });

  it('draws each probe’s tally over its call, says each call on hover, and keys only what the row shows', async () => {
    const { fixId } = blamed();
    await open(fixId, 'blame');
    const cells = r!.all('ol.callrow li');
    expect(cells.map((li) => text(li.querySelector('.pp')!))).toEqual(['2/3', '', '', '', '2/4', '', '0/4']);
    expect(cells.map((li) => li.className)).toEqual(['m ok', 't', 'm', 't', 'm hot', 't', 'm lost']);
    expect(r!.all('ol.callrow .cn').map(tip)).toEqual([
      '#1 · rescued · 2 of 3',
      '#2 · tool call',
      '#3 · not probed: the search skipped it',
      '#4 · tool call',
      '#5 · blamed: the last call that still rescues the run · rescued · 2 of 4',
      '#6 · tool call',
      '#7 · lost · 0 of 4',
    ]);
    // A call keeps its name for a screen reader.
    expect(r!.all('ol.callrow .cn')[0].getAttribute('aria-label')).toBe('Call #1');
    // Rescued and lost are defined terms, each with its definition for a screen reader.
    expect(r!.all('.legend.fxleg > span').map(text)).toEqual([`rescued${GLOSSARY.rescued}`, `lost${GLOSSARY.lost}`, 'blamed: the last call that still rescues the run', 'ring: model call · dot: tool call']);
  });

  it('lists the probes in one Attempts cell each, the verdict a status, the attempts under a row on request', async () => {
    const { fixId } = blamed();
    await open(fixId, 'blame');
    expect(r!.all('table.probes thead th').map(text)).toEqual(['Call', 'Model call', 'Attempts', 'Verdict']);
    const rows = r!.all('table.probes tbody tr');
    expect(rows.map((x) => text(x.querySelector('.acell')!))).toEqual(['2 of 3', '2 of 4', '0 of 4']);
    expect(rows.map((x) => [text(x.querySelector('.pv .st')!), x.querySelector('.pv .st')!.className])).toEqual([
      ['rescued', 'st ok'],
      ['rescued', 'st ok'],
      ['lost', 'st err'],
    ]);
    // The blamed call is marked apart, in ink, after a space a screen reader hears.
    expect(text(rows[1].querySelector('.pv')!)).toBe('rescued blamed');
    expect(rows[1].className).toBe('hot');
    expect(r!.all('.pips')).toEqual([]);
    const toggle = rows[1].querySelector('button.xbtn')!;
    expect(toggle.getAttribute('aria-label')).toBe('Show 4 attempts');
    await r!.click(toggle);
    await r!.until('the attempts', () => r!.all('table.probes tr.sub').length === 1);
    expect(r!.all('table.probes tr.sub .alist .al')).toHaveLength(4);
    expect(r!.one('table.probes tr.sub > td > div').getAttribute('id')).toBe(r!.one('table.probes tr.open button.xbtn').getAttribute('aria-controls'));
  });

  it('ends on one grey line of what it cost, the judge’s checks apart, the fix’s other blames newest first, and its command', async () => {
    // Another failing run of the fix, then the shown run, stopped first and blamed after.
    const other = blamed({ report: (run) => blameReport(run, 'unrescuable') });
    const before = blamed({ report: (run) => blameReport(run, 'stopped') });
    const shown = blamed({ run: before.run, report: (run) => Object.assign(blameReport(run), { judge: { upstreamRequests: 9, spent: 0.0047 } }) });
    await open(shown.fixId, 'blame');
    const receipts = r!.all('.fxreceipt').map(text);
    expect(receipts[0]).toBe('11 attempts · 22 upstream requests · ≈$0.110 spent · judge checks: 9 upstream requests, ≈$0.0047 · every call before a probe replayed from the recording');
    expect(receipts.slice(1)).toEqual([`Blamed before, ${minuteStamp(before.at)}: stopped.`, `Also blamed ${other.run.slice(0, 10)}, ${minuteStamp(other.at)}: not rescued.`]);
    expect(r!.one(`.fxreceipt a[href="#/run/${other.run}"]`)).toBeTruthy();
    expect(text(r!.one('.cmdline'))).toContain(`shadowlap blame ${shown.run}`);
  });

  it('says a stopped search, a first probe that couldn’t tell and a run no call rescued, each in its words and with its link', async () => {
    const stopped = blamed({ report: (run) => blameReport(run, 'stopped') });
    await open(stopped.fixId, 'blame');
    expect([text(r!.one('.verdict .vw')), text(r!.one('.verdict h2'))]).toEqual(['stopped', 'stopped Rescued up to #1 so far']);
    expect(text(r!.one('.verdict p'))).toBe(`in ${stopped.run.slice(0, 10)} · confidence low`);
    expect(r!.all('.verdict .actions a').map(text)).toEqual(['Open run at #1']);
    expect(text(r!.all('section.panel.sec > header .sub')[0])).toBe('stopped before the search finished');
    expect(text(r!.one('.fxnote'))).toBe('Run blame again searches from the first model call: blame keeps no search to resume.');
    await r!.unmount();
    const none = blamed({ report: (run) => blameReport(run, 'unrescuable'), label: 'digest' });
    await open(none.fixId, 'blame');
    expect([text(r!.one('.verdict .vw')), r!.all('.verdict .actions a').map((a) => [text(a), a.getAttribute('href')])]).toEqual(['not rescued', [['Open run', `#/run/${none.run}`]]]);
    expect(text(r!.one('.verdict p'))).toBe(`#1 · model call 1 of 4 · in ${none.run.slice(0, 10)} · confidence high`);
    expect(text(r!.all('section.panel.sec > header .sub')[0])).toBe('no probe rescued the run');
    await r!.unmount();
    const unsure = blamed({ report: (run) => Object.assign(blameReport(run, 'unrescuable'), { probes: blameReport(run, 'unrescuable').probes.map((p) => ({ ...p, decision: 'inconclusive' as const })) }), label: 'triage' });
    await open(unsure.fixId, 'blame');
    expect([text(r!.one('.verdict .vw')), r!.all('.verdict .actions a').map((a) => [text(a), a.getAttribute('href')])]).toEqual(['inconclusive', [['Open run at #1', `#/run/${unsure.run}/1`]]]);
    expect(text(r!.all('section.panel.sec > header .sub')[0])).toBe('inconclusive: the first probe couldn’t tell');
  });
});
