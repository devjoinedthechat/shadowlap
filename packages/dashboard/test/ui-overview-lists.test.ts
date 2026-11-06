import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeedsLook } from '../ui/overview/panels.js';
import { Usage } from '../ui/overview/Usage.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { NeedsLookRow, OverviewSummary } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The Overview's Usage folds until asked for, and each line of Needs a look says where it leads, or
 * Open where nothing runs.
 */

const app = (actionsOff: string | null = null) => ({ actionsOff, exported: false, meta: null }) as unknown as AppState;
const inApp = (el: ReactElement, actionsOff: string | null = null) => createElement(AppContext.Provider, { value: app(actionsOff) }, el);
const text = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

describe('the Overview’s Usage', () => {
  const summary = {
    sums: { week: { calls: 2785, runs: 28, origins: { r: 1030, l: 1755 } } },
    cache: { readShare: 0.87, input: 1000, cacheRead: 870, misses: [], sentAgain: 0 },
    outcomes: { spent: { value: 16.24 } },
    daily: [
      { day: '2026-10-13', start: 0, spent: 1, notRespent: 0.5 },
      { day: '2026-10-14', start: 0, spent: 2, notRespent: 1.72 },
    ],
    today: { served: 1034, notRespent: 1.72 },
  } as unknown as OverviewSummary;

  it('folds until asked for, its figures on its heading’s line, and stays open for the session', async () => {
    // The session's storage, as a browser keeps it for the tab.
    const kept = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
    r = await render(inApp(createElement(Usage, { s: summary })));
    expect(text(r.all('.ovuse > header .sub')[0])).toBe('2,785 calls in 28 runs · 37% replayed · 87% of input from the cache · $16.24 spent live this week');
    const show = r.all('.ovuse .linkbtn')[0];
    expect([text(show), show.getAttribute('aria-expanded')]).toEqual(['Show', 'false']);
    expect(r.all('.ugrid')).toHaveLength(0);
    await r.click(show);
    expect(r.all('.ugrid .upart h3').map(text)).toEqual(['Calls by origin', 'Prompt cache', 'Spend per day']);
    expect(r.all('.ovuse .linkbtn')[0].getAttribute('aria-expanded')).toBe('true');
    expect(text(r.all('.ovuse > .leaknote')[0])).toBe('Today 1,034 calls were served from recordings: $1.72 not re-spent.');
    expect(kept.get('shadowlap-overview-usage')).toBe('open');
    // A day after the first in the same month keeps its month for a phone to hide.
    expect(r.all('.xlabels > span').map(text)).toEqual(['Oct 13', 'Oct 14']);
    expect(r.all('.xlabels .xm')).toHaveLength(1);
    // Opened once, it opens open for the rest of the session.
    await r.unmount();
    r = await render(inApp(createElement(Usage, { s: summary })));
    expect(r.all('.ugrid .upart')).toHaveLength(3);
  });
});

describe('Needs a look’s words', () => {
  const rows: NeedsLookRow[] = [
    { kind: 'test', icon: 'fail', title: 'A test failed: refund-in-limit', detail: 'diverged at call 3', key: 'attn:failed:goldens/refund-in-limit', group: 'failing', step: null, href: '#/run/01M5H2EWWY8P621C63CJPVEM4A', runId: '01M5H2EWWY8P621C63CJPVEM4A', fixId: null, at: 3 },
    { kind: 'unblamed', icon: 'fail', title: 'A run failed: 01M5H2F2QC digest', detail: 'not blamed yet', key: 'attn:unblamed:01M5H2F2QC9NCJ5PSZ0M4RX7VP', group: 'failing', step: { of: 'run', runId: '01M5H2F2QC9NCJ5PSZ0M4RX7VP', step: { key: 'blame', label: 'Run blame' } as never }, href: '#/run/01M5H2F2QC9NCJ5PSZ0M4RX7VP', runId: '01M5H2F2QC9NCJ5PSZ0M4RX7VP', fixId: null, at: 2 },
    { kind: 'local', icon: 'rec', title: '12 runs are only on this machine', detail: 'push them so the team can open them', key: 'attn:local', group: 'housekeeping', step: { of: 'push', label: 'Push local runs', command: 'shadowlap push --all' }, href: '#/runs?types=local', runId: null, fixId: null, at: 0 },
  ];

  it('says where each line leads, and Open for every line where nothing runs', async () => {
    r = await render(inApp(createElement(NeedsLook, { items: rows, total: 3 })));
    expect(r.all('.needs .go').map(text)).toEqual(['Open →', 'Run blame →', 'Push local runs →']);
    expect(r.all('.needs .attn a').map((a) => a.getAttribute('href'))).toEqual(['#/run/01M5H2EWWY8P621C63CJPVEM4A', '#/run/01M5H2F2QC9NCJ5PSZ0M4RX7VP', '#/runs?types=local']);
    await r.unmount();
    r = await render(inApp(createElement(NeedsLook, { items: rows, total: 3 }), 'This dashboard is read-only: it was started with --read-only.'));
    expect(r.all('.needs .go').map(text)).toEqual(['Open →', 'Open →', 'Open →']);
  });

  it('keeps a line for each failing golden when one fix holds them all, through Show more', async () => {
    // One regression failed three goldens on the same check, and blame joined their runs into one fix.
    const fixId = 'fx-01M5H2DV7NHAEH1GM5ARZXX3BG';
    const held: NeedsLookRow[] = ['refund-in-limit', 'refund-over-limit', 'refund-partial'].map((name, i) => ({ kind: 'test', icon: 'fail', title: `A test failed: ${name}`, detail: 'check failed: issue_refund called 1 time', key: `attn:failed:goldens/${name}`, group: 'failing', step: null, href: `#/fixes/${fixId}`, runId: `01M5H2EWWY8P621C63CJPVEM${i}A`, fixId, at: 3 - i }));
    const open: NeedsLookRow = { kind: 'open', icon: 'blame', title: 'Refunds above the limit issued without approval', detail: 'lost at model call #5 · no fix yet', key: `attn:fix:#/fixes/${fixId}`, group: 'failing', step: null, href: `#/fixes/${fixId}`, runId: null, fixId, at: 0 };
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
