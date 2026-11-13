import { createContext, useContext, type ReactNode } from 'react';
import type { CallDetail, RunDetail } from '../api.js';
import { LoadFailed } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { goldenName } from '../format.js';

/** What the check menu offers to start from, by the key the builder's kinds take. */
export type CheckKind = 'never' | 'neverargs' | 'must' | 'after' | 'every' | 'when' | 'judge';

/**
 * The check builder (checks/Builder.tsx): opened from a run's tool call with the kind picked in its
 * check menu, on a golden to add a check to it or change one of its checks (`edit`, the check's
 * label as the CLI labels it, found in the golden's entry as the builder reads it), or on a fix
 * (`BuilderFix`). A part of its own that the served dashboard hands a run's page, Tests and a fix's
 * (served-parts.ts, from pages/served.tsx) and an exported copy never does: a copy draws no Add
 * check… nor Edit check…, so its one script holds no builder (OnShow.tsx). Apart from the entries
 * (run/check-entry.tsx, tests/check-entries.tsx, fixes/check-entry.tsx), so the first look, whose
 * served parts name the builder, holds this module and not them.
 */
export type BuilderProps = { onClose: () => void } & ({ run: RunDetail; call: CallDetail; kind: CheckKind } | { golden: string; edit: string | null } | { fix: BuilderFix } | { golden: string | null; edit: null; fix: BuilderFix });

/**
 * A fix as the builder takes it: on its own, an open fix whose check it changes (fix mode, Edit
 * check…); with a golden, a fix of any other status beside a check added to the golden that guards it
 * (Add check to <golden>…), or to none (`golden: null`), which only says how to pack one.
 */
export interface BuilderFix {
  fixId: string;
  title: string;
  /** Its label: the golden a pack of its fixed run would make. */
  label: string | null;
  /** Its check as it keeps it, the units the builder opens on: null for the exit code alone. */
  expect: unknown;
  /** Its first failing run: the run the editor reads, and whose agent's goldens and models it offers. */
  runId: string;
  /** Whether a change blames it again first: it has a blame, and not one no call could rescue. */
  blamesAgain: boolean;
  /** A recording of it working, which a golden is packed from while none guards it. */
  fixedRun: string | null;
}

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

/** What an entry hands it: in the builder's place, a small dialog titled as the builder would be, with LoadFailed's line and Retry. */
export function NoBuilder({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <Dialog title={title} cancel="Close" onClose={onClose}>
      <LoadFailed what="check builder" />
    </Dialog>
  );
}
