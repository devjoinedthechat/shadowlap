import { useCallback, useState, type ReactNode } from 'react';
import { JOB_KINDS } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { goldenName } from '../format.js';
import { ACTIONS } from '../labels.js';
import { BuilderFailed, NoBuilder, type BuilderFix, type BuilderProps } from '../run/check-part.js';
import { useServedParts } from '../served-parts.js';
import { useApp } from '../state.js';
import type { FixDetail } from '../types.js';

/**
 * The way to change what a fix must do, at the end of its Must line and as a spent repair's way out:
 * an open fix's own check (Edit check…), else a check added to the golden that guards it, which keeps
 * the fix while the fix keeps the check its verdict was given under. Each opens the check builder
 * (checks/), a part the served dashboard hands in (served-parts.ts): nothing here imports its code,
 * so the Fixes page carries only the entry, and a copy, handed no builder, draws none.
 */

/** A fix as the builder takes it (run/check-part.tsx). */
export function builderFix(fix: FixDetail): BuilderFix {
  const run = fix.failingRuns.find((r) => r.exists) ?? fix.failingRuns[0];
  return { fixId: fix.fixId, title: fix.title, label: fix.label, expect: fix.expect, runId: run?.runId ?? '', blamesAgain: !!fix.blame && fix.blame.outcome !== 'unrescuable', fixedRun: fix.fixedRun };
}

/** The entry's words: its label and its card's line, by the fix's status and its golden. */
export function checkEntryWords(fix: Pick<FixDetail, 'status' | 'guard'>): { label: string; sub: string } {
  if (fix.status === 'open') return { label: ACTIONS.editCheck.label, sub: 'Judges its failing and good runs again from their recordings, nothing replayed' };
  if (!fix.guard) return { label: 'Add check…', sub: 'The fix keeps the check its verdict was given under, and no golden keeps it yet' };
  const name = goldenName(fix.guard);
  return { label: `Add check to ${name}…`, sub: `The fix keeps the check its verdict was given under; ${name} keeps the fix, and takes a new one` };
}

export interface FixCheckEntry {
  label: string;
  sub: string;
  /** Why it can't open here: an open fix's change runs as a job this server must run. */
  wait: string | null;
  open: () => void;
  preload: () => void;
  /** The builder while it is open. */
  node: ReactNode;
}

/** The entry on a fix, undefined where nothing hands the page the builder (an exported copy). */
export function useFixCheckEntry(fix: FixDetail): FixCheckEntry | undefined {
  const app = useApp();
  const Builder = useServedParts().CheckBuilder;
  const [opened, setOpened] = useState<BuilderProps | null>(null);
  const close = useCallback(() => setOpened(null), []);
  if (!Builder || app.exported) return undefined;
  const words = checkEntryWords(fix);
  const own = fix.status === 'open';
  const at = builderFix(fix);
  return {
    ...words,
    wait: own && !app.hasKind(JOB_KINDS.fixCheck) ? 'This dashboard doesn’t run it: run the command in a terminal.' : null,
    open: () => {
      Builder.preload();
      setOpened(own ? { fix: at, onClose: close } : { golden: fix.guard, edit: null, fix: at, onClose: close });
    },
    preload: () => Builder.preload(),
    node: opened ? (
      <BuilderFailed.Provider value={<NoBuilder title={own ? 'Edit check' : 'Add check'} onClose={close} />}>
        <Builder {...opened} />
      </BuilderFailed.Provider>
    ) : null,
  };
}

/** The Must line's tail: a link-like button after the check, its card saying what it changes. */
export function MustCheckLink({ fix }: { fix: FixDetail }) {
  const entry = useFixCheckEntry(fix);
  if (!entry) return null;
  return (
    <span className="fmx">
      <ActionButton className="linkbtn" why={entry.wait} tip={entry.label} sub={entry.sub} onPointerEnter={entry.preload} onFocus={entry.preload} onClick={entry.open}>
        {entry.label}
      </ActionButton>
      {entry.node}
    </span>
  );
}
