import { createContext, useContext, type ReactNode } from 'react';
import type { HeldAsk } from '../held.js';
import { useServedParts } from '../served-parts.js';
import { useApp } from '../state.js';

/**
 * A page that can't find what its address names asks first whether another project on this machine
 * holds it, and if one does says so, *In support-agent*, with **Switch to support-agent**, rather than
 * that it isn't here (pages/Elsewhere.tsx). Its code waits in a script of its own until a page first
 * can't find something: the page's own loading look shows meanwhile, and the page's own not-found
 * should that script fail to come.
 *
 * The page list shows it too: a link into a project that can't be opened asks before the setup takes
 * the page (pages/lazy.tsx). An exported copy never asks, so the served entry hands its part in
 * (served-parts.ts, from pages/served.tsx), and a copy's script holds none of it.
 */

export interface ElsewhereProps {
  /** What the page couldn't find (held.ts `heldAsk`): Compare's pair asks with its missing sides only. */
  ask: HeldAsk;
  /** The page's read that failed: one that fails anew asks again only when the last ask failed, or once Switch has landed. */
  error?: Error | null;
  /** The page's own loading look, while it asks. */
  waiting: ReactNode;
  /** Reads the page again, once Switch has landed: Compare's reads don't follow a switch by themselves. */
  retry?: () => void;
  /** What the page shows when no other project holds it: its own not-found. */
  fallback: ReactNode;
}

/** The page's own looks, for the part's while its script comes and should it fail to come. */
const Looks = createContext<{ waiting: ReactNode; fallback: ReactNode }>({ waiting: null, fallback: null });

/** The page's loading look, in the part's place while its script comes (pages/served.tsx). */
export function ElsewhereWaiting() {
  return <>{useContext(Looks).waiting}</>;
}

/** The page's own not-found, in the part's place should its script fail to come. */
export function ElsewhereFallback() {
  return <>{useContext(Looks).fallback}</>;
}

/**
 * The page's not-found, once no other project holds what it names, or the In page. Only a dashboard
 * that serves projects is asked: an exported copy and one that serves one store (`--read-only`, the
 * terminal UI's) show the page's own not-found at once, and so does a page whose meta hasn't come.
 */
export function Elsewhere(props: ElsewhereProps) {
  const { exported, meta } = useApp();
  const Part = useServedParts().Elsewhere;
  if (exported || !meta?.project?.id || !Part) return <>{props.fallback}</>;
  return (
    <Looks.Provider value={props}>
      <Part {...props} />
    </Looks.Provider>
  );
}
