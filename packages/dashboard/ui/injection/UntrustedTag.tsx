import { TRUST_FROM } from '../../../engine/src/trust-words.js';
import { SrSpace } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import type { UntrustedView } from '../types.js';

/** The untrusted tag's card: where the mark came from, and the model call that reads the read. */
export function untrustedTip(r: UntrustedView): string {
  return tipCard(`untrusted · ${TRUST_FROM[r.from]}`, [], `${r.from === 'sdk' ? 'Marked in the agent’s code. ' : ''}It brings outside text in: shadowlap injection plants its payloads here, and model call #${String(r.readAt)} reads it.`);
}

/**
 * An untrusted read's tag, after its effect in Calls and Turns, as `shadowlap show` tags it: one step
 * brighter than the effect, never a consequence's colour. Its card says where the mark came from and
 * which model call reads it. A space before it for a screen reader ("read untrusted"); in a row it
 * takes no focus of its own, as the row is the stop (HoverCard.tsx). One component, so a grouped row
 * draws it the same way.
 */
export function UntrustedTag({ read }: { read: UntrustedView | undefined }) {
  if (!read) return null;
  return (
    <>
      <SrSpace />
      <span className="eff untrusted" data-tip={untrustedTip(read)}>
        untrusted
      </span>
    </>
  );
}
