import type { Request } from './settings-api.js';

/** A Dismiss's answer: what is kept, what was kept before (null, or its facts), and the store's dismissals counter after it. */
export interface Dismissed {
  key: string;
  facts: string[];
  was: { facts: string[] } | null;
  dismissals: number;
}

/** A Restore's answer: false when nothing was put away. */
export interface Restored {
  key: string;
  restored: boolean;
  dismissals: number;
}

/**
 * Needs a look's advice put away and brought back (`/api/needs-look/dismissals`), in the project's
 * store alone. Dismiss sends the facts its row stated, what the person saw; an Undo writes back what
 * was kept before, with `dismiss` (its facts) or `restore` (nothing was).
 */
export interface DismissalsApi {
  dismiss(key: string, facts: readonly string[]): Promise<Dismissed>;
  restore(key: string): Promise<Restored>;
}

export function dismissalsApi(request: Request): DismissalsApi {
  return {
    dismiss: (key, facts) => request('needs-look/dismissals', { method: 'POST', body: JSON.stringify({ key, facts }) }),
    restore: (key) => request(`needs-look/dismissals/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  };
}

/** An exported copy has no Overview and keeps nothing: every call says so. */
export function noDismissals(refuse: () => Promise<never>): DismissalsApi {
  return { dismiss: refuse, restore: refuse };
}
