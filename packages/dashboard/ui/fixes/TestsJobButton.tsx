import type { ReactNode } from 'react';
import { useTestsWait } from './tree.js';

/**
 * A button that starts a Tests job from another page (Add normalizer and Update golden on a test
 * replay's page): disabled, with the reason on hover, while the server would refuse it, as the Tests
 * page's own buttons are. `off` is the page's reason first (a read-only dashboard); `title` is the
 * hover while it can start.
 */
export function TestsJobButton({ verb, off, title, className, onClick, children }: { verb: string; off: string | null; title?: string | null; className: string; onClick: () => void; children: ReactNode }) {
  const wait = useTestsWait(verb);
  const why = off ?? wait;
  return (
    <button className={className} type="button" disabled={!!why} title={why ?? title ?? undefined} onClick={onClick}>
      {children}
    </button>
  );
}
