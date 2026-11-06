import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeedsLook, Outcomes } from '../ui/overview/panels.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { NeedsLookRow, OverviewSummary, TestsTile } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The Overview agrees with Tests and Fixes: its Tests tile counts each golden by its newest result,
 * as Tests does, and each line of Needs a look says where it leads, or Open where nothing runs.
 */

const app = (actionsOff: string | null = null) => ({ actionsOff, exported: false, meta: null }) as unknown as AppState;
const inApp = (el: ReactElement, actionsOff: string | null = null) => createElement(AppContext.Provider, { value: app(actionsOff) }, el);
const text = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();

const TILE: TestsTile = { goldens: 7, passing: 5, inconclusive: 0, untested: 1, lastWeek: null, regressions: 1, lastRunAt: null };
let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('the Overview’s tests', () => {
  it('counts every golden by its newest result in the tile', async () => {
    const outcomes = { reproduced: { value: 2, lastWeek: 0, open: 1 }, fixesVerified: { value: 1, lastWeek: 0, rejected: 1 }, testsPassing: TILE, spent: { value: 3, lastWeek: 0, notRespent: 0.72, notWaitedMs: 15_000 } } as OverviewSummary['outcomes'];
    r = await render(inApp(createElement('div', null, createElement(Outcomes, { o: outcomes, now: Date.now() }))));
    const tile = r.all('.kpi').find((k) => text(k.querySelector('.k')!) === 'Tests passing')!;
    expect(text(tile.querySelector('.kv b')!)).toBe('5 / 7');
    expect(tile.querySelector('.kv b')!.className).toBe('err');
    expect(text(tile.querySelector('.n')!)).toBe('1 failed · 1 not run yet');
  });
});

describe('Needs a look’s words', () => {
  const rows: NeedsLookRow[] = [
    { kind: 'test', icon: 'fail', title: 'A test failed: refund-in-limit', detail: 'diverged at call 3', action: 'Open', href: '#/run/01M5H2EWWY8P621C63CJPVEM4A', runId: '01M5H2EWWY8P621C63CJPVEM4A', fixId: null, at: 3 },
    { kind: 'unblamed', icon: 'fail', title: 'A run failed: 01M5H2F2QC digest', detail: 'not blamed yet', action: 'Run blame', href: '#/run/01M5H2F2QC9NCJ5PSZ0M4RX7VP', runId: '01M5H2F2QC9NCJ5PSZ0M4RX7VP', fixId: null, at: 2 },
    { kind: 'local', icon: 'rec', title: '12 runs are only on this machine', detail: 'push them so the team can open them', action: 'Push', href: '#/runs?types=local', runId: null, fixId: null, at: 0 },
  ];

  it('says where each line leads, and Open for every line where nothing runs', async () => {
    r = await render(inApp(createElement(NeedsLook, { items: rows, total: 3 })));
    expect(r.all('.needs .go').map(text)).toEqual(['Open →', 'Run blame →', 'Push →']);
    expect(r.all('.needs .attn a').map((a) => a.getAttribute('href'))).toEqual(['#/run/01M5H2EWWY8P621C63CJPVEM4A', '#/run/01M5H2F2QC9NCJ5PSZ0M4RX7VP', '#/runs?types=local']);
    await r.unmount();
    r = await render(inApp(createElement(NeedsLook, { items: rows, total: 3 }), 'This dashboard is read-only: it was started with --read-only.'));
    expect(r.all('.needs .go').map(text)).toEqual(['Open →', 'Open →', 'Open →']);
  });

  it('keeps a line for each failing golden when one fix holds them all, through Show more', async () => {
    // One regression failed three goldens on the same check, and blame joined their runs into one fix.
    const fixId = 'fx-01M5H2DV7NHAEH1GM5ARZXX3BG';
    const held: NeedsLookRow[] = ['refund-in-limit', 'refund-over-limit', 'refund-partial'].map((name, i) => ({ kind: 'test', icon: 'fail', title: `A test failed: ${name}`, detail: 'check failed: issue_refund called 1 time', action: 'Fix', href: `#/fixes/${fixId}`, runId: `01M5H2EWWY8P621C63CJPVEM${i}A`, fixId, at: 3 - i }));
    const open: NeedsLookRow = { kind: 'open', icon: 'blame', title: 'Refunds above the limit issued without approval', detail: 'lost at model call #5 · no fix yet', action: 'Fix it', href: `#/fixes/${fixId}`, runId: null, fixId, at: 0 };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      r = await render(inApp(createElement(NeedsLook, { items: [...held, open], total: 4 })));
      await r.click(r.all('.attn-more')[0]);
      expect(r.all('.needs .t').map(text)).toEqual(['A test failed: refund-in-limit', 'A test failed: refund-over-limit', 'A test failed: refund-partial', 'Refunds above the limit issued without approval']);
      await r.click(r.all('.attn-more')[0]);
      expect(r.all('.needs .t').map(text)).toEqual(['A test failed: refund-in-limit', 'A test failed: refund-over-limit', 'A test failed: refund-partial']);
      expect(errors.mock.calls.map((c) => c.map(String).join(' ')).filter((m) => /same key/.test(m))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
