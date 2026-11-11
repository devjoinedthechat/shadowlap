import { createContext, useContext, type ReactNode } from 'react';
import type { CallDetail, RunDetail } from '../api.js';
import { LoadFailed } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';

/** What the check menu offers to start from, by the key the builder's kinds take. */
export type CheckKind = 'never' | 'neverargs' | 'must' | 'after' | 'every' | 'when' | 'judge';

/**
 * The check builder (checks/Builder.tsx): opened from a run's tool call with the kind picked in its
 * check menu, on a golden to add a check to it or change one of its checks (`edit`, the check's
 * place among the golden's), or on a fix (`BuilderFix`). A part of its own that the served dashboard
 * hands a run's page and a fix's (served-parts.ts, from pages/served.tsx) and an exported copy never
 * does: a copy draws no Add check… and no Edit check…, so its one script holds no builder
 * (OnShow.tsx). Apart from the entries (run/check-entry.tsx, fixes/check-entry.tsx), so the first
 * look, whose served parts name the builder, holds this module and not them.
 */
export type BuilderProps = { onClose: () => void } & ({ run: RunDetail; call: CallDetail; kind: CheckKind } | { golden: string; edit: number | null } | { fix: BuilderFix } | { golden: string | null; edit: null; fix: BuilderFix });

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
