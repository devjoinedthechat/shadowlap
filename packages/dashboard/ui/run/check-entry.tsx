import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { asNumber } from '../../../engine/src/checks/grammar.js';
import { isObject } from '../../../engine/src/is-object.js';
import { JUDGE_SCOPE } from '../../../engine/src/judge-scope.js';
import type { CallDetail, CallRow, RunDetail } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { LoadFailed } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { Popover, useMenu } from '../components/Popover.js';
import { useServedParts } from '../served-parts.js';
import { useApp } from '../state.js';
import { BuilderFailed, type CheckKind } from './check-part.js';

/**
 * Add check… on a run's page: first in a tool call's row menu, on the inspector's summary line and in
 * ⌘K, each opening the check menu at the call, whose pick opens the check builder (checks/), a part
 * of its own. Nothing here imports the builder's code, so the run's page carries only the entries.
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

/** The check menu's rules for a call, each with the key of the check it writes, as the fork menu shows a flag. */
export function checkMenuItems(name: string, args: Record<string, unknown>): Array<{ kind: CheckKind; label: string; keys: string }> {
  const keys = Object.keys(args);
  const [first] = keys;
  // A number as a check compares one: the engine's rule, which the builder's argument picker reads by too.
  const num = keys.find((k) => asNumber(args[k]) !== null);
  return [
    { kind: 'never', label: `Never call ${name}`, keys: 'tools' },
    ...(first !== undefined
      ? [
          { kind: 'neverargs' as const, label: 'Never with these arguments', keys: 'tools · args' },
          { kind: 'must' as const, label: `Must call with ${first} = …`, keys: 'tools · args' },
        ]
      : [{ kind: 'must' as const, label: `Must call ${name}`, keys: 'tools' }]),
    { kind: 'after', label: 'Only after…', keys: 'calls · after' },
    ...(num === undefined ? [] : [{ kind: 'every' as const, label: `${num.charAt(0).toUpperCase()}${num.slice(1).replace(/_/g, ' ')} at most…`, keys: 'calls · args' }]),
    { kind: 'when', label: 'When… then…', keys: 'when' },
  ];
}

/** The check menu at a call: its rules, then a judge's question about the whole run. It waits for the call, as the fork menu does. */
function CheckMenu({ anchor, call, onPick, onClose }: { anchor: HTMLElement; call: CallDetail | null; onPick: (kind: CheckKind) => void; onClose: () => void }) {
  if (!call) {
    return (
      <Popover key="loading" anchor={anchor} onClose={onClose} className="fkm ckm" label="Add check">
        <div className="pnote">Loading the call…</div>
      </Popover>
    );
  }
  const c = call.call;
  const item = (kind: CheckKind, label: string, keys: string) => (
    <button key={kind} type="button" role="menuitem" onClick={() => onPick(kind)}>
      <b>{label}</b>
      <small>{keys}</small>
    </button>
  );
  return (
    <Popover key="menu" anchor={anchor} onClose={onClose} className="fkm ckm" label={`Add check at #${c.callNo}`}>
      <div className="pk">
        Add check · #{c.callNo} <code className="rnm">{c.name}</code>
      </div>
      {checkMenuItems(c.name, argsOf(call)).map((i) => item(i.kind, i.label, i.keys))}
      <hr />
      <div className="pk">The whole run</div>
      {item('judge', 'Ask a judge…', 'judge')}
    </Popover>
  );
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

/** In the builder's place when its script didn't come: a small dialog with LoadFailed's line and Retry. */
function NoBuilder({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Add check" cancel="Close" onClose={onClose}>
      <LoadFailed what="check builder" />
    </Dialog>
  );
}

/**
 * Add check… for the selected call: the entry the row menu, the inspector and ⌘K open the check menu
 * through, undefined where the call takes none (`addsCheck`) or where nothing hands the page the
 * builder (an exported copy); and what to draw, the check menu and the builder once a rule is picked.
 */
export function useCheckEntry(o: { run: RunDetail; row: CallRow | null; detail: CallDetail | null }): { check: CheckEntry | undefined; fromPalette: (() => void) | undefined; offered: boolean; node: ReactNode } {
  const app = useApp();
  const Builder = useServedParts().CheckBuilder;
  const menu = useMenu();
  const [start, setStart] = useState<{ call: CallDetail; kind: CheckKind } | null>(null);
  const can = !!Builder && addsCheck(o.run, o.row, app);
  const openAt = menu.openAt;
  const entry = useMemo<CheckEntry | undefined>(
    () =>
      Builder
        ? {
            open: (el) => {
              Builder.preload();
              openAt(el);
            },
            preload: () => Builder.preload(),
          }
        : undefined,
    [Builder, openAt],
  );
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
      {menu.anchor ? (
        <CheckMenu
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
        <BuilderFailed.Provider value={<NoBuilder onClose={close} />}>
          <Builder run={o.run} call={start.call} kind={start.kind} onClose={close} />
        </BuilderFailed.Provider>
      ) : null}
    </>
  );
  // Whether the run's tool calls take Add check… here, as no checks' hover tells it.
  return { check: can ? entry : undefined, fromPalette: can ? fromPalette : undefined, offered: !!Builder && takesChecks(o.run, app), node };
}
