import { createContext, useContext, type ReactNode } from 'react';
import type { CallDetail, RunDetail } from '../api.js';
import type { OnShow } from '../components/OnShow.js';

/** What the check menu offers to start from, by the key the builder's kinds take. */
export type CheckKind = 'never' | 'neverargs' | 'must' | 'after' | 'every' | 'when' | 'judge';

/** The check builder (checks/Builder.tsx), opened from a run's tool call with the kind picked in its check menu. */
export interface BuilderProps {
  run: RunDetail;
  call: CallDetail;
  kind: CheckKind;
  onClose: () => void;
}

/**
 * The check builder, a part of its own that the served dashboard hands a run's page (App.tsx) and an
 * exported copy never does: a copy draws no Add check…, so its one script holds no builder
 * (OnShow.tsx). Apart from the entries (check-entry.tsx), so the shell's first look holds only this.
 */
export const CheckBuilderPart = createContext<OnShow<BuilderProps> | null>(null);

/** What the entry that opened the builder shows in its place once its script failed to come (check-entry.tsx). */
export const BuilderFailed = createContext<ReactNode>(null);

/** The builder's `failed`: what the entry hands it, which closes through that entry. */
export function BuilderLost() {
  return <>{useContext(BuilderFailed)}</>;
}
