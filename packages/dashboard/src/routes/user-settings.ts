import { messageOf, readSpending, SPENDING_REFUSED, validSpending, writeSpending, type SpendingSetting } from '@shadowlap/engine';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';

/**
 * Settings that are the person's own on this machine, whatever project is open (engine
 * user-settings.ts): Spending, the threshold above which a billed job asks before it starts. They are
 * kept in settings.json in Shadowlap's folder for this machine's files (shadowlapHome), never in
 * shadowlap.config.json, so CI and teammates never take them on, and nothing in the CLI reads them.
 *
 * `GET /api/user/spending` says the threshold (`askAbove`: dollars, 0 for Always ask, null for Never
 * ask), whether it was set, and what in the file was ignored and why; not where the file is. `PUT
 * /api/user/spending { askAbove }` keeps one, and answers what it was (`was`), for an Undo to put
 * back. It acts on no project, so a page still showing another may change it; a read-only dashboard
 * refuses it, as it does every write.
 */

/** How long a write waits for another process holding the file: the server's thread waits with it, so briefly. */
const LOCK_WAIT_MS = 250;

/** Spending as the page reads it: where the file is stays on the server. */
const shown = (s: SpendingSetting) => ({ askAbove: s.askAbove, set: s.set, problems: s.problems });

export function register(router: Router): void {
  router.get('/user/spending', (r) => r.json(shown(readSpending())));

  router.put(
    '/user/spending',
    async (r) => {
      const body = await r.body();
      if (!validSpending(body.askAbove)) throw new HttpError(400, SPENDING_REFUSED);
      let kept: ReturnType<typeof writeSpending>;
      try {
        kept = writeSpending(body.askAbove, { lockTimeoutMs: LOCK_WAIT_MS });
      } catch (err) {
        // A file it would lose something of, a newer Shadowlap's, or one another process holds: kept as it was, and why.
        throw new HttpError(409, messageOf(err));
      }
      r.json({ ...shown(kept), was: kept.was });
    },
    { anyProject: true },
  );
}
