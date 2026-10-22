import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Outcomes, TodayCard } from '../ui/overview/panels.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { OverviewSummary, TestsTile, TodayPanel } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The Overview agrees with Tests and Fixes: its Tests tile and Today's Tests line count each golden by
 * its newest result, as Tests does, and Today's Blame counts blames.
 */

const app = (actionsOff: string | null = null) => ({ actionsOff, exported: false, meta: null, registerLayer: () => () => undefined }) as unknown as AppState;
const inApp = (el: ReactElement, actionsOff: string | null = null) => createElement(AppContext.Provider, { value: app(actionsOff) }, el);
const text = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();

const TILE: TestsTile = { goldens: 7, passing: 5, inconclusive: 0, untested: 1, lastWeek: null, regressions: 1, lastRunAt: null };
const TODAY: TodayPanel = {
  day: '2026-10-22',
  served: 120,
  notRespent: 0.72,
  recording: [],
  replays: 2,
  forks: { count: 14, live: 350, blocked: 48 },
  // Eight test replays today, two of them failed: the hover says so, the line counts goldens.
  tests: { count: 8, failed: 2, inconclusive: 0, latestFailure: { runId: '01M5H2EWWY8P621C63CJPVEM4A', outcome: { kind: 'diverged', callNo: 3 } } },
  // Four blames today, one of the three runs blamed twice: the line counts blames, the hover probes.
  blame: {
    blames: 4,
    probes: 12,
    attempts: 48,
    runs: ['01M5H2DJ1WDXDJVF85FRE4DWH5', '01M5H2DJR44BY5EG2RQD7M4TXP', '01M5H2E9Q2C6YDRJ11VPNM4W0J'].map((runId, i) => ({ runId, outcome: 'blamed' as const, lostAt: 5 + i, title: 'Refunds above the limit issued without approval', fixId: 'fx-01M5H2DV7NHAEH1GM5ARZXX3BG' })),
  },
};

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('the Overview’s tests and blames', () => {
  it('counts every golden by its newest result in the tile and in Today, with the replays on hover, and blames rather than probes', async () => {
    const outcomes = { reproduced: { value: 2, lastWeek: 0, open: 1 }, fixesVerified: { value: 1, lastWeek: 0, rejected: 1 }, testsPassing: TILE, spent: { value: 3, lastWeek: 0, notRespent: 0.72, notWaitedMs: 15_000 } } as OverviewSummary['outcomes'];
    r = await render(inApp(createElement('div', null, createElement(Outcomes, { o: outcomes, now: Date.now() }), createElement(TodayCard, { today: TODAY, live: [], tests: TILE }))));
    const tile = r.all('.kpi').find((k) => text(k.querySelector('.k')!) === 'Tests passing')!;
    expect(text(tile.querySelector('.kv b')!)).toBe('5 / 7');
    expect(tile.querySelector('.kv b')!.className).toBe('err');
    expect(text(tile.querySelector('.n')!)).toBe('1 failed · 1 not run yet');
    const rows = r.all('.ovtoday .attn a');
    const tests = rows.find((a) => text(a.querySelector('.t')!) === 'Tests')!;
    expect([text(tests.querySelector('.d')!), text(tests.querySelector('.go')!)]).toEqual(['1 failed · 1 not run yet', '7 goldens']);
    expect(tests.getAttribute('title')).toBe('8 test replays today · 2 failed, the newest diverged at #3');
    expect(tests.getAttribute('href')).toBe('#/tests');
    const blame = rows.find((a) => text(a.querySelector('.t')!) === 'Blame')!;
    expect(text(blame.querySelector('.go')!)).toBe('4 today');
    expect(blame.getAttribute('title')).toBe('12 probes · 48 attempts');
  });
});
