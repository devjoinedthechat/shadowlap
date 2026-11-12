import { resolveAuthor } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import { HttpError, readObject } from '../http.js';
import { ADVICE_TEXT_MAX, isAdviceKey } from '../needs-look/advice.js';
import type { Router } from '../router.js';

/**
 * Dismiss, on Needs a look's advice only (dismissals.ts). What is put away is kept in this project's
 * store alone and never pushed, so a Dismiss changes what one person sees, not the project: it is no
 * event, and Activity never lists it.
 *
 * `POST /api/needs-look/dismissals { key, facts }` puts the advice under `key` away with the facts
 * its row states, and answers what was kept for it before (`was`: null, or its facts) and the
 * store's dismissals counter after the write. An Undo writes `was` back: its facts with a POST, or,
 * when it was null, a DELETE. `DELETE /api/needs-look/dismissals/:key` brings the advice back
 * (Restore): `restored` is false when nothing was kept, which is no error, so a second press is
 * none. Both act on the current project's store: a page still showing another is refused (409).
 */

/** A Dismiss of the runs only on this machine states every one's id: at about 29 bytes each, 2 MB holds some 70,000. */
export const DISMISSAL_LIMIT = 2 * 1024 * 1024;

const NO_FACTS = 'facts must list what the advice states, at least one';

/** The advice's key, refused unless it names advice: a failure is never put away. */
function keyOf(key: unknown): string {
  if (typeof key !== 'string' || !key) throw new HttpError(400, 'a dismissal needs the key of the advice it puts away');
  if (!isAdviceKey(key)) throw new HttpError(400, `only advice can be dismissed, not "${key.slice(0, 80)}"`);
  return key;
}

/** At least one, each a string: none kept would put nothing away. */
function factsOf(facts: unknown): string[] {
  if (!Array.isArray(facts) || !facts.length) throw new HttpError(400, NO_FACTS);
  for (const f of facts) if (typeof f !== 'string' || !f || f.length > ADVICE_TEXT_MAX) throw new HttpError(400, NO_FACTS);
  return facts as string[];
}

export function register(router: Router, ctx: RouteContext): void {
  // Who put it away, kept with it and never answered or shown: worked out once, since it runs git,
  // which a press shouldn't wait for on the server's thread each time.
  let actor: string | null | undefined;
  const whoAmI = (): string | null => {
    if (actor === undefined) actor = ctx.project ? resolveAuthor({ cwd: ctx.project.path }) : null;
    return actor;
  };
  const counter = (): number => ctx.store.changeCounts().dismissals ?? 0;

  router.post('/needs-look/dismissals', async (r) => {
    const body = await readObject(r.req, DISMISSAL_LIMIT);
    const key = keyOf(body.key);
    const facts = factsOf(body.facts);
    const was = ctx.store.getDismissal(key);
    const kept = ctx.store.putDismissal({ key, facts, actor: whoAmI() });
    r.json({ key, facts: kept.facts, was: was ? { facts: was.facts } : null, dismissals: counter() });
  });

  router.delete('/needs-look/dismissals/:key', (r) => {
    const key = keyOf(r.params.key);
    const restored = ctx.store.deleteDismissal(key);
    r.json({ key, restored, dismissals: counter() });
  });
}
