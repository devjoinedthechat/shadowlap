import { shortId } from './format.js';
import { ACTIONS, confirmWords } from './labels.js';
import { settingsTabLabel } from './pages/settings/tabs.js';
import type { Route } from './route.js';
import type { RunAbout } from './types.js';

/**
 * The browser tab's title for each route, as the design's docTitle() names them: a run by its id,
 * every other page by what it is, then the product: "01M5GHQ477 — shadowlap", "Redaction · Settings
 * — shadowlap". An exported copy runs the same pages, so its title follows navigation too. No DOM
 * here: the tests import it.
 */

/** What every title ends with. */
export const TITLE_END = ' — shadowlap';

/**
 * The most of a run's about line a title holds. A tab can't be measured, so this is the one place a
 * line is fitted by a count: the shell passes the longest of its forms that keeps to it (`tabAbout`
 * in about.ts, one that keeps the line's end first, as the design's docTitle has it), and one that
 * still doesn't fit is left out, never cut mid-word.
 */
export const TAB_ABOUT_MAX = 26;

export interface TitleFacts {
  /** The project's setup shows in place of the page (no runs yet, or `#/setup`). */
  setup?: boolean | null;
  /** Why the project can't be opened (its folder is gone): its setup page says so. */
  problem?: { name: string } | null;
  /** The fix a fix's page opens, by its title, once the fixes read model has it. */
  fixTitle?: string | null;
  /** The run's about line (decision 10), when the server sends one. */
  about?: string | null;
}

/**
 * The about line of the run the run page has open, as its own read of the run gives it: the run
 * list leaves attempts out, so the tab of an attempt's page reads its about line from here. The run
 * page sets it; the shell's title reads it for that run only.
 */
let openRun: { runId: string; about: Pick<RunAbout, 'text' | 'from'> | null } | null = null;
const titleListeners = new Set<() => void>();

export function setOpenRunAbout(runId: string | null, about: Pick<RunAbout, 'text' | 'from'> | null = null): void {
  const next = runId ? { runId, about } : null;
  if (openRun?.runId === next?.runId && openRun?.about?.text === next?.about?.text) return;
  openRun = next;
  for (const f of titleListeners) f();
}

export function openRunAbout(): typeof openRun {
  return openRun;
}

export function onOpenRunAbout(f: () => void): () => void {
  titleListeners.add(f);
  return () => titleListeners.delete(f);
}

/** What the route's page is, before the product's name. */
export function pageTitle(route: Route, facts: TitleFacts = {}): string {
  if (facts.setup) return facts.problem ? `Can’t open ${facts.problem.name}` : 'Set up';
  switch (route.page) {
    case 'overview':
      return 'Overview';
    case 'runs':
      return 'Runs';
    case 'run': {
      const about = facts.about?.trim();
      return `${shortId(route.id)}${about && about.length <= TAB_ABOUT_MAX ? ` · ${about}` : ''}`;
    }
    case 'compare':
      return route.a && route.b ? `${shortId(route.a)} → ${shortId(route.b)} · Compare` : 'Compare';
    case 'fixes':
      return route.id ? `${facts.fixTitle?.trim() || route.id} · Fix` : 'Fixes';
    case 'tests':
      return 'Tests';
    case 'training':
      return route.tab === 'tasks' ? 'Tasks · Training' : 'Pairs · Training';
    case 'settings':
      return `${settingsTabLabel(route.tab)} · Settings`;
    case 'new':
      return confirmWords(ACTIONS.addProject.label);
    case 'setup':
      return 'Set up';
    case 'store-setup':
      return ACTIONS.setUpTeamStore.label;
    case 'notfound':
      return 'Not found';
  }
}

/** The tab's title for the route: the page, then the product. */
export function docTitle(route: Route, facts: TitleFacts = {}): string {
  return `${pageTitle(route, facts)}${TITLE_END}`;
}
