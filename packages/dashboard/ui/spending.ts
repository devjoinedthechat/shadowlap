import { useSyncExternalStore } from 'react';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import { asksFirst, type Spending } from '../../engine/src/estimates/spending.js';
import type { EstimatesApi } from './estimates-api.js';
import type { TipEst } from './components/HoverCard.js';

/**
 * Spending in the browser: the person's threshold for when a billed job asks before it starts, as the
 * server keeps it (`/api/user/spending`), and the rule a press follows. Until the server has answered
 * it is unknown, and the rule holds a job to 0, as Always ask: a click never spends on a guess. Only
 * the Spending row and an ask's footer redraw with it; a button reads it as it is pressed, and a card
 * as it shows, so a change made anywhere never redraws a page.
 */

/** What a billed control knows of its job's price: an estimate, null for none, undefined until it is known. */
export type Priced = Pick<Estimate, 'usd' | 'ceiling' | 'always' | 'per' | 'stops'> | null | undefined;

let now: Spending | undefined;
/** Whether someone set it (else it is the default), and what in its file was ignored and why, as the server last said them. */
let facts: { set: boolean; problems: readonly string[] } | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** The threshold as the server last said it: dollars, 0 for Always ask, null for Never ask, undefined until it has answered. */
export function spendingNow(): Spending | undefined {
  return now;
}

/** What the rule holds a press to: the threshold, or 0 (Always ask) until it is known. Never Always ask for Never ask's null. */
export function heldTo(): Spending {
  const v = spendingNow();
  return v === undefined ? 0 : v;
}

/** Shows a threshold to every control that reads it: as the server said it, or as it is being kept. */
export function showSpending(v: Spending | undefined): void {
  if (v === now) return;
  now = v;
  for (const on of [...listeners]) on();
}

export function onSpending(on: () => void): () => void {
  listeners.add(on);
  return () => {
    listeners.delete(on);
  };
}

/** The threshold, redrawn as it changes: for the Spending row and an ask's footer only. */
export function useSpending(): Spending | undefined {
  return useSyncExternalStore(onSpending, spendingNow);
}

/** Whether the threshold was set and what in its file was ignored, as the server last said them; null until it has. */
export const spendingFacts = (): { set: boolean; problems: readonly string[] } | null => facts;

/** Shows what the server says of the threshold's file: a broken settings.json, a relative SHADOWLAP_HOME, the default in use. */
export function showSpendingFacts(next: { set: boolean; problems: readonly string[] }): void {
  if (facts && facts.set === next.set && facts.problems.join('\n') === next.problems.join('\n')) return;
  facts = { set: next.set, problems: [...next.problems] };
  for (const on of [...listeners]) on();
}

/** The threshold's facts, redrawn as they change: for the Spending row only. */
export function useSpendingFacts(): { set: boolean; problems: readonly string[] } | null {
  return useSyncExternalStore(onSpending, spendingFacts);
}

/** What the threshold's store needs of the client: none in an exported copy, or a stand-in that prices nothing. */
export type SpendingClient = { estimates?: Pick<EstimatesApi, 'spending' | 'setSpending'> } | null | undefined;

/** Reads the threshold. One that fails leaves it as it was, unknown asking every billed job first, for the next read to try. */
export function loadSpending(client: SpendingClient): Promise<void> {
  const api = client?.estimates;
  if (!api) return Promise.resolve();
  loading ??= api
    .spending()
    .then(
      (v) => {
        showSpending(v.askAbove);
        showSpendingFacts(v);
      },
      () => undefined,
    )
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Reads the threshold now and each time the window has the focus again, for a change made in another tab. */
export function watchSpending(client: SpendingClient, win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  void loadSpending(client);
  const again = () => void loadSpending(client);
  win.addEventListener('focus', again);
  return () => win.removeEventListener('focus', again);
}

/** The estimate a job's start sends, so its drawer says what its card and its ask said: only what the server keeps. */
export function sentEstimate(e: Priced): Record<string, unknown> {
  if (!e || e.usd === null) return {};
  const { usd, ceiling, per, stops } = e;
  return { estimate: { usd, ceiling, ...(per === undefined ? {} : { per }), ...(stops === undefined ? {} : { stops }) } };
}

/** A job's estimate as its control's card holds it; none while it is worked out, so the card has no line until it is. */
export function tipEst(e: Priced, form = false): TipEst | null {
  if (e === undefined) return null;
  const none: NonNullable<Priced> = { usd: null, ceiling: false };
  const { usd, ceiling, always, per, stops } = e ?? none;
  return { usd, ceiling, ...(always ? { always } : {}), ...(per ? { per } : {}), ...(stops === undefined ? {} : { stops }), ...(form ? { form } : {}) };
}

/** A press of a billed control: its estimate, whether it opens a form, and what starting it and asking first do. */
export interface BilledPress {
  estimate: Priced;
  form?: boolean | undefined;
  /** Starts the job, with its estimate's fields for the start's body (`sentEstimate`). */
  start: (sent: Record<string, unknown>) => void;
  ask: () => void;
}

/**
 * The rule a press follows: it asks first where the engine's rule says so at the threshold held to now
 * (`asksFirst`), and starts at once otherwise, sending the estimate it was shown. A plain function, for
 * what can't call a hook: a menu row, a palette's source.
 */
export function pressBilled(p: BilledPress): 'started' | 'asked' {
  if (asksFirst(p.estimate ?? null, heldTo(), { form: !!p.form })) {
    p.ask();
    return 'asked';
  }
  p.start(sentEstimate(p.estimate));
  return 'started';
}

/** For tests: forget the threshold and what was said of its file, as a page that has just opened. */
export function resetSpending(v?: Spending): void {
  loading = null;
  facts = null;
  showSpending(v);
}

let focusAsked = false;

/** Change on an ask's footer: Settings → Project, when it next draws its Spending row, gives it the focus. */
export function askSpendingFocus(): void {
  focusAsked = true;
}

/** Whether Change asked for the Spending row's focus, once. */
export function takeSpendingFocus(): boolean {
  const asked = focusAsked;
  focusAsked = false;
  return asked;
}
