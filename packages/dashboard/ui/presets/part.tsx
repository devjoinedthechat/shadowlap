import { useServedParts, type PresetsDialogProps } from '../served-parts.js';

/** Run error-path presets…'s dialog, from the part the served dashboard hands in (PresetsDialog.tsx): none in a copy, which runs nothing. */
export function PresetsDialogPart(props: PresetsDialogProps) {
  const { PresetsDialog } = useServedParts();
  return PresetsDialog ? <PresetsDialog {...props} /> : null;
}
