import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Spending } from '../../engine/src/estimates/spending.js';
import { ApiError, type Client, type JobView } from '../ui/api.js';
import { CostLine } from '../ui/components/CostLine.js';
import { tipCostLine, type TipEst } from '../ui/components/HoverCard.js';
import { JobButton, tipEst } from '../ui/components/JobButton.js';
import { FixJobButton } from '../ui/fixes/FixJobButton.js';
import { heldTo, loadSpending, pressBilled, resetSpending, sentEstimate, spendingNow, type Priced } from '../ui/spending.js';
import { saveSpending } from '../ui/pages/settings/SpendingRow.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Spending in force: one rule decides whether a billed job starts on a press or asks first. At or
 * under the threshold it starts, sending the estimate its card showed; above it, or with no estimate,
 * for a job that asks for what it does, or a form, it asks. Until the threshold is known, it asks.
 * A card says the price and which of the two, as Spending stands when it shows.
 */

const AT = { usd: 0.2, ceiling: false } as const;
const ABOVE = { usd: 0.9, ceiling: true } as const;
/** Shown as ≈$0.500, so it never asks above $0.50. */
const SHOWN_AT = { usd: 0.5004, ceiling: false } as const;
const FREE = { usd: 0, ceiling: false } as const;
const ALWAYS = { usd: 0.01, ceiling: false, always: 'it makes its candidates from your working tree' } as const;
/** The four settings and the one before the server has answered. */
const SETTINGS: Array<Spending | undefined> = [0.5, 2, 0, null, undefined];

const asks = (estimate: Priced, o: { form?: boolean } = {}) => {
  let started: Record<string, unknown> | null = null;
  const out = pressBilled({ estimate, ...o, start: (sent) => (started = sent), ask: () => undefined });
  return { out, started: started as Record<string, unknown> | null };
};

afterEach(() => resetSpending());

describe('the rule a press follows', () => {
  it('starts at or under the threshold, sending what it showed, and asks above it', () => {
    resetSpending(0.5);
    expect(asks(AT)).toEqual({ out: 'started', started: { estimate: { usd: 0.2, ceiling: false } } });
    expect(asks(ABOVE).out).toBe('asked');
    expect(asks(SHOWN_AT).out).toBe('started');
    resetSpending(2);
    expect(asks(ABOVE).out).toBe('started');
  });

  it('asks of a job with no estimate, or one still being worked out, on every setting', () => {
    for (const v of SETTINGS) {
      resetSpending(v);
      expect([v, asks(null).out, asks(undefined).out]).toEqual([v, 'asked', 'asked']);
    }
  });

  it('Never ask starts a priced job and asks of none; Always ask asks of anything billed', () => {
    resetSpending(null);
    expect([asks(AT).out, asks(ABOVE).out, asks(null).out]).toEqual(['started', 'started', 'asked']);
    resetSpending(0);
    expect([asks(AT).out, asks(SHOWN_AT).out, asks(ABOVE).out]).toEqual(['asked', 'asked', 'asked']);
  });

  it('starts what bills nothing on every setting, and asks first of `always` and a form on every setting', () => {
    for (const v of SETTINGS) {
      resetSpending(v);
      expect([v, asks(FREE).out, asks(ALWAYS).out, asks(AT, { form: true }).out, asks(FREE, { form: true }).out]).toEqual([v, 'started', 'asked', 'asked', 'asked']);
    }
  });

  it('holds a press to Always ask until the threshold is known, and never turns Never ask into it', async () => {
    expect([spendingNow(), heldTo(), asks(AT).out]).toEqual([undefined, 0, 'asked']);
    resetSpending(null);
    expect(heldTo()).toBeNull();
    resetSpending();
    // A read that fails keeps it unknown, for the next to try; one that answers is kept.
    await loadSpending({ estimates: { spending: () => Promise.reject(new Error('offline')), setSpending: () => Promise.reject(new Error('offline')) } });
    expect(spendingNow()).toBeUndefined();
    await loadSpending({ estimates: { spending: () => Promise.resolve({ askAbove: null, set: true, problems: [] }), setSpending: () => Promise.reject(new Error('unused')) } });
    expect(spendingNow()).toBeNull();
    // A client with no estimates (an exported copy's, a test's stand-in) reads none.
    await loadSpending({});
    expect(spendingNow()).toBeNull();
  });

  it('keeps a threshold at once, answers what it was, and puts back what showed when the server refuses it', async () => {
    resetSpending(0.5);
    const kept: Spending[] = [];
    const api = { spending: () => Promise.reject(new Error('unused')), setSpending: (v: Spending) => (kept.push(v), Promise.resolve({ askAbove: v, set: true, problems: [], was: 0.5 })) };
    await expect(saveSpending({ estimates: api }, 2)).resolves.toBe(0.5);
    expect([kept, spendingNow()]).toEqual([[2], 2]);
    const refusing = { ...api, setSpending: () => Promise.reject(new ApiError(409, 'settings.json is held by another process')) };
    await expect(saveSpending({ estimates: refusing }, 5)).rejects.toThrow('held by another process');
    expect(spendingNow()).toBe(2);
  });

  it('sends only what the server keeps of an estimate, and nothing for none', () => {
    expect(sentEstimate({ usd: 1.5, ceiling: true, per: 'an attempt', stops: 2, always: 'x' })).toEqual({ estimate: { usd: 1.5, ceiling: true, per: 'an attempt', stops: 2 } });
    expect([sentEstimate(null), sentEstimate(undefined), sentEstimate({ usd: null, ceiling: false })]).toEqual([{}, {}, {}]);
  });
});

describe("a billed control's card", () => {
  const line = (e: Priced, o: Partial<TipEst> = {}) => {
    const est = tipEst(e);
    return est ? tipCostLine({ ...est, ...o }) : null;
  };

  it('says the price and whether it starts at once, as Spending stands when it shows', () => {
    resetSpending(0.5);
    expect([line(AT), line(ABOVE), line(null), line(FREE), line(ALWAYS)]).toEqual(['≈$0.200 · starts at once', 'At most ≈$0.900 · asks first', 'no estimate · asks first', null, '≈$0.010 · asks first']);
    resetSpending(0);
    expect(line(AT)).toBe('≈$0.200 · asks first');
  });

  it('says the amount alone for a form, a control that waits, and before the threshold is known; nothing while the price is worked out', () => {
    resetSpending(0.5);
    expect([line(AT, { form: true }), line(ABOVE, { wait: true }), line(undefined)]).toEqual(['≈$0.200', 'At most ≈$0.900', null]);
    resetSpending();
    expect(line(AT)).toBe('≈$0.200');
  });
});

describe('JobButton and FixJobButton', () => {
  type Sent = { kind: string; fields: Record<string, unknown> };
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
  });

  function app(sent: Sent[], o: { consent?: boolean } = {}): AppState {
    const client = {
      jobs: () => Promise.resolve([]),
      startJob: (kind: string, fields: Record<string, unknown>) => {
        sent.push({ kind, fields });
        if (o.consent && fields.yes !== 'ok-1') return Promise.reject(new ApiError(409, 'This runs a command someone else recorded', 'ok-1'));
        return Promise.resolve({ id: `j${sent.length}`, kind } as JobView);
      },
    } as unknown as Client;
    return { client, exported: false, conn: 'ok', feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => (fn(), true), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
  }

  it('starts on a press at or under the threshold with its estimate, opens its ask above it, and carries its price on its card', async () => {
    resetSpending(0.5);
    const started: Array<Record<string, unknown>> = [];
    let asked = 0;
    const button = (estimate: Priced) => createElement(JobButton, { estimate, tip: 'Run blame', command: '$ shadowlap blame r1', className: 'btn', start: (sent) => started.push(sent), ask: () => (asked += 1) }, 'Run blame');
    r = await render(createElement(AppContext.Provider, { value: app([]) }, button(AT)));
    const b = r.one('button');
    expect((JSON.parse(b.getAttribute('data-tip') ?? '{}') as { est?: unknown }).est).toEqual({ usd: 0.2, ceiling: false });
    await r.click(b);
    expect([started, asked]).toEqual([[{ estimate: { usd: 0.2, ceiling: false } }], 0]);
    resetSpending(0);
    await r.click(b);
    expect([started.length, asked]).toEqual([1, 1]);
  });

  it('resends the estimate with the yes a consent asks for', async () => {
    resetSpending(0.5);
    const sent: Sent[] = [];
    r = await render(createElement(AppContext.Provider, { value: app(sent, { consent: true }) }, createElement(FixJobButton, { kind: 'blame', fields: { runId: 'r1' }, label: 'Run blame again', verb: 'blame again', lead: false, tip: 'Blames the run again', command: 'shadowlap blame r1', estimate: AT, ask: () => null })));
    await r.click(r.one('button'));
    await r.until('the consent', () => r!.all('.dialog').length === 1);
    await r.click(r.byText('.dialog button', 'Run command'));
    await r.until('the second start', () => sent.length === 2);
    expect(sent.map((s) => s.fields)).toEqual([
      { runId: 'r1', estimate: { usd: 0.2, ceiling: false } },
      { runId: 'r1', estimate: { usd: 0.2, ceiling: false }, yes: 'ok-1' },
    ]);
  });
});

describe("FixJobButton's props", () => {
  it('give a billed job or a form its ask, so a press that asks never starts it instead', () => {
    const base = { kind: 'blame', fields: {}, label: 'Run blame again', verb: 'blame again', lead: false, tip: 'Blames the run again', command: 'shadowlap blame r1' };
    type Props = Parameters<typeof FixJobButton>[0];
    // @ts-expect-error an estimate with no ask
    const priced: Props = { ...base, estimate: AT };
    // @ts-expect-error a form with no ask
    const form: Props = { ...base, form: true };
    const free: Props = base;
    const asks: Props = { ...base, estimate: undefined, ask: () => null };
    expect([priced, form, free, asks].map((p) => 'ask' in p)).toEqual([false, false, false, true]);
  });
});

describe("a dialog's Cost line", () => {
  it('puts `live where a replay forks` on a card of its own, saying what a run whose replay doesn’t fork costs', async () => {
    const parts = ['up to 80 attempts a failing run', 'live where a replay forks, writes stubbed'];
    for (const line of [{ price: 'Billed by your provider', parts }, { price: '', estimate: { usd: 0.4, ceiling: true, parts } }]) {
      const r = await render(createElement(CostLine, line));
      try {
        const tip = r.one('.dcost .dtip');
        expect(tip.textContent).toBe('live where a replay forks');
        expect(JSON.parse(String(tip.props['data-tip']))).toMatchObject({ t: 'A run whose replay doesn’t fork', s: 'settles in one free attempt' });
        expect((r.one('.dcost').textContent ?? '').replace(/\s+/g, ' ')).toMatch(/ · up to 80 attempts a failing run · live where a replay forks, writes stubbed$/);
      } finally {
        await r.unmount();
      }
    }
  });
});
