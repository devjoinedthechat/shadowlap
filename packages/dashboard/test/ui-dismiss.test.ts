import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from '../ui/components/Toast.js';
import { PAUSED } from '../ui/connection.js';
import type { Dismissed, DismissalsApi, Restored } from '../ui/dismissals-api.js';
import { dropRowScope, rowScopeNow } from '../ui/list-keys.js';
import { DISMISSED_WORDS } from '../ui/overview/Dismiss.js';
import { drawnRows, hold, holdBack, isDismissed, leftOf, lookGroups, lookMemory, resetLookMemory, setFold, settle } from '../ui/overview/dismissed.js';
import { NeedsLook } from '../ui/overview/NeedsLook.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import type { NeedsLookRow } from '../ui/types.js';
import { app } from './ui-route-helpers.js';
import { type FakeElement, render, type Rendered } from './ui-render.js';

/**
 * Dismiss on Needs a look: the quiet × on advice alone, which puts its row away at once under its
 * group's Dismissed (n), writes the facts the row stated and offers Undo (⌘Z); Restore under an open
 * fold, and Undo, bring a row back with the focus on it. What the page holds of a press lasts until
 * a list that has it arrives, and a fold left open stays open for the page's life.
 */

const READ_ONLY = 'This dashboard is read-only: it was started with --read-only.';
const RUNS = ['01M5H2EWWY8P621C63CJPVEM4A', '01M5H2F2QC9NCJ5PSZ0M4RX7VP'];

const failing: NeedsLookRow = { kind: 'test', icon: 'fail', title: 'A golden failed: refund-in-limit', name: 'refund-in-limit', detail: 'diverged at call 3', key: 'attn:failed:goldens/refund-in-limit', group: 'failing', step: null, href: '#/tests', runId: null, fixId: null, at: 3 };
const coverage: NeedsLookRow = { kind: 'coverage', icon: 'warn', title: '2 behaviours have no golden', detail: 'a refund over the limit, a partial refund', key: 'attn:coverage', group: 'tests', step: null, href: '#/tests', runId: null, fixId: null, at: 0, advice: { key: 'coverage', facts: ['refund-over-limit', 'refund-partial'], until: 'Until another behaviour has no golden', dismissed: false } };
const local: NeedsLookRow = { kind: 'local', icon: 'rec', title: '2 runs are only on this machine', detail: 'push them so the team can open them', key: 'attn:local', group: 'housekeeping', step: null, href: '#/runs?types=local', runId: null, fixId: null, at: 0, advice: { key: 'local', facts: RUNS, until: 'Until another run is only on this machine', dismissed: false } };
const retire: NeedsLookRow = { kind: 'retire', icon: 'retire', title: 'claude-sonnet-4 retires on 2027-01-05', detail: '1 golden records it', key: 'attn:retire:claude-sonnet-4', group: 'housekeeping', step: null, href: '#/tests', runId: null, fixId: null, at: 0, advice: { key: 'retire claude-sonnet-4', facts: ['2027-01-05', 'goldens/refund.json'], until: 'Until a new date or golden', dismissed: false } };
/** Put away, as the server's list says it. */
const off = (x: NeedsLookRow): NeedsLookRow => ({ ...x, advice: { ...x.advice!, dismissed: true } });

const text = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();
const tip = (el: FakeElement) => JSON.parse(el.getAttribute('data-tip')!) as { t: string; s?: string };

interface Said {
  text: string;
  kind: string;
  action: ToastAction | undefined;
}

interface Look {
  items: NeedsLookRow[];
  total: number;
  dismissals?: number;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  resetLookMemory();
  dropRowScope();
});

const page = () => r!;
const rowKeys = () => page().all('.arow').map((x) => x.getAttribute('data-rowkey'));
const offKeys = () => page().all('.arow.off').map((x) => x.getAttribute('data-rowkey'));
const heads = () => page().all('.agrp').map(text);
const panel = () => text(page().one('.ovattn > header .sub'));
const fold = (group: string) => page().one(`[data-fold="${group}"]`);
const cross = (x: NeedsLookRow) => page().one(`[data-rowkey="${x.key}"] .adis`);
const restoreOf = (x: NeedsLookRow) => page().one(`[data-rowkey="${x.key}"] .ast .btn`);
/** The row the focus is in, and whether the focus is on what the row opens. */
const inFocus = () => {
  const at = page().focused();
  return [at.closest('[data-rowkey]')?.getAttribute('data-rowkey') ?? null, at.matches('a.at')];
};

/** Needs a look with the toast and the keys, its store's writes answering as `o` says (each moves the counter); `show` hands it another list. */
async function look(first: NeedsLookRow[] | Look, o: { conn?: string; actionsOff?: string | null; dismiss?: DismissalsApi['dismiss']; restore?: DismissalsApi['restore'] } = {}) {
  const said: Said[] = [];
  let stamp = 0;
  const dismiss = vi.fn(o.dismiss ?? ((key: string, facts: readonly string[]): Promise<Dismissed> => Promise.resolve({ key, facts: [...facts], was: null, dismissals: ++stamp })));
  const restore = vi.fn(o.restore ?? ((key: string): Promise<Restored> => Promise.resolve({ key, restored: true, dismissals: ++stamp })));
  const start: Look = Array.isArray(first) ? { items: first, total: first.filter((x) => !x.advice?.dismissed).length, dismissals: 0 } : first;
  let swap: (next: Look) => void = () => undefined;
  function Host() {
    const [shown, setShown] = useState(start);
    const [toastText, setToastText] = useState<AppState['toastText']>(null);
    swap = setShown;
    const toast = (words: string, kind = 'notice', action?: ToastAction) => {
      said.push({ text: words, kind, action });
      setToastText({ id: said.length, text: words, kind, ...(action ? { action } : {}) } as AppState['toastText']);
    };
    const value = app({ client: { jobs: async () => [], dismissals: { dismiss, restore } }, conn: o.conn ?? 'ok', actionsOff: o.actionsOff ?? null, toast, toastText, feeds: {}, hasKind: () => true, guard: (fn: () => void) => (fn(), true) } as unknown as Partial<AppState>);
    return createElement(AppContext.Provider, { value }, createElement('main', { id: 'view', tabIndex: -1 }, createElement(NeedsLook, shown)), createElement(ToastHost), createElement(Keyboard));
  }
  r = await render(createElement(Host));
  return { said, dismiss, restore, show: (next: Look) => act(async () => swap(next)) };
}

describe('Dismiss', () => {
  it('is the × on advice alone, named for its row, its card saying when the row comes back', async () => {
    await look([failing, local]);
    // A failure keeps its last column, empty: no failure is advice.
    expect(page().all('.arow .adx').map((x) => x.querySelectorAll('.adis').length)).toEqual([0, 1]);
    expect(text(page().all('.arow .adx')[0])).toBe('');
    const x = cross(local);
    expect([x.getAttribute('aria-label'), x.getAttribute('aria-disabled')]).toEqual(['Dismiss: 2 runs are only on this machine', null]);
    expect(tip(x)).toMatchObject({ t: 'Dismiss', s: 'Until another run is only on this machine' });
    expect(page().all('.aoff')).toEqual([]);
  });

  it('puts the row under its group’s Dismissed (n) at once, writing the facts it stated, the focus on the row after it, and offers Undo', async () => {
    const p = await look([failing, local, retire]);
    expect([heads(), panel()]).toEqual([['Failing1', 'Housekeeping2'], '3']);
    await page().click(cross(local));
    expect(p.dismiss).toHaveBeenCalledWith('local', RUNS);
    expect(rowKeys()).toEqual([failing.key, retire.key]);
    expect([text(fold('housekeeping')), fold('housekeeping').getAttribute('aria-expanded')]).toEqual(['Dismissed (1)', 'false']);
    expect([heads(), panel()]).toEqual([['Failing1', 'Housekeeping1'], '2']);
    expect(inFocus()).toEqual([retire.key, true]);
    await page().until('the toast', () => p.said.length === 1);
    expect(p.said[0]).toMatchObject({ text: DISMISSED_WORDS, kind: 'notice', action: { label: 'Undo', undo: true } });
    expect(text(page().one('.toast'))).toContain('Dismissed until it changes');
    // The last row of its group: the focus on Dismissed (n), and the head keeps no count.
    await page().click(cross(retire));
    expect([heads(), panel(), text(fold('housekeeping'))]).toEqual([['Failing1', 'Housekeeping'], '1', 'Dismissed (2)']);
    expect(page().all('.agrp span').map(text)).toEqual(['1']);
    expect(page().focused()).toBe(fold('housekeeping'));
  });

  it('comes undone on ⌘Z, the row back in its place with the focus on it, raising no toast', async () => {
    const p = await look([local, retire]);
    await page().click(cross(local));
    await page().until('the toast', () => p.said.length === 1);
    await page().press('z', { metaKey: true });
    await page().until('the row back', () => rowKeys().length === 2);
    expect(rowKeys()).toEqual([local.key, retire.key]);
    expect(inFocus()).toEqual([local.key, true]);
    expect(page().all('.aoff')).toEqual([]);
    // Nothing was kept before the Dismiss: Undo takes what it kept away.
    expect(p.restore).toHaveBeenCalledWith('local');
    await page().wait(10);
    expect(p.said.map((s) => s.text)).toEqual([DISMISSED_WORDS]);
    expect([panel(), heads()]).toEqual(['2', ['Housekeeping2']]);
  });

  it('comes undone on its toast’s Undo, taking away what it kept where nothing was kept before', async () => {
    const p = await look([local, retire]);
    await page().click(cross(local));
    await page().until('the toast', () => p.said.length === 1);
    await page().click(page().one('.toast .tbtn'));
    await page().until('the row back', () => rowKeys().length === 2);
    expect(p.restore.mock.calls).toEqual([['local']]);
    expect(p.dismiss).toHaveBeenCalledTimes(1);
    expect(inFocus()).toEqual([local.key, true]);
  });

  it('writes back on Undo the facts an earlier dismissal kept', async () => {
    const p = await look([local, retire], { dismiss: (key, facts) => Promise.resolve({ key, facts: [...facts], was: { facts: [RUNS[0]] }, dismissals: 1 }) });
    await page().click(cross(local));
    await page().until('the toast', () => p.said.length === 1);
    await page().click(page().one('.toast .tbtn'));
    await page().until('the row back', () => rowKeys().length === 2);
    expect(p.dismiss.mock.calls).toEqual([
      ['local', RUNS],
      ['local', [RUNS[0]]],
    ]);
    expect(p.restore).not.toHaveBeenCalled();
    expect(inFocus()).toEqual([local.key, true]);
  });

  it('puts a row the server refused to put away back, the focus on its ×, the reason in an error toast', async () => {
    const p = await look([local, retire], { dismiss: () => Promise.reject(new Error('the server is gone')) });
    await page().click(cross(local));
    await page().until('the toast', () => p.said.length === 1);
    expect(p.said).toEqual([{ text: 'The server is gone', kind: 'error', action: undefined }]);
    expect(rowKeys()).toEqual([local.key, retire.key]);
    expect([page().all('.aoff'), panel()]).toEqual([[], '2']);
    expect(page().focused()).toBe(cross(local));
  });

  it('holds its row away until a list that has it, a list asked for before it never bringing the row back', async () => {
    const p = await look({ items: [local, retire], total: 2, dismissals: 4 }, { dismiss: (key, facts) => Promise.resolve({ key, facts: [...facts], was: null, dismissals: 5 }) });
    await page().click(cross(local));
    await page().until('the answer', () => p.said.length === 1);
    await p.show({ items: [local, retire], total: 2, dismissals: 4 });
    expect([rowKeys(), panel()]).toEqual([[retire.key], '1']);
    // The list that has it: the server's word rules again, and the page lets go of the press.
    await p.show({ items: [off(local), retire], total: 1, dismissals: 5 });
    expect([rowKeys(), panel(), lookMemory('').held.size]).toEqual([[retire.key], '1', 0]);
    // A run more on this machine is a fact the Dismiss never saw: the row is back.
    await p.show({ items: [{ ...local, advice: { ...local.advice!, facts: [...RUNS, '01M5H3C0DEQJ8V2W3X4Y5Z6A7B'] } }, retire], total: 2, dismissals: 6 });
    expect([rowKeys(), panel(), page().all('.aoff')]).toEqual([[local.key, retire.key], '2', []]);
  });

  it('says Nothing needs a look. with nothing left, before the groups with something dismissed', async () => {
    await look([off(coverage), off(local)]);
    expect(panel()).toBe('0');
    expect(page().one('.attn').childNodes.map((c) => text(c))).toEqual(['Nothing needs a look.', 'Tests', 'Dismissed (1)', 'Housekeeping', 'Dismissed (1)']);
    expect(page().all('.attn .emptyline')).toHaveLength(1);
  });
});

describe('Dismissed (n)', () => {
  it('opens with the focus kept, its rows muted with Restore, which puts a row back in its place, the fold going after its last row', async () => {
    const p = await look([failing, off(local), off(retire)]);
    expect([rowKeys(), heads(), text(fold('housekeeping'))]).toEqual([[failing.key], ['Failing1', 'Housekeeping'], 'Dismissed (2)']);
    await page().click(fold('housekeeping'));
    expect(fold('housekeeping').getAttribute('aria-expanded')).toBe('true');
    expect(page().focused()).toBe(fold('housekeeping'));
    expect([rowKeys(), offKeys()]).toEqual([
      [failing.key, local.key, retire.key],
      [local.key, retire.key],
    ]);
    // Muted, each still opens what it is about, with Restore in its step's place and no ×.
    expect(page().all('.arow.off .ast').map(text)).toEqual(['Restore', 'Restore']);
    expect(page().all('.arow.off .adis')).toEqual([]);
    expect(page().all('.arow.off a.at').map((a) => a.getAttribute('href'))).toEqual([local.href, retire.href]);
    expect(restoreOf(local).getAttribute('aria-label')).toBe('Restore: 2 runs are only on this machine');
    await page().click(restoreOf(local));
    expect(p.restore).toHaveBeenCalledWith('local');
    expect([rowKeys(), offKeys()]).toEqual([
      [failing.key, local.key, retire.key],
      [retire.key],
    ]);
    expect(inFocus()).toEqual([local.key, true]);
    expect([text(fold('housekeeping')), heads(), panel()]).toEqual(['Dismissed (1)', ['Failing1', 'Housekeeping1'], '2']);
    // The last row back: its fold goes, closed should another row come to it.
    await page().click(restoreOf(retire));
    expect([page().all('.aoff'), offKeys(), lookMemory('').open.has('housekeeping')]).toEqual([[], [], false]);
    expect(inFocus()).toEqual([retire.key, true]);
    await page().wait(10);
    expect(p.said).toEqual([]);
  });

  it('is open again when Needs a look is drawn anew, as after a visit to another page', async () => {
    await look([local, off(retire)]);
    await page().click(fold('housekeeping'));
    await page().unmount();
    r = null;
    await look([local, off(retire)]);
    expect([fold('housekeeping').getAttribute('aria-expanded'), offKeys()]).toEqual(['true', [retire.key]]);
  });

  it('puts back a Restore the server refused, the fold open again and the focus on its Restore', async () => {
    const p = await look([off(local)], { restore: () => Promise.reject(new Error('the server is gone')) });
    await page().click(fold('housekeeping'));
    await page().click(restoreOf(local));
    await page().until('the toast', () => p.said.length === 1);
    expect(p.said).toEqual([{ text: 'The server is gone', kind: 'error', action: undefined }]);
    expect([offKeys(), fold('housekeeping').getAttribute('aria-expanded')]).toEqual([[local.key], 'true']);
    expect(page().focused()).toBe(restoreOf(local));
  });
});

describe('Dismiss and Restore waiting', () => {
  it.each([
    ['offline', { conn: 'offline' }, PAUSED],
    ['read-only', { actionsOff: READ_ONLY }, READ_ONLY],
  ])('wait %s, the card naming the reason, and Dismissed (n) still opens', async (_, o, why) => {
    const p = await look([local, off(retire)], o);
    const x = cross(local);
    expect([x.getAttribute('aria-disabled'), x.getAttribute('data-why'), tip(x)]).toEqual(['true', why, { t: 'Dismiss', s: why, rows: [] }]);
    await page().click(x);
    expect(p.dismiss).not.toHaveBeenCalled();
    expect([rowKeys(), p.said.map((s) => s.text)]).toEqual([[local.key], [why]]);
    await page().click(fold('housekeeping'));
    expect(offKeys()).toEqual([retire.key]);
    expect([restoreOf(retire).getAttribute('aria-disabled'), restoreOf(retire).getAttribute('data-why')]).toEqual(['true', why]);
    await page().click(restoreOf(retire));
    expect(p.restore).not.toHaveBeenCalled();
    expect(offKeys()).toEqual([retire.key]);
  });
});

describe('the keys on Needs a look', () => {
  const push: NeedsLookRow = { ...local, step: { of: 'push', label: 'Push local runs', command: 'shadowlap push --all' } };

  it('walk an open fold with j and k, and ⌘K offers Dismiss on advice and Restore on a row put away', async () => {
    const p = await look([failing, push, off(retire)]);
    await page().click(fold('housekeeping'));
    const walked: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      await page().press('j');
      walked.push(page().focused().getAttribute('data-rowkey'));
    }
    expect(walked).toEqual([failing.key, push.key, retire.key]);
    await page().press('k', { metaKey: true });
    expect(rowScopeNow()!.items().map((i) => [i.label, i.hint, 'job' in i])).toEqual([
      ['Open', retire.href, false],
      ['Restore', '', true],
    ]);
    await page().press('k');
    expect(page().focused().getAttribute('data-rowkey')).toBe(push.key);
    await page().press('k', { metaKey: true });
    const items = rowScopeNow()!.items();
    expect(items.map((i) => [i.label, i.hint])).toEqual([
      ['Open', push.href],
      ['Push local runs', 'shadowlap push --all'],
      ['Dismiss', 'Until another run is only on this machine'],
    ]);
    await act(async () => items[2].run());
    expect(p.dismiss).toHaveBeenCalledWith('local', RUNS);
    expect(offKeys()).toEqual([push.key, retire.key]);
  });

  it('offers on ⌘K Open and Dismiss on advice with no step button, a waiting Dismiss waiting with its reason', async () => {
    await look([failing, local], { actionsOff: READ_ONLY });
    await page().press('j');
    await page().press('j');
    await page().press('k', { metaKey: true });
    const items = rowScopeNow()!.items();
    expect(items).toHaveLength(2);
    expect(items).toMatchObject([
      { label: 'Open', hint: local.href },
      { label: 'Dismiss', hint: READ_ONLY, wait: READ_ONLY, job: true },
    ]);
  });
});

describe('what the page holds of a press', () => {
  const held = (...presses: Array<[string, boolean, number | null]>) => new Map(presses.map(([key, dismissed, stamp]) => [key, { dismissed, stamp }]));

  it('rules until the list has caught up with it, then the server’s word does', () => {
    const away = held(['local', true, 5]);
    expect(isDismissed(failing, away, 9)).toBe(false);
    expect(isDismissed(local, away, undefined)).toBe(true);
    expect(isDismissed(local, away, 4)).toBe(true);
    expect([isDismissed(local, away, 5), isDismissed(off(local), away, 5)]).toEqual([false, true]);
    // No answer yet: it holds whatever list arrives.
    expect(isDismissed(off(local), held(['local', false, null]), 99)).toBe(false);
  });

  it('draws the groups in the list’s order, each counting what is left in it, and the panel’s count moved by each press the list doesn’t have', () => {
    const more: NeedsLookRow = { ...retire, more: 3 };
    const gs = lookGroups([failing, coverage, local, more], held(['retire claude-sonnet-4', true, 2]), 1);
    expect(gs.map((g) => [g.group, g.open.map((x) => x.key), g.dismissed.map((x) => x.key), g.count])).toEqual([
      ['failing', [failing.key], [], 1],
      ['tests', [coverage.key], [], 1],
      ['housekeeping', [local.key], [more.key], 1],
    ]);
    expect(leftOf([failing, coverage, local, more], 6, held(['retire claude-sonnet-4', true, 2]), 1)).toBe(3);
    // A Restore of what the list has put away counts it again; one the list has caught up with moves nothing.
    expect(leftOf([off(local), retire], 1, held(['local', false, 3]), 2)).toBe(2);
    expect(leftOf([local, retire], 2, held(['local', false, 3]), 3)).toBe(2);
    expect(drawnRows(gs, new Set(['housekeeping'])).map((x) => x.key)).toEqual([failing.key, coverage.key, local.key, more.key]);
    expect(drawnRows(gs, new Set()).map((x) => x.key)).toEqual([failing.key, coverage.key, local.key]);
  });

  it('lets go of the presses a list has caught up with, puts back what a refusal undoes, and keeps each project’s apart', () => {
    hold('a', 'local', { dismissed: true, stamp: 3 });
    hold('a', 'coverage', { dismissed: true, stamp: null });
    hold('a', 'retire x', { dismissed: false, stamp: 5 });
    const before = lookMemory('a');
    expect(lookMemory('a')).toBe(before);
    settle('a', undefined);
    expect(lookMemory('a')).toBe(before);
    settle('a', 4);
    expect([...lookMemory('a').held.keys()]).toEqual(['coverage', 'retire x']);
    holdBack('a', 'retire x', undefined);
    holdBack('a', 'coverage', { dismissed: false, stamp: 1 });
    expect([...lookMemory('a').held]).toEqual([['coverage', { dismissed: false, stamp: 1 }]]);
    setFold('a', 'housekeeping', true);
    expect([lookMemory('a').open.has('housekeeping'), lookMemory('b').open.size, lookMemory('b').held.size]).toEqual([true, 0, 0]);
    setFold('a', 'housekeeping', false);
    expect(lookMemory('a').open.size).toBe(0);
  });
});
