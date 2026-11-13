import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { overviewSummary } from '../src/overview.js';
import type { Client, OverviewSummary, OverviewWarming } from '../ui/api.js';
import { OverviewPage, WARMING_ASK_MS } from '../ui/pages/Overview.js';
import { AppContext, type AppState } from '../ui/state.js';
import { addRun, DAY } from './read-model-store.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A store no dashboard has opened yet has every run's totals to add up before the Overview can say
 * what this week did. The server answers at once with how far it has got (`warming`) rather than
 * holding every other request up until it is done; the Overview says so, asks again every second,
 * and shows itself once the server answers whole, keeping it after that.
 */

let r: Rendered | null = null;
// The Overview asks again on a fake timer: the second it waits passes as the test moves its clock (r.wait).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const NOW = Date.UTC(2026, 9, 22, 12);

describe('the Overview while the runs’ totals are added up', () => {
  it('says how far the server has got, asks again, and shows the Overview once it is whole', async () => {
    vi.stubGlobal('location', { hash: '#/', search: '', pathname: '/' });
    const store = Store.open(':memory:');
    addRun(store, { startedAt: NOW - DAY, calls: 'lrlrl' });
    const whole = JSON.parse(JSON.stringify(overviewSummary(store, { tz: 'UTC', now: NOW }))) as OverviewSummary;
    store.close();
    const answers: Array<OverviewSummary | OverviewWarming> = [{ warming: { done: 120, total: 9000 } }, { warming: { done: 4500, total: 9000 } }, whole, { warming: { done: 9000, total: 9001 } }];
    let asked = 0;
    const client = {
      exported: false,
      summary: () => Promise.resolve(answers[Math.min(asked++, answers.length - 1)]),
      activity: () => Promise.resolve({ items: [], next: null }),
      teamStore: () => Promise.resolve(null),
    } as unknown as Client;
    const app = (tick: number) => ({ client, exported: false, meta: null, runs: null, live: [], tick, runsTick: 0, feeds: {}, toast: () => undefined, guard: (fn: () => void) => fn() }) as unknown as AppState;
    // The shell's tick, moved as runs move.
    let move: (tick: number) => void = () => undefined;
    function Host() {
      const [tick, setTick] = useState(0);
      move = setTick;
      return createElement(AppContext.Provider, { value: app(tick) }, createElement(OverviewPage));
    }
    r = await render(createElement(Host));
    // The Overview's loading has a status of its own. The warming line in its place is the page's text, with no live
    // role: it is what the page holds as it opens, and its count moves each second.
    await r.until('how far it has got', () => r!.document.body.textContent.includes('runs so far'));
    const line = r.one('.empty.tall');
    expect([line.textContent.includes('120 of 9,000 runs so far'), line.hasAttribute('role')]).toEqual([true, false]);
    expect(r.all('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
    // Asked again a second later, without a change in the runs.
    await r.wait(WARMING_ASK_MS + 100);
    await r.until('further', () => r!.one('.empty.tall').textContent.includes('4,500 of 9,000'));
    expect(r.all('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
    await r.wait(WARMING_ASK_MS + 100);
    await r.until('the Overview', () => r!.all('.ovg').length > 0);
    expect(asked).toBe(3);
    expect(r.all('[role="status"]')).toHaveLength(0);
    // Whole once, it stays whole: an answer still adding up a new run's totals leaves it in place.
    move(1);
    await r.until('an answer', () => asked >= 4);
    await r.wait(50);
    expect(r.all('.ovg').length).toBeGreaterThan(0);
    expect(r.all('[role="status"]')).toHaveLength(0);
  });
});
