import { href } from '../../route.js';
import type { CiTeamStore } from '../../types.js';

/**
 * Settings → CI's Team store row, in the Fix on failure panel: whether the step pushes each fix to
 * the team store, which Push from CI decides. It says what it follows, how that stands, and leads
 * to Settings → Store, where it is set. Not a switch: the CI tab has none for it, so it is never set
 * in two places. Apart from Ci.tsx, which needs the browser, so a test can render it.
 */
export function TeamStoreRow({ store }: { store: CiTeamStore }) {
  return (
    <div className="setrow tight cistore">
      <div>
        <b>Team store</b>
        <span>{store.note}</span>
      </div>
      <a className="linkbtn" href={href.settings('store')} title={store.name ? `Push from CI is set in Settings → Store, for ${store.name}` : 'A team store is set up in Settings → Store'}>
        Settings → Store
      </a>
    </div>
  );
}
