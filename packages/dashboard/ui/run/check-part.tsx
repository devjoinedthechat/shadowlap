import { createContext, useContext, type ReactNode } from 'react';
import type { CallDetail, RunDetail } from '../api.js';
import { goldenName } from '../format.js';

/** What the check menu offers to start from, by the key the builder's kinds take. */
export type CheckKind = 'never' | 'neverargs' | 'must' | 'after' | 'every' | 'when' | 'judge';

/**
 * The check builder (checks/Builder.tsx): opened from a run's tool call with the kind picked in its
 * check menu, or on a golden to add a check to it or change one of its checks (`edit`, the check's
 * label as the CLI labels it, found in the golden's entry as the builder reads it). A part of its own
 * that the served dashboard hands a run's page and Tests (served-parts.ts, from pages/served.tsx) and
 * an exported copy never does: a copy draws no Add check… nor Edit check…, so its one script holds no
 * builder (OnShow.tsx). Apart from the entries (check-entry.tsx, tests/check-entries.tsx), so the
 * first look, whose served parts name the builder, holds this module and not them.
 */
export type BuilderProps = { onClose: () => void } & ({ run: RunDetail; call: CallDetail; kind: CheckKind } | { golden: string; edit: string | null });

/**
 * What the check menu at a tool call takes (CheckMenu.tsx): its call, once it came, and the rule
 * picked. A part of its own, handed in beside the builder (served-parts.ts).
 */
export interface CheckMenuProps {
  anchor: HTMLElement;
  call: CallDetail | null;
  onPick: (kind: CheckKind) => void;
  onClose: () => void;
}

/** The builder's title: from a call, `Add check`; on a golden, adding to it or changing its check. The entry's own dialog takes it where the builder's script didn't come. */
export function builderTitle(golden: string | null, o: { edit: boolean; fromCall: boolean }): string {
  if (golden && o.edit) return `Edit check of ${goldenName(golden)}`;
  return golden && !o.fromCall ? `Add check to ${goldenName(golden)}` : 'Add check';
}

/**
 * Remove on a check of a golden's on Tests (checks/RemoveCheck.tsx): a part of its own, which asks
 * first with the lines that leave shadowlap.config.json. `check` is the check's label as the CLI
 * labels it, found in the golden's entry as the dialog reads it. `onChanged` is called once a write
 * landed: the removal, and its toast's Undo.
 */
export interface RemoveProps {
  golden: string;
  check: string;
  onClose: () => void;
  onChanged: () => void;
}

/** Remove's title, which its entry's own dialog takes too where its script didn't come. */
export const removeTitle = (golden: string): string => `Remove check from ${goldenName(golden)}?`;

/** What the entry that opened the builder shows in its place once its script failed to come (check-entry.tsx). */
export const BuilderFailed = createContext<ReactNode>(null);

/** The builder's `failed`: what the entry hands it, which closes through that entry. */
export function BuilderLost() {
  return <>{useContext(BuilderFailed)}</>;
}
