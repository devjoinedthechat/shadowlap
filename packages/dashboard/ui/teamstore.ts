import { useLoad } from './hooks.js';
import { useApp } from './state.js';
import type { TeamStoreView } from './types.js';

/**
 * The team store the project's config names, as this machine knows it (`GET /api/store`), for the
 * screens that change with one: the Runs page's By column, local tag, Pull and Push, Needs a look,
 * and the status bar's store and last sync. Null without a store, or in an exported copy. Read again whenever runs change (not as a recording's calls arrive: it
 * is pushed once it ends), and whenever what this machine knows of the store does (the change feed's
 * `team`): a push or a pull changes what it says.
 */
export function useTeamStore(): TeamStoreView | null {
  return useTeamStoreState().store;
}

/** The team store as `useTeamStore` reads it, and whether it has answered yet (`known`): until then, a page holds what it says of the store. */
export function useTeamStoreState(): { store: TeamStoreView | null; known: boolean } {
  const { client, runsTick, feeds, exported } = useApp();
  const { data, loading } = useLoad(() => (exported ? null : client.teamStore()), 'team-store', `${runsTick}:${feeds.team ?? 0}`);
  return { store: data ?? null, known: data !== null || !loading };
}
