import { useState } from 'react';
import { ApiError, JOB_KINDS, type ActionItem, type BisectOffer, type CallDetail, type RunDetail, type RunOffers } from '../api.js';
import { asksConsent, dialogCopy, forkMenu, forkMenuTitle } from '../actions.js';
import { ConsentDialog, PromptDialog } from '../components/Dialog.js';
import { Popover } from '../components/Popover.js';
import { callName, shortId } from '../format.js';
import { useApp } from '../state.js';
import { bisectBlocked, bisectLabel } from './offers.js';
import { BisectDialog } from './RunDialogs.js';

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

/** A Find the commit with nothing known about the run's revisions: the dialog asks for a commit. */
const UNKNOWN_BISECT = (runId: string): BisectOffer => ({ target: { kind: 'run', runId }, failed: true, good: null, bad: null, revisions: [], fork: false, live: false, unavailable: null, args: null });

/**
 * Starts an action, or opens its dialog when it asks for something first. Find the commit, which the
 * fork menu lists with the whole run's actions, is the tests' `bisect` job: its dialog asks for a
 * commit where the run still worked. A replay of a run from someone else's pack, or a teammate's
 * pulled from the team store, runs their command: the server refuses it until it is confirmed, and
 * says the command, which a dialog shows, and only its Run sends the yes.
 */
export function useActionRunner(runId: string, capture = false, offers: RunOffers | null = null) {
  const app = useApp();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [bisecting, setBisecting] = useState(false);
  const [consent, setConsent] = useState<{ p: PendingAction; value?: string; why: string } | null>(null);
  const findCommit = () => {
    if (app.actionsOff) return app.toast(app.actionsOff);
    const blocked = bisectBlocked(runId, offers?.bisect ?? null, app.hasKind(JOB_KINDS.bisect));
    if (blocked) return app.toast(blocked);
    app.guard(() => setBisecting(true));
  };
  const start = (p: PendingAction, value?: string, yes = false) => {
    app.guard(
      () =>
        void app.client.action(runId, p.action.key, p.callNo, value, yes).then(
          (job) => app.watchJob(Promise.resolve(job)),
          (err: unknown) => {
            if (!yes && err instanceof ApiError && err.status === 409 && asksConsent(err.message)) setConsent({ p, ...(value !== undefined ? { value } : {}), why: err.message });
            else app.watchJob(Promise.reject(err));
          },
        ),
    );
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
  ) : consent ? (
    <ConsentDialog
      why={consent.why}
      ok="Run"
      onClose={() => setConsent(null)}
      onOk={() => {
        const c = consent;
        setConsent(null);
        start(c.p, c.value, true);
      }}
    />
  ) : bisecting ? (
    <BisectDialog
      runId={runId}
      offer={offers?.bisect ?? UNKNOWN_BISECT(runId)}
      onClose={() => setBisecting(false)}
      onRun={(good) => {
        setBisecting(false);
        app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId, good })));
      }}
    />
  ) : null;
  return { run, dialog, findCommit };
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
export function ForkMenu({ anchor, run, call, offers, onPick, onFindCommit, onClose }: { anchor: HTMLElement; run: RunDetail; call: CallDetail | null; offers: RunOffers | null; onPick: (p: PendingAction) => void; onFindCommit: () => void; onClose: () => void }) {
  const { hasKind, actionsOff } = useApp();
  // Opened from a row that isn't the selected call, the menu waits for the call. Once it arrives the
  // menu opens afresh (its key), so its first item takes the focus as it does on a call already loaded.
  if (!call) {
    return (
      <Popover key="loading" anchor={anchor} onClose={onClose} className="fkm" label="Fork">
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
  const blocked = bisectBlocked(run.run.runId, offers?.bisect ?? null, hasKind(JOB_KINDS.bisect));
  const bisect = bisectLabel(offers?.bisect);
  return (
    <Popover key="menu" anchor={anchor} onClose={onClose} className="fkm" label={`Fork at #${c.callNo}`}>
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
          <hr />
          <div className="pk">The whole run</div>
          {menu.run.map((m) => (
            <button key={m.action.key} type="button" role="menuitem" disabled={!!m.action.disabled} title={m.action.disabled ?? m.action.hint ?? m.action.flag ?? undefined} onClick={() => pick(m.action, null)}>
              <b>{m.label}</b>
              <small>{m.flag}</small>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            disabled={!!blocked || !!actionsOff}
            title={actionsOff ?? blocked ?? bisect.hint}
            onClick={() => {
              onClose();
              onFindCommit();
            }}
          >
            <b>{bisect.label}</b>
            <small>bisect</small>
          </button>
        </>
      )}
    </Popover>
  );
}
