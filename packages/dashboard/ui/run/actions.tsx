import { useState } from 'react';
import type { ActionItem, CallDetail, RunDetail } from '../api.js';
import { forkMenu, forkMenuTitle, isInject, isOverride, menuLabel } from '../actions.js';
import { PromptDialog } from '../components/Dialog.js';
import { Popover } from '../components/Popover.js';
import { callName, jsonText, shortId } from '../format.js';
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
export function useActionRunner(runId: string) {
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

function ActionDialog({ runId, pending, onRun, onClose }: { runId: string; pending: PendingAction; onRun: (v: string) => void; onClose: () => void }) {
  const a = pending.action;
  const prompt = a.prompt!;
  const n = pending.callNo;
  const id = shortId(runId);
  if (isInject(a))
    return (
      <PromptDialog
        title={`Inject an instruction at #${n}`}
        text="It goes in as a block of the last user message (--inject-as user), because some models take no system message mid-conversation, and it stays in place for every later request of the fork. Calls before it replay."
        multiline
        initial={prompt.initial ?? ''}
        placeholder={prompt.placeholder ?? 'Escalate refunds above the regional limit to tier 2.'}
        command={`shadowlap replay ${id} --inject ${n}="…" --inject-as user`}
        ok="Fork"
        onRun={onRun}
        onClose={onClose}
      />
    );
  if (isOverride(a)) {
    const recorded = pending.recorded === undefined ? (prompt.initial ?? '') : jsonText(pending.recorded);
    return (
      <PromptDialog
        title={`Override #${n}${pending.callName ? ` ${pending.callName}` : ''}`}
        text="The agent gets this instead of the recorded result. Calls before it replay; from here the run goes on live, with writes fenced."
        multiline
        initial={recorded}
        placeholder={prompt.placeholder ?? '{"ok": true}'}
        ok="Fork"
        onRun={onRun}
        onClose={onClose}
      />
    );
  }
  const title = a.key === 'r' ? (/capture|command/i.test(prompt.label) ? 'Replay a capture' : 'Replay') : a.key === 'p' ? `Pack ${id}` : a.key === 'e' ? 'Repeat the replay and compare' : a.key === 'f' ? `Answer #${n} with a failure` : a.key === 'm' ? `Switch the model from #${n}` : menuLabel(a);
  const text =
    a.key === 'p'
      ? 'A folder to commit as a golden or send to someone: run.json, calls.jsonl and one file per blob. Redaction rules apply to the copy; the store is never changed.'
      : a.key === 'f'
        ? 'Nothing is sent. Every attempt fails, so the SDK’s retry policy runs and then gives up: the path worth testing.'
        : a.key === 'm'
          ? `Calls before #${n} replay; from here the new model answers live.`
          : prompt.label;
  return (
    <PromptDialog
      title={title}
      text={text}
      {...(a.key === 'p' ? { label: 'Folder' } : a.key === 'f' ? { label: 'Status (429 rate limit, 500 or 529 overloaded, 400 bad request)' } : a.key === 'm' ? { label: 'Model' } : a.key === 'e' ? { label: 'Attempts' } : {})}
      initial={prompt.initial ?? ''}
      placeholder={prompt.placeholder ?? ''}
      ok={a.key === 'p' ? 'Pack' : a.opensRun ? (a.key === 'r' ? 'Replay' : 'Fork') : 'Run'}
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
      <div className="pk">{forkMenuTitle({ ...c, ...(c.input ? { input: true } : {}) }, shortName)}</div>
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
            <button key={m.action.key} type="button" role="menuitem" disabled={!!m.action.disabled} title={m.action.disabled ?? m.action.hint ?? undefined} onClick={() => pick(m.action, c.callNo)}>
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
                <button key={m.action.key} type="button" role="menuitem" disabled={!!m.action.disabled} title={m.action.disabled ?? m.action.hint ?? undefined} onClick={() => pick(m.action, null)}>
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
