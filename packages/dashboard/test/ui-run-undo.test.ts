import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { pendingHidden } from '../ui/pending-delete.js';
import { href } from '../ui/route.js';
import { navigate } from '../ui/router.js';
import { useDeleteRun } from '../ui/run/delete-run.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import type { RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

vi.mock('../ui/router.js', async (original) => ({ ...(await original<typeof import('../ui/router.js')>()), navigate: vi.fn() }));

/**
 * Undo on a run's page: Delete takes the run off the lists and goes to Runs, sending the delete only
 * once its toast goes, so Undo sends nothing; a label's × takes the label off at once, hands the focus to Add label where
 * the × had it, and its toast's Undo puts the label back; a removal the server refuses puts the
 * labels back as they were.
 */

const RUN = '01M5JEQWA2QMJ3NYD1C687WP08';

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

function detail(labels: string[]): RunDetail {
  return {
    run: { runId: RUN, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { labels } },
    summary: { upstreamRequests: 2, byKind: { api: 2, tool: 0, clock: 0, random: 0 }, cost: { spent: 0.001, saved: 0, captured: 0, unknownModels: [] }, imported: false },
    calls: [],
    actions: [{ key: 'r', label: 'Replay' }],
    children: [],
    parent: null,
    source: null,
    fix: null,
    blame: null,
    state: null,
  } as unknown as RunDetail;
}

interface Said {
  text: string;
  action?: ToastAction | undefined;
}

/** The header of a run labelled `labels`, its labels held as the page holds them, and a server whose label changes answer `answer`. */
async function header(labels: string[], answer: (add: string[], remove: string[]) => Promise<{ labels: string[] }>) {
  const said: Said[] = [];
  const sent: Array<[string[], string[]]> = [];
  const client = { jobs: () => Promise.resolve([]), labels: (_id: string, add: string[], remove: string[]) => (sent.push([add, remove]), answer(add, remove)) } as unknown as Client;
  const app = { client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [], runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, refresh: () => undefined, toast: (text: string, _tone?: string, action?: ToastAction) => void said.push({ text, action }) } as unknown as AppState;
  const run = detail(labels);
  const Page = () => {
    const [shown, setShown] = useState(labels);
    return createElement(RunHeader, { run, call: null, selected: null, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined, labels: shown, setLabels: setShown });
  };
  page = await render(createElement(AppContext.Provider, { value: app }, createElement(Page)));
  return { said, sent, chips: () => page!.all('.labelbar .chip').map((c) => c.textContent?.replace('×', '')) };
}

describe('a label’s ×', () => {
  it('takes the label off at once, hands the focus to Add label, and Undo puts it back', async () => {
    let now = ['what-if', 'refund'];
    const h = await header(now, (add, remove) => {
      now = [...now.filter((l) => !remove.includes(l)), ...add];
      return Promise.resolve({ labels: now });
    });
    const x = page!.one('[aria-label="Remove label what-if"]');
    await page!.focus(x);
    await page!.click(x);
    expect(h.chips()).toEqual(['refund']);
    expect(page!.focused().textContent).toContain('Label');
    expect(h.sent).toEqual([[[], ['what-if']]]);
    const removed = h.said.at(-1)!;
    expect(removed.text).toBe('Removed what-if from 01M5JEQWA2');
    expect(removed.action).toMatchObject({ label: 'Undo', undo: true });
    removed.action!.run();
    await page!.until('the label back', () => h.chips().length === 2);
    // The server appends: the label comes back last.
    expect(h.chips()).toEqual(['refund', 'what-if']);
    expect(h.sent.at(-1)).toEqual([['what-if'], []]);
    expect(h.said.at(-1)!.text).toBe('what-if is back on 01M5JEQWA2');
  });

  it('puts the labels back as they were, and says why, where the server refuses', async () => {
    const h = await header(['what-if', 'refund'], () => Promise.reject(new Error('the store is read-only')));
    await page!.click(page!.one('[aria-label="Remove label refund"]'));
    await page!.until('the labels back', () => h.chips().length === 2);
    expect(h.chips()).toEqual(['what-if', 'refund']);
    expect(h.said.at(-1)!.text).toBe('The store is read-only');
  });
});

describe('Fork while the run records', () => {
  it('says why it waits on its card and on a press, from the keyboard too, where a disabled button’s title never reached', async () => {
    const said: Said[] = [];
    const client = { jobs: () => Promise.resolve([]) } as unknown as Client;
    const app = { client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [], runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, refresh: () => undefined, toast: (text: string) => void said.push({ text }) } as unknown as AppState;
    const run = detail([]);
    const live = { ...run, run: { ...run.run, status: 'running', endedAt: null } } as RunDetail;
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(RunHeader, { run: live, call: null, selected: 3, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined, labels: [], setLabels: () => undefined })));
    const fork = page.one('#forkBtn');
    expect([fork.getAttribute('disabled'), fork.getAttribute('aria-disabled'), fork.getAttribute('title')]).toEqual([null, 'true', null]);
    expect((JSON.parse(fork.getAttribute('data-tip')!) as { s: string }).s).toBe('Fork once the recording finishes');
    await page.focus(fork);
    expect(page.focused()).toBe(fork);
    await page.press('Enter');
    await page.click(fork);
    expect(said.map((x) => x.text)).toContain('Fork once the recording finishes');
  });
});

describe('a run page’s Delete', () => {
  /** The Delete a run page confirms, on a server whose deletes answer `answer`: what it sent and what it said. */
  async function deleter(answer: () => Promise<{ deleted: string; attempts?: string[] }>) {
    const said: Said[] = [];
    const sent: string[] = [];
    const client = { remove: (id: string) => (sent.push(id), answer()) } as unknown as Client;
    const app = { client, refresh: () => undefined, toast: (text: string, _tone?: string, action?: ToastAction) => void said.push({ text, action }) } as unknown as AppState;
    let del: ReturnType<typeof useDeleteRun> | null = null;
    const Host = () => {
      del = useDeleteRun();
      return null;
    };
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(Host)));
    return { said, sent, del: del! };
  }
  const pending = (runId: string) => ({ runId, chips: ['recording'], attempts: 2, startedAt: 1 });

  it('takes the run off the lists and goes to Runs, deleting nothing until its toast goes', async () => {
    const id = '01M5JEQWB0QMJ3NYD1C687WP08';
    const d = await deleter(() => Promise.resolve({ deleted: id, attempts: ['a1', 'a2'] }));
    d.del(pending(id));
    expect(vi.mocked(navigate)).toHaveBeenLastCalledWith(href.runs());
    expect(pendingHidden().has(id)).toBe(true);
    expect(d.sent).toEqual([]);
    const toast = d.said.at(-1)!;
    expect(toast.text).toBe('Deleted 01M5JEQWB0 and 2 attempts');
    expect(toast.action).toMatchObject({ label: 'Undo', undo: true });
    // Its time out: the delete goes once, and the toast isn't said again.
    toast.action!.onGone!(false);
    await page!.until('the delete sent', () => d.sent.length === 1);
    expect(d.sent).toEqual([id]);
    expect(d.said).toHaveLength(1);
  });

  it('sends nothing after Undo, and puts the run back', async () => {
    const id = '01M5JEQWB1QMJ3NYD1C687WP08';
    const d = await deleter(() => Promise.resolve({ deleted: id }));
    d.del(pending(id));
    const toast = d.said.at(-1)!;
    // Pressed, the toast goes first, then Undo's own work runs.
    toast.action!.onGone!(true);
    toast.action!.run();
    await page!.wait(10);
    expect(d.sent).toEqual([]);
    expect(pendingHidden().has(id)).toBe(false);
    expect(d.said.at(-1)!.text).toBe('Restored 01M5JEQWB1');
  });

  it('sends the delete when the toast’s × closes it, and says why the server refused one, the run back', async () => {
    const id = '01M5JEQWB2QMJ3NYD1C687WP08';
    const d = await deleter(() => Promise.reject(new Error('the run is still recording')));
    d.del(pending(id));
    d.said.at(-1)!.action!.onGone!(true);
    await page!.until('the refusal', () => d.said.length === 2);
    expect(d.sent).toEqual([id]);
    expect(d.said.at(-1)!.text).toBe('The run is still recording');
    expect(pendingHidden().has(id)).toBe(false);
  });
});
