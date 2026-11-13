import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isObject } from '../../../engine/src/is-object.js';
import { JUDGE_SCOPE } from '../../../engine/src/judge-scope.js';
import type { CallDetail, CallRow, RunDetail } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icon.js';
import { useMenu } from '../components/Popover.js';
import { useServedParts } from '../served-parts.js';
import { useApp } from '../state.js';
import type { NextStep } from '../types.js';
import { BuilderFailed, builderTitle, NoBuilder, type CheckKind } from './check-part.js';

/**
 * Add check… on a run's page: first in a tool call's row menu, on the inspector's summary line and in
 * ⌘K, each opening the check menu at the call, whose pick opens the check builder (checks/). Both are
 * parts of their own that the served dashboard hands the page (served-parts.ts): nothing here imports their
 * code, so the run's page carries only the entries, and an exported copy, handed neither, none.
 */

/** Where Add check… opens the check menu, and its builder's script asked for ahead. */
export interface CheckEntry {
  open: (anchor: HTMLElement) => void;
  preload: () => void;
}

/**
 * Whether a call takes Add check…: a tool call, neither a person's recorded answer nor a judge's call,
 * of a recording that has finished and is no capture, on a dashboard that can act.
 */
export function addsCheck(run: RunDetail, call: Pick<CallRow, 'kind' | 'scope' | 'input'> | null, o: { exported: boolean; actionsOff: string | null }): boolean {
  return !!call && call.kind === 'tool' && !call.input && call.scope !== JUDGE_SCOPE && takesChecks(run, o);
}

/** Whether a run's tool calls take Add check…: a recording that has finished and is no capture, on a dashboard that can act. */
const takesChecks = (run: RunDetail, o: { exported: boolean; actionsOff: string | null }): boolean => run.run.status !== 'running' && !run.source && !o.exported && !o.actionsOff;

/** A tool call's arguments, as the inspector reads them from its request. */
export function argsOf(detail: CallDetail): Record<string, unknown> {
  const request = detail.request as { args?: unknown } | null;
  const args = isObject(request) && 'args' in request ? request.args : request;
  return isObject(args) ? args : {};
}

/** The inspector's Add check…, on its summary line: it opens the check menu at itself. */
export function AddCheckLink({ check }: { check: CheckEntry }) {
  return (
    <ActionButton className="linkbtn ckins" aria-haspopup="menu" aria-expanded="false" data-act="ckmenu" onPointerEnter={check.preload} onFocus={check.preload} onClick={(e) => check.open(e.currentTarget)}>
      <Icon name="plus" />
      Add check…
    </ActionButton>
  );
}

/**
 * Add check… for the selected call: the entry the row menu, the inspector and ⌘K open the check menu
 * through, undefined where the call takes none (`addsCheck`) or where nothing hands the page the menu
 * and the builder (an exported copy); and what to draw, the check menu and the builder once a rule is
 * picked. A menu whose script didn't come closes, saying so in the error toast every part a press
 * opens says it in (pages/served.tsx); a builder's draws its small dialog in its place.
 */
export function useCheckEntry(o: { run: RunDetail; row: CallRow | null; detail: CallDetail | null }): { check: CheckEntry | undefined; fromPalette: (() => void) | undefined; offered: boolean; node: ReactNode } {
  const app = useApp();
  const { CheckBuilder: Builder, CheckMenu: Menu } = useServedParts();
  const menu = useMenu();
  const [start, setStart] = useState<{ call: CallDetail; kind: CheckKind } | null>(null);
  const handed = !!Builder && !!Menu;
  const can = handed && addsCheck(o.run, o.row, app);
  const openAt = menu.openAt;
  const entry = useMemo<CheckEntry | undefined>(() => {
    if (!Builder || !Menu) return undefined;
    // Both scripts asked for at once, as Add check… is reached: the menu, then the builder its pick opens.
    const preload = () => {
      Menu.preload();
      Builder.preload();
    };
    return {
      open: (el) => {
        preload();
        openAt(el);
      },
      preload,
    };
  }, [Builder, Menu, openAt]);
  const call = o.detail && o.row && o.detail.call.callNo === o.row.callNo ? o.detail : null;
  const close = useCallback(() => setStart(null), []);
  const callNo = o.row?.callNo;
  const fromPalette = useCallback(() => {
    // The menu at the row's own button where it is drawn (rows are windowed), else at the inspector's link.
    const at = document.querySelector<HTMLElement>(`button[aria-label="Fork at #${String(callNo)}"]`) ?? document.querySelector<HTMLElement>('[data-act="ckmenu"]');
    if (at) setTimeout(() => entry?.open(at));
  }, [callNo, entry]);
  // A selection that moves to a call that takes none closes the menu.
  const closeMenu = menu.close;
  useEffect(() => {
    if (!can) closeMenu();
  }, [can, closeMenu]);
  const node = (
    <>
      {menu.anchor && Menu ? (
        <Menu
          anchor={menu.anchor}
          call={call}
          onPick={(kind) => {
            menu.close();
            if (call) setStart({ call, kind });
          }}
          onClose={menu.close}
        />
      ) : null}
      {start && Builder ? (
        <BuilderFailed.Provider value={<NoBuilder title="Add check" onClose={close} />}>
          <Builder run={o.run} call={start.call} kind={start.kind} onClose={close} />
        </BuilderFailed.Provider>
      ) : null}
    </>
  );
  // Whether the run's tool calls take Add check… here, as no checks' hover tells it.
  return { check: can ? entry : undefined, fromPalette: can ? fromPalette : undefined, offered: handed && takesChecks(o.run, app), node };
}

/**
 * Edit check…, a test replay's step where its golden's own recording fails a check added since: the
 * builder on the golden at that check (`check`, its label, found in the entry as the builder reads
 * it). None where nothing hands the page the builder (an exported copy); on a dashboard that can't
 * act it keeps its place and says why. Lime as the run's lead; Needs a look's row draws it plain
 * (`className`).
 */
export function EditCheckStep({ step, className = 'btn lime' }: { step: Extract<NextStep, { key: 'edit-check' }>; className?: string }) {
  const Builder = useServedParts().CheckBuilder;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!Builder) return null;
  const ahead = () => Builder.preload();
  return (
    <>
      <ActionButton className={className} data-next={step.key} tip={step.label} sub={step.sub} onPointerEnter={ahead} onFocus={ahead} onClick={() => setOpen(true)}>
        {step.label}
      </ActionButton>
      {open ? (
        <BuilderFailed.Provider value={<NoBuilder title={builderTitle(step.golden, { edit: true, fromCall: false })} onClose={close} />}>
          <Builder golden={step.golden} edit={step.check} onClose={close} />
        </BuilderFailed.Provider>
      ) : null}
    </>
  );
}
