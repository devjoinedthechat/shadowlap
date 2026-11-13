import { onShownProject, shownProject } from './projects-api.js';
import { href } from './route.js';

/**
 * Changes' tab, Compare's pair, Preview's session and Migrate's migration as this page last showed
 * them, per project: the nav's Changes, `g c` and Go to open the tab last shown in the project the
 * page shows, Compare at the pair it last showed, Preview and Migrate at the session. Kept in memory, as Runs keeps its view: a reload
 * opens Verdicts. A revision's page isn't kept: the list is. No DOM, and nothing from ui/changes/, so
 * the shell holds it in the first look.
 */

/** The tabs a page notes: Verdicts, Compare, Preview (`decisions`) and Migrate. */
export type ShownTab = 'verdicts' | 'compare' | 'decisions' | 'migrate';

interface Kept {
  tab: ShownTab;
  /** The two runs Compare last showed, or none. */
  pair: readonly [string, string] | null;
  /** The preview Preview last showed, or none. */
  session: string | null;
  /** The migration Migrate last showed, or none. */
  migration: string | null;
}

const kept = new Map<string, Kept>();
const heard = new Set<() => void>();
const NONE: Kept = { tab: 'verdicts', pair: null, session: null, migration: null };

const now = (): Kept => kept.get(shownProject() ?? '') ?? NONE;

function keep(next: Kept): void {
  const was = now();
  if (was.tab === next.tab && was.pair?.[0] === next.pair?.[0] && was.pair?.[1] === next.pair?.[1] && was.session === next.session && was.migration === next.migration) return;
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

/** Compare found a run of its pair gone: the next Compare opens as `#/compare` does, on the newest fork against its parent (defaultComparePair). */
export function forgetComparePair(): void {
  keep({ ...now(), pair: null });
}

/** The two runs Compare last showed in the project, or none: the same pair, the same value, so a hook can hold it. */
export function comparePair(): readonly [string, string] | null {
  return now().pair;
}

/** Compare at the pair it last showed, else `#/compare`, which opens on the newest fork against its parent (defaultComparePair). */
export function comparePairHref(): string {
  const pair = comparePair();
  return pair ? href.compare(pair[0], pair[1]) : href.compare();
}

/** Preview shows this session. */
export function notePreviewSession(id: string): void {
  keep({ ...now(), session: id });
}

/** Preview found the session it last showed gone: the next Preview opens on the newest. */
export function forgetPreviewSession(): void {
  keep({ ...now(), session: null });
}

/** The preview Preview last showed in the project, or none. */
export function previewSession(): string | null {
  return now().session;
}

/** Preview at the session it last showed, else `#/changes/decisions`, which opens on the newest. */
export function previewSessionHref(): string {
  return href.changeSession('decisions', now().session);
}

/** Migrate shows this migration. */
export function noteMigration(id: string): void {
  keep({ ...now(), migration: id });
}

/** Migrate found the migration it last showed gone: the next Migrate opens as its bare tab does. */
export function forgetMigration(): void {
  keep({ ...now(), migration: null });
}

/** The migration Migrate last showed in the project, or none. */
export function migrationShown(): string | null {
  return now().migration;
}

/** Migrate at the migration it last showed, else `#/changes/migrate`, which opens on a retiring model or the newest migration. */
export function migrationHref(): string {
  return href.changeSession('migrate', now().migration);
}

/** Changes at the tab last shown: Compare at its pair, Preview and Migrate at their session, else Verdicts' list. */
export function changesHref(): string {
  const tab = now().tab;
  return tab === 'compare' ? comparePairHref() : tab === 'decisions' ? previewSessionHref() : tab === 'migrate' ? migrationHref() : href.changes();
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
