import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Spending } from '../../engine/src/estimates/spending.js';
import type { Client } from '../ui/api.js';
import { ToastHost } from '../ui/components/Toast.js';
import { SpendingRow } from '../ui/pages/settings/SpendingRow.js';
import { askSpendingFocus, resetSpending, spendingNow } from '../ui/spending.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction, ToastKind } from '../ui/toast.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Settings → Project's Spending row: its words follow the value, a pick or an amount typed is kept at
 * once by the server (Enter or leaving the field, once), with an Undo that writes back what it was, an
 * amount that isn't one puts the field back and says so, and Change on an ask's footer lands on the field.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  resetSpending();
});

interface Said {
  text: string;
  kind: string | undefined;
  action: ToastAction | undefined;
}

/**
 * The row, its server keeping what it is sent (or refusing it with `refuse`), each toast it says kept.
 * With `host`, the app's toasts draw (ToastHost), so ⌘Z does what a toast's Undo offers.
 */
async function row(start: Spending, o: { refuse?: string; actionsOff?: string; host?: boolean } = {}) {
  resetSpending(start);
  let kept: Spending = start;
  const puts: Spending[] = [];
  const toasts: Said[] = [];
  const estimates = {
    spending: () => Promise.resolve({ askAbove: kept, set: true, problems: [] }),
    setSpending: (v: Spending) => {
      puts.push(v);
      if (o.refuse) return Promise.reject(new Error(o.refuse));
      const was = kept;
      kept = v;
      return Promise.resolve({ askAbove: v, was });
    },
  };
  const app = { client: { estimates } as unknown as Client, exported: false, conn: 'online', jobs: [], actionsOff: o.actionsOff ?? null, guard: (fn: () => void) => (fn(), true), toast: (text: string, kind?: string, action?: ToastAction) => toasts.push({ text, kind, action }) } as unknown as AppState;
  function Host() {
    const [toastText, setToastText] = useState<AppState['toastText']>(null);
    const toast = (text: string, kind: ToastKind = 'notice', action?: ToastAction) => {
      toasts.push({ text, kind, action });
      setToastText({ id: toasts.length, text, kind, ...(action ? { action } : {}) });
    };
    return createElement(AppContext.Provider, { value: { ...app, toast, toastText } }, createElement(SpendingRow), createElement(ToastHost));
  }
  r = await render(o.host ? createElement(Host) : createElement(AppContext.Provider, { value: app }, createElement(SpendingRow)));
  await r.wait(0);
  return { puts, toasts };
}

const words = () => r!.all('#spending .spendsay .ln').map((l) => l.textContent);
const input = () => r!.one('#askAbove');
const pressed = () => r!.all('#spending .seg button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
const pick = (label: string) => r!.byText('#spending .seg button', label);

async function enter(text: string) {
  await r!.focus(input());
  await r!.type(input(), text);
  await r!.press('Enter', {}, input());
  await r!.wait(0);
}

describe('the Spending row', () => {
  it.each<[Spending, string[], string[]]>([
    [0.5, ['Ask before spending more than $0.50.', 'A job with no estimate always asks.'], ['$0.50']],
    [0, ['Always ask before spending.'], ['Always ask']],
    [null, ['Never ask before spending.', 'A job with no estimate still asks.'], ['Never ask']],
    [1000, ['Ask before spending more than $1,000.', 'A job with no estimate always asks.'], []],
  ])('says %s a line a sentence, its pick pressed, and the field the amount', async (v, said, picks) => {
    await row(v);
    expect(words()).toEqual(said);
    expect(pressed()).toEqual(picks);
    expect(input().value).toBe(v === null ? '' : v === 0.5 ? '0.50' : String(v));
    expect(input().getAttribute('placeholder')).toBe('no limit');
  });

  it('keeps each pick at once and says so with Undo, which writes back what it was', async () => {
    const { puts, toasts } = await row(0.5);
    for (const label of ['Always ask', '$2', 'Never ask', '$0.50']) await r!.click(pick(label));
    await r!.wait(0);
    expect(puts).toEqual([0, 2, null, 0.5]);
    expect(toasts.map((t) => t.text)).toEqual(['Always asks · on this machine', 'Asks above $2 · on this machine', 'Never asks · on this machine', 'Asks above $0.50 · on this machine']);
    expect(toasts.every((t) => t.action?.label === 'Undo' && t.action.undo)).toBe(true);
    expect(pressed()).toEqual(['$0.50']);
    toasts.at(-1)!.action!.run();
    await r!.wait(0);
    expect(puts.at(-1)).toBe(null);
    expect(toasts.at(-1)).toMatchObject({ text: 'Never asks · on this machine', action: undefined });
    expect([spendingNow(), pressed()]).toEqual([null, ['Never ask']]);
    // The same pick again changes nothing and says nothing.
    await r!.click(pick('Never ask'));
    expect(puts.length).toBe(5);
  });

  it('undoes a pick with ⌘Z while its toast shows, ⌘Z in the field being the field’s own', async () => {
    const { puts } = await row(0.5, { host: true });
    await r!.click(pick('$2'));
    await r!.until('its toast', () => r!.all('.toast .tbtn').length === 1);
    await r!.focus(input());
    await r!.press('z', { metaKey: true }, input());
    await r!.wait(0);
    expect(puts).toEqual([2]);
    const e = await r!.press('z', { metaKey: true }, r!.document.body);
    await r!.until('the undo kept', () => spendingNow() === 0.5);
    expect([e.defaultPrevented, puts, pressed()]).toEqual([true, [2, 0.5], ['$0.50']]);
  });

  it('keeps an amount typed in whole cents, once on Enter and the blur after it, $, spaces and commas ignored, empty for Never ask', async () => {
    const { puts, toasts } = await row(0.5);
    await enter('$1,000.50');
    await r!.fire(input(), 'focusout');
    expect(puts).toEqual([1000.5]);
    expect(input().value).toBe('1000.50');
    expect(words()[0]).toBe('Ask before spending more than $1,000.50.');
    await enter('.5');
    expect(input().value).toBe('0.50');
    await enter('');
    expect(puts).toEqual([1000.5, 0.5, null]);
    expect(toasts.map((t) => t.text).at(-1)).toBe('Never asks · on this machine');
    expect(toasts.at(-1)?.action?.returnTo).toBe(input());
  });

  it('puts the field back on an amount that isn’t one, and on one the server refuses, with its words', async () => {
    const { puts, toasts } = await row(2);
    await enter('abc');
    expect([puts, input().value, toasts.at(-1)?.text]).toEqual([[], '2', 'An amount in dollars, such as 0.50']);
    await r!.unmount();
    const refused = await row(2, { refuse: 'Spending can’t be kept: the home folder is read-only' });
    await enter('3');
    expect(refused.puts).toEqual([3]);
    expect(input().value).toBe('2');
    expect(refused.toasts.at(-1)).toMatchObject({ text: 'Spending can’t be kept: the home folder is read-only', kind: 'error' });
    expect(words()[0]).toBe('Ask before spending more than $2.');
  });

  it('waits on a read-only dashboard, the value still shown', async () => {
    const { puts } = await row(2, { actionsOff: 'This dashboard is read-only' });
    await r!.click(pick('Never ask'));
    expect([puts, words()[0], input().props['readOnly']]).toEqual([[], 'Ask before spending more than $2.', true]);
  });

  it('takes the focus where Change on an ask’s footer sent it, once', async () => {
    askSpendingFocus();
    await row(0.5);
    expect(r!.focused()).toBe(input());
    await r!.unmount();
    await row(0.5);
    expect(r!.focused()).not.toBe(input());
  });
});
