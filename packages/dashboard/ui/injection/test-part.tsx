import { useServedParts, type PackWithGateProps, type TestDialogProps } from '../served-parts.js';

/** Run injection test…'s dialog, from the part the served dashboard hands in (TestDialog.tsx): none in a copy, which runs nothing. */
export function TestDialogPart(props: TestDialogProps) {
  const { TestDialog } = useServedParts();
  return TestDialog ? <TestDialog {...props} /> : null;
}

/** Pack with injection gate…'s dialog, from the part the served dashboard hands in (PackWithGate.tsx): none in a copy. */
export function PackWithGatePart(props: PackWithGateProps) {
  const { PackWithGate } = useServedParts();
  return PackWithGate ? <PackWithGate {...props} /> : null;
}
