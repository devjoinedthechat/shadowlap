import { onShownProject, shownProject } from './projects-api.js';
import { href } from './route.js';

/**
 * Changes' tab and Compare's pair as this page last showed them, per project: the nav's Changes,
 * `g c` and Go to open the tab last shown in the project the page shows, Compare at the pair it last
 * showed. Kept in memory, as Runs keeps its view: a reload opens Verdicts. A revision's page isn't
 * kept: the list is. No DOM, and nothing from ui/changes/, so the shell holds it in the first look.
 */

/** The tabs a page notes: Verdicts and Compare (a preview's and a migration's join with their pages). */
export type ShownTab = 'verdicts' | 'compare';

interface Kept {
  tab: ShownTab;
  /** The two runs Compare last showed, or none. */
  pair: readonly [string, string] | null;
}

const kept = new Map<string, Kept>();
const heard = new Set<() => void>();
const NONE: Kept = { tab: 'verdicts', pair: null };

const now = (): Kept => kept.get(shownProject() ?? '') ?? NONE;

function keep(next: Kept): void {
  const was = now();
  if (was.tab === next.tab && was.pair?.[0] === next.pair?.[0] && was.pair?.[1] === next.pair?.[1]) return;
  kept.set(shownProject() ?? '', next);
  for (const l of [...heard]) l();
}

/** Changes shows this tab, in the project the page shows. */
export function noteChangesTab(tab: ShownTab): void {
  keep({ ...now(), tab });
}

/** Compare shows these two runs. */
export function noteComparePair(a: string, b: string): void {
  keep({ ...now(), pair: [a, b] });
}

/** Compare found a run of its pair gone: the next Compare opens as `#/compare` does, on the newest fork or replay against its parent. */
export function forgetComparePair(): void {
  keep({ ...now(), pair: null });
}

/** The two runs Compare last showed in the project, or none: the same pair, the same value, so a hook can hold it. */
export function comparePair(): readonly [string, string] | null {
  return now().pair;
}

/** Compare at the pair it last showed, else `#/compare`, which opens on the newest fork or replay against its parent. */
export function comparePairHref(): string {
  const pair = comparePair();
  return pair ? href.compare(pair[0], pair[1]) : href.compare();
}

/** Changes at the tab last shown: Compare at its pair, else Verdicts' list. */
export function changesHref(): string {
  return now().tab === 'compare' ? comparePairHref() : href.changes();
}

/** Hears a tab or a pair noted, and the page turn to another project (whose tab is its own); returns what stops it. */
export function onChangesTab(listener: () => void): () => void {
  heard.add(listener);
  const off = onShownProject(() => listener());
  return () => {
    heard.delete(listener);
    off();
  };
}
