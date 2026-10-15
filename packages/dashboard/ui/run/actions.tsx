import { useState } from 'react';
import type { ActionItem, CallDetail, RunDetail } from '../api.js';
import { dialogCopy, forkMenu, forkMenuTitle } from '../actions.js';
import { PromptDialog } from '../components/Dialog.js';
import { Popover } from '../components/Popover.js';
import { callName, shortId } from '../format.js';
import { useApp } from '../state.js';

/**
 * Running a run's actions: the fork menu at a call, and the dialog an action asks its one thing in.
 * The browser names the action; the server builds the command line.
 */

export interface PendingAction {
  action: ActionItem;
  callNo: number | null;
  /** The call's recorded result, to start an override from. */
  recorded?: unknown;
  callName?: string;
}

/** Starts an action, or opens its dialog when it asks for something first. */
export function useActionRunner(runId: string, capture = false) {
  const app = useApp();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const start = (p: PendingAction, value?: string) => {
    app.guard(() => app.watchJob(app.client.action(runId, p.action.key, p.callNo, value)));
  };
  const run = (p: PendingAction) => {
    if (p.action.disabled) return app.toast(p.action.disabled);
    if (app.actionsOff) return app.toast(app.actionsOff);
    app.guard(() => {
      if (p.action.prompt) setPending(p);
      else start(p);
    });
  };
  const dialog = pending ? (
    <ActionDialog
      runId={runId}
      capture={capture}
      pending={pending}
      onClose={() => setPending(null)}
      onRun={(v) => {
        const p = pending;
        setPending(null);
        start(p, v);
      }}
    />
  ) : null;
  return { run, dialog };
}

function ActionDialog({ runId, capture, pending, onRun, onClose }: { runId: string; capture: boolean; pending: PendingAction; onRun: (v: string) => void; onClose: () => void }) {
  const copy = dialogCopy(pending.action, {
    id: shortId(runId),
    callNo: pending.callNo,
    capture,
    ...(pending.callName !== undefined ? { callName: pending.callName } : {}),
    ...(pending.recorded !== undefined ? { recorded: pending.recorded } : {}),
  });
  return (
    <PromptDialog
      title={copy.title}
      text={copy.text || undefined}
      {...(copy.label ? { label: copy.label } : {})}
      {...(copy.command ? { command: copy.command } : {})}
      {...(copy.choices ? { choices: copy.choices } : {})}
      multiline={copy.multiline}
      initial={copy.initial}
      placeholder={copy.placeholder}
      ok={copy.ok}
      onRun={onRun}
      onClose={onClose}
    />
  );
}

/**
 * The fork menu at a call: what applies to that call, each with its flag on the right, then what
 * applies to the whole run. A capture has no command, so it says so and offers its replay.
 */
export function ForkMenu({ anchor, run, call, onPick, onClose }: { anchor: HTMLElement; run: RunDetail; call: CallDetail | null; onPick: (p: PendingAction) => void; onClose: () => void }) {
  if (!call) {
    return (
      <Popover anchor={anchor} onClose={onClose} className="fkm" label="Fork">
        <div className="pnote">Loading the call…</div>
      </Popover>
    );
  }
  const c = call.call;
  const shortName = callName(c.kind, c.name);
  const menu = forkMenu(call.actions, c.kind === 'tool' ? c.name : null);
  const recorded = (call.result as { result?: unknown } | null)?.result;
  const pick = (action: ActionItem, callNo: number | null) => {
    onClose();
    onPick({ action, callNo, ...(recorded !== undefined ? { recorded } : {}), callName: shortName });
  };
  const capture = !!run.source;
  const replay = call.actions.find((a) => a.key === 'r');
  return (
    <Popover anchor={anchor} onClose={onClose} className="fkm" label={`Fork at #${c.callNo}`}>
      <div className="pk">{call.forkTitle ?? forkMenuTitle({ ...c, ...(c.input ? { input: true } : {}) }, shortName)}</div>
      {capture && replay ? (
        <>
          <div className="pnote">A capture has no command. Replay it with yours first; every fork works on that replay.</div>
          <button type="button" role="menuitem" onClick={() => pick(replay, null)}>
            <b>Replay it with your command</b>
            <small>replay</small>
          </button>
        </>
      ) : (
        <>
          {menu.call.map((m) => (
            <button key={m.action.key} type="button" role="menuitem" disabled={!!m.action.disabled} title={m.action.disabled ?? m.action.hint ?? m.action.flag ?? undefined} onClick={() => pick(m.action, c.callNo)}>
              <b>{m.label}</b>
              <small>{m.flag}</small>
            </button>
          ))}
          {menu.call.length === 0 ? <div className="pnote">Nothing forks at this call.</div> : null}
          {menu.run.length ? (
            <>
              <hr />
              <div className="pk">The whole run</div>
              {menu.run.map((m) => (
                <button key={m.action.key} type="button" role="menuitem" disabled={!!m.action.disabled} title={m.action.disabled ?? m.action.hint ?? m.action.flag ?? undefined} onClick={() => pick(m.action, null)}>
                  <b>{m.label}</b>
                  <small>{m.flag}</small>
                </button>
              ))}
            </>
          ) : null}
        </>
      )}
    </Popover>
  );
}
