import { useEffect, useState } from 'react';
import type { Client } from '../api.js';
import { addPaletteSource } from '../palette-sources.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { FixDetail, FixList } from '../types.js';
import { fixName } from './model.js';

/**
 * What the shell knows about fixes besides the Fixes pages: each fix's name for the breadcrumb
 * (Fixes / refund-bug), and the list the palette's Fixes group is made from. Both are what the pages
 * and one load when the dashboard opens last read; the pages keep them current.
 */

const names = new Map<string, string>();
/** Each fix's title, by its id and by the id its URL gave, for the tab's title. */
const titles = new Map<string, string>();
const listeners = new Set<() => void>();
let list: FixList | null = null;
let loading: Promise<void> | null = null;

const changed = () => listeners.forEach((on) => on());

/** A fix the page loaded, by its id and by the id its URL gave (a prefix, in any case). */
export function rememberFix(d: Pick<FixDetail, 'fixId' | 'label' | 'title'>, asked?: string): void {
  const name = fixName(d);
  const known = (id: string) => names.get(id) === name && titles.get(id) === d.title;
  if (known(d.fixId) && (!asked || known(asked))) return;
  for (const id of asked ? [d.fixId, asked] : [d.fixId]) {
    names.set(id, name);
    titles.set(id, d.title);
  }
  changed();
}

export function rememberList(l: FixList): void {
  list = l;
  for (const f of l.fixes) {
    names.set(f.fixId, fixName(f));
    titles.set(f.fixId, f.title);
  }
  changed();
}

/** Loads the list again, once at a time; failures leave what was there. */
export function refreshFixes(client: Client): Promise<void> {
  if (client.exported) return Promise.resolve();
  loading ??= client
    .fixes()
    .then(rememberList, () => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * The breadcrumb's name for the fix a route opens: its label, or its short id, once known. The
 * shell's top bar calls it on every page, so it also loads the list once when the dashboard opens,
 * for the palette.
 */
export function useFixCrumb(fixId: string | null): string | null {
  useFixesKnown();
  return fixId ? (names.get(fixId) ?? null) : null;
}

/** The title of the fix a route opens, for the tab's title, once known. */
export function useFixTitle(fixId: string | null): string | null {
  useFixesKnown();
  return fixId ? (titles.get(fixId) ?? null) : null;
}

/** Draws again whenever what is known about fixes changes, and loads the list once when nothing has. */
function useFixesKnown(): void {
  const { client, exported } = useApp();
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  useEffect(() => {
    if (!exported && list === null) void refreshFixes(client);
  }, [client, exported]);
}

// The palette's Fixes group: each fix by its title, with its label and status. Opening the palette
// also loads the list again for the next time.
addPaletteSource(({ app, go }) => {
  if (app.exported) return [];
  void refreshFixes(app.client);
  return (list?.fixes ?? []).map((f) => ({ group: 'Fixes' as const, label: f.title, hint: `${fixName(f)} · ${f.status}`, match: 'blame repair verify apply', run: () => go(href.fixes(f.fixId)) }));
});
