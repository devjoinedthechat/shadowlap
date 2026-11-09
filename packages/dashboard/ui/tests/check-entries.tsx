import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GoldenRow, TestsView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { LoadFailed } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { onShow } from '../components/OnShow.js';
import { BuilderFailed, builderTitle, CheckBuilderPart, removeTitle, type RemoveProps } from '../run/check-part.js';
import { useApp } from '../state.js';
import type { LeadPress } from './Verdict.js';

/**
 * A golden's checks on Tests, each changed where it stands: where a pointer hovers, Edit and Remove
 * end each check and Add check… the last, shown on the row's hover or focus; on a touch screen, and
 * where the checks sit under the golden's name, one line under them, Edit checks… and Add check….
 * Edit and Add check… open the check builder on the golden, a part the served dashboard hands the
 * page (run/check-part.tsx); Remove asks first in a dialog of its own (checks/RemoveCheck.tsx). Tests
 * imports neither: only the golden and the check's label go to them, which find the check in the
 * golden's entry as they read it.
 */

/** Remove's dialog, a part of its own, loaded the first time a Remove is reached or pressed. */
const RemoveDialog = onShow<RemoveProps>(() => import('../checks/RemoveCheck.js').then((m) => m.RemoveCheck), { failed: <RemoveLost /> });

/** What the entry shows in Remove's place once its script failed to come. */
const RemoveFailed = createContext<ReactNode>(null);

function RemoveLost() {
  return <>{useContext(RemoveFailed)}</>;
}

/** What a cell's button opens: the builder on the golden, at a check (`check`, its label) or to add one; or Remove at a check. */
export type CheckOpen = { act: 'builder'; golden: string; check: string | null } | { act: 'remove'; golden: string; check: string };

export interface CheckEntries {
  open: (o: CheckOpen) => void;
  /** The pointer or the focus on a button: what it opens asked for ahead. */
  preload: (act: CheckOpen['act']) => void;
}

/** The cells' entries: null where the page offers none, an exported copy (no builder) or a dashboard that can't act. */
export const CheckEntriesOf = createContext<CheckEntries | null>(null);

/** How long after a dialog closes the view read again may still hand the focus to the golden's Add check…. */
const BACK_MS = 5000;

/** The first of the controls the selector finds that shows: each golden's checks are drawn twice, one copy hidden at each width. */
function shownAdd(golden: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-ck="add"]')].find((el) => el.getAttribute('data-g') === golden && el.getClientRects().length > 0) ?? null;
}

/**
 * Tests' entries and what they open. A dialog gives the focus back to what opened it as it closes;
 * where that went with the check (a check removed, or changed by the builder), the view read again
 * hands it to the golden's Add check…, in the copy that shows. Tests reads its view again after the
 * builder closes, and after each write of Remove's or its Undo's. `edit` opens the builder at a check
 * for the verdict's Edit check, wherever the page has the builder: the step's button says why it
 * waits on a dashboard that can't act.
 */
export function useCheckEntries(view: TestsView | null, reload: () => void): { entries: CheckEntries | null; edit: LeadPress['edit']; node: ReactNode } {
  const { actionsOff } = useApp();
  const Builder = useContext(CheckBuilderPart);
  const [open, setOpen] = useState<CheckOpen | null>(null);
  const back = useRef<{ golden: string; until: number } | null>(null);
  const entries = useMemo<CheckEntries | null>(() => (Builder && !actionsOff ? { open: setOpen, preload: (act) => (act === 'remove' ? RemoveDialog.preload() : Builder.preload()) } : null), [Builder, actionsOff]);
  const edit = useMemo<LeadPress['edit']>(() => (Builder ? { open: (golden, check) => setOpen({ act: 'builder', golden, check }), preload: () => Builder.preload() } : null), [Builder]);
  const golden = open?.golden;
  const close = useCallback(() => {
    if (golden !== undefined) back.current = { golden, until: Date.now() + BACK_MS };
    setOpen(null);
  }, [golden]);
  const closeBuilder = useCallback(() => {
    close();
    reload();
  }, [close, reload]);
  useEffect(() => {
    const b = back.current;
    back.current = null;
    if (!b || Date.now() > b.until) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    shownAdd(b.golden)?.focus({ preventScroll: true });
  }, [view]);
  if (!open || !Builder) return { entries, edit, node: null };
  if (open.act === 'remove') {
    return {
      entries,
      edit,
      node: (
        <RemoveFailed.Provider value={<NoPart title={removeTitle(open.golden)} what="dialog" onClose={close} />}>
          <RemoveDialog golden={open.golden} check={open.check} onClose={close} onChanged={reload} />
        </RemoveFailed.Provider>
      ),
    };
  }
  return {
    entries,
    edit,
    node: (
      <BuilderFailed.Provider value={<NoPart title={builderTitle(open.golden, { edit: open.check !== null, fromCall: false })} what="check builder" onClose={closeBuilder} />}>
        {/* eslint-disable-next-line react-hooks/static-components -- the one part the served dashboard hands the page (App.tsx), the same on every render */}
        <Builder golden={open.golden} edit={open.check} onClose={closeBuilder} />
      </BuilderFailed.Provider>
    ),
  };
}

/** In a part's place when its script didn't come: a small dialog, titled as the part would be, with LoadFailed's line and Retry. */
function NoPart({ title, what, onClose }: { title: string; what: string; onClose: () => void }) {
  return (
    <Dialog title={title} cancel="Close" onClose={onClose}>
      <LoadFailed what={what} />
    </Dialog>
  );
}

/** A cell's button's attributes: what it does and to what, by which the focus finds it again once the page is drawn anew. */
const at = (act: 'edit' | 'remove' | 'add', golden: string, check?: string) => ({ 'data-ck': act, 'data-g': golden, ...(check === undefined ? {} : { 'data-label': check }) });

/** Add check… as an icon, after a golden's last check, or after its exit status only. */
function AddIcon({ row, entries }: { row: GoldenRow; entries: CheckEntries }) {
  const ahead = () => entries.preload('builder');
  return (
    <ActionButton {...at('add', row.path)} aria-label={`Add check to ${row.name}`} tip="Add check…" onPointerEnter={ahead} onFocus={ahead} onClick={() => entries.open({ act: 'builder', golden: row.path, check: null })}>
      <Icon name="plus" />
    </ActionButton>
  );
}

/** Edit and Remove at the end of a check, Add check… too after the last: shown on the row's hover or focus where a pointer hovers. */
export function CheckActs({ row, check, last }: { row: GoldenRow; check: string; last: boolean }) {
  const entries = useContext(CheckEntriesOf);
  if (!entries) return null;
  const ahead = () => entries.preload('builder');
  const aheadRemove = () => entries.preload('remove');
  return (
    <span className="cka">
      <ActionButton {...at('edit', row.path, check)} aria-label={`Edit ${check}`} tip="Edit…" onPointerEnter={ahead} onFocus={ahead} onClick={() => entries.open({ act: 'builder', golden: row.path, check })}>
        <Icon name="edit" />
      </ActionButton>
      <ActionButton {...at('remove', row.path, check)} aria-label={`Remove ${check}`} tip="Remove" onPointerEnter={aheadRemove} onFocus={aheadRemove} onClick={() => entries.open({ act: 'remove', golden: row.path, check })}>
        <Icon name="x" />
      </ActionButton>
      {last ? <AddIcon row={row} entries={entries} /> : null}
    </span>
  );
}

/**
 * After a golden's checks: Add check… as an icon where it has none, then the line that shows in the
 * icons' place on a touch screen and where the checks sit under the golden's name, Edit checks… (the
 * builder at its first check) and Add check….
 */
export function CheckTail({ row }: { row: GoldenRow }) {
  const entries = useContext(CheckEntriesOf);
  if (!entries) return null;
  const first = row.checks[0];
  const ahead = () => entries.preload('builder');
  return (
    <>
      {first === undefined ? (
        <span className="cka">
          <AddIcon row={row} entries={entries} />
        </span>
      ) : null}
      <span className="ckt">
        {first === undefined ? null : (
          <ActionButton className="linkbtn" {...at('edit', row.path, first)} onPointerEnter={ahead} onFocus={ahead} onClick={() => entries.open({ act: 'builder', golden: row.path, check: first })}>
            Edit checks…
          </ActionButton>
        )}
        <ActionButton className="linkbtn" {...at('add', row.path)} onPointerEnter={ahead} onFocus={ahead} onClick={() => entries.open({ act: 'builder', golden: row.path, check: null })}>
          Add check…
        </ActionButton>
      </span>
    </>
  );
}
