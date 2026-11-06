import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import type { RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Undo on a run's page: a label's × takes the label off at once, hands the focus to Add label where
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
