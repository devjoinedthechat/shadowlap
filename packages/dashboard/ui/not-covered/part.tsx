import { useServedParts, type PackDialogProps } from '../served-parts.js';

/** Not covered's Pack as golden and Pack with checks…, from the part the served dashboard hands in (PackDialog.tsx): none in a copy, which packs nothing. */
export function PackDialogPart(props: PackDialogProps) {
  const { PackDialog } = useServedParts();
  return PackDialog ? <PackDialog {...props} /> : null;
}
