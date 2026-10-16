import { useLoad } from './hooks.js';
import { useApp } from './state.js';
import type { TeamStoreView } from './types.js';

/**
 * The team store the project's config names, as this machine knows it (`GET /api/store`), for the
 * screens that change with one: the Runs page's By column, local tag, Pull and Push, Needs a look,
 * and the status bar's store and last sync. Null without a store, in an exported copy, or on a
 * server without the route. Read again whenever runs change: a push or a pull changes what it says.
 */
export function useTeamStore(): TeamStoreView | null {
  const { client, tick, exported } = useApp();
  const { data } = useLoad(() => (exported ? null : client.teamStore()), 'team-store', tick);
  return data ?? null;
}
