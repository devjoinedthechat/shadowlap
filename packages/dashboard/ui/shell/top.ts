import { clock } from '../format.js';

/**
 * What the top bar says: the pill beside the logo, the parent in a run's crumbs, and the chip of a run
 * recording. No DOM here: the tests import it.
 */

/**
 * The pill: what kind of dashboard this is, with why on hover. An exported copy says so; a dashboard
 * that changes nothing (started with --read-only, or without the CLI to run actions) says read-only,
 * its title the reason its actions give, naming the team store when one is set; one with a team store
 * says team, as the design labels it; any other says dashboard.
 */
export function topPill(o: { exported: boolean; readOnly: boolean; actionsOff: string | null; store: string | null }): { word: string; title: string | null } {
  const team = o.store ? `team store ${o.store}` : null;
  if (o.exported) return { word: 'exported', title: o.actionsOff ?? 'This is an exported copy: nothing runs from here.' };
  if (o.readOnly) return { word: 'read-only', title: [o.actionsOff ?? 'This dashboard is read-only.', team].filter(Boolean).join(' · ') };
  if (team) return { word: 'team', title: team };
  return { word: 'dashboard', title: null };
}

/**
 * The parent a run's crumbs name (Runs / parent / run): the run list's, when it lists the run; else
 * the one in the run's own detail, once its page has loaded it (an attempt, or a run older than the
 * newest 500). An exported copy links only to runs it holds.
 */
export function crumbParent(o: { listed: { parentRunId: string | null } | null; loaded: string | null | undefined; exported: boolean; holds: (runId: string) => boolean }): string | null {
  const parent = o.listed ? o.listed.parentRunId : (o.loaded ?? null);
  return parent && (!o.exported || o.holds(parent)) ? parent : null;
}

/**
 * The chip of a run recording, as the design keeps it: while the page is connected, and while it is
 * offline, then saying when it was last heard of. Not while the link has expired: its card covers all.
 */
export function liveChip(o: { recording: string | null; conn: 'ok' | 'offline' | 'expired'; loadedAt: number | null }): { runId: string; title: string | null } | null {
  if (!o.recording || o.conn === 'expired') return null;
  return { runId: o.recording, title: o.conn === 'offline' ? `Recording when last heard of${o.loadedAt ? `, at ${clock(o.loadedAt)}` : ''}: live updates are paused` : null };
}
