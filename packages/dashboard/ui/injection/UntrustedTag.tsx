import { SrSpace } from '../components/bits.js';
import type { UntrustedView } from '../types.js';
import { untrustedTip } from './model.js';

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
