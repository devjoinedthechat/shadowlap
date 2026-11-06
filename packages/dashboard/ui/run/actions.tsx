import { useState } from 'react';
import { JOB_KINDS, type ActionItem, type BisectOffer, type CallDetail, type RunDetail, type RunOffers } from '../api.js';
import { consentAsked, forkMenu, forkMenuTitle, forkRowLine, menuLabel } from '../actions.js';
import { dialogCopy } from './fork-dialog.js';
import { ConfirmDialog, ConsentDialog, PromptDialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { Popover } from '../components/Popover.js';
import { callName, shortId } from '../format.js';
import { confirmWords } from '../labels.js';
import { useApp } from '../state.js';
import { bisectBlocked, bisectCardCommand, bisectLabel } from './offers.js';
import { BisectDialog } from './RunDialogs.js';
import { ActionButton } from '../components/ActionButton.js';
import { tipEst, useBilledPress } from '../components/JobButton.js';
import { AskNote } from '../components/AskNote.js';
import { sentEstimate } from '../spending.js';
import { isFork, rowPriced, useDialogEstimate, useRunEstimates, type RowPrice } from './estimates.js';

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
  /** The call is a model call, as Run live's ask words it. */
  modelCall?: boolean;
  /** The run it acts on, where it isn't the page's: Replay recording replays the recording a replay came from. */
  runId?: string;
  /**
   * What it bills, as the fork menu's row said it (`rowPriced`): false for a row that bills nothing.
   * Left out (a key, the banner), the runner tells a row that bills nothing by its key and the run.
   */
  estimate?: RowPrice;
}

/** A Find breaking commit with nothing known about the run's revisions: the dialog asks for a commit. */
const UNKNOWN_BISECT = (runId: string): BisectOffer => ({ target: { kind: 'run', runId }, failed: true, good: null, bad: null, revisions: [], fork: false, live: false, unavailable: null, args: null });

/**
 * Starts an action, or opens its dialog when it asks for something first, or only whether to start
 * (`asksFirst`: a fork's Repeat 5 times, whose attempts run live). Find breaking commit, which the
 * fork menu lists with the whole run's actions, is the tests' `bisect` job: its dialog asks for a
 * commit where the run still worked. A replay of a run from someone else's pack, or a teammate's
 * pulled from the team store, runs their command: the server refuses it until it is confirmed, and
 * says the command, which a dialog shows, and only its Run sends the yes.
 */
export function useActionRunner(runId: string, capture = false, offers: RunOffers | null = null, forkAt?: number | null) {
  const app = useApp();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [bisecting, setBisecting] = useState(false);
  const [consent, setConsent] = useState<{ p: PendingAction; value?: string; why: string; confirm: string } | null>(null);
  const findCommit = () => {
    if (app.actionsOff) return app.toast(app.actionsOff);
    const blocked = bisectBlocked(runId, offers?.bisect ?? null, app.hasKind(JOB_KINDS.bisect));
    if (blocked) return app.toast(blocked);
    app.guard(() => setBisecting(true));
  };
  const press = useBilledPress();
  // Each start sends the estimate the row or its ask showed, the consent's yes too, so the drawer says the same.
  const start = (p: PendingAction, value?: string, yes?: string) =>
    app.guard(
      () =>
        void app.client.action(p.runId ?? runId, p.action.key, p.callNo, value, yes, sentEstimate(p.estimate || null)).then(
          (job) => app.watchJob(Promise.resolve(job)),
          (err: unknown) => {
            const asked = yes === undefined ? consentAsked(err) : null;
            if (asked) setConsent({ p, ...(value !== undefined ? { value } : {}), ...asked });
            else app.watchJob(Promise.reject(err));
          },
        ),
    );
  // A prompt opens its dialog on every setting, as a form does; a row that bills nothing starts; the rest follow Spending.
  const run = (p: PendingAction) => {
    if (p.action.disabled) return app.toast(p.action.disabled);
    if (app.actionsOff) return app.toast(app.actionsOff);
    const priced = 'estimate' in p ? p.estimate : rowPriced(undefined, p.action, forkAt != null || !!p.action.asksFirst);
    if (p.action.prompt) app.guard(() => setPending(p));
    else if (priced === false) app.guard(() => start(p));
    else press({ estimate: priced, start: () => start(p), ask: () => setPending(p) });
  };
  const dialog = pending ? (
    <ActionDialog
      runId={pending.runId ?? runId}
      capture={capture}
      forkAt={forkAt}
      pending={pending}
      onClose={() => setPending(null)}
      onRun={(v, estimate) => start({ ...pending, estimate }, v)}
    />
  ) : consent ? (
    <ConsentDialog
      why={consent.why}
      ok="Run command"
      onClose={() => setConsent(null)}
      onOk={() => start(consent.p, consent.value, consent.confirm)}
    />
  ) : bisecting ? (
    <BisectDialog
      runId={runId}
      offer={offers?.bisect ?? UNKNOWN_BISECT(runId)}
      onClose={() => setBisecting(false)}
      onRun={(good) => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId, good })))}
    />
  ) : null;
  return { run, dialog, findCommit };
}

/**
 * The dialog an action asks in. Its Cost line says the estimate once it has come, Switch model's for
 * the model in its field, and the job starts with what the line said; an ask's footer says why it
 * asks where Spending's threshold is why.
 */
export function ActionDialog({ runId, capture, forkAt, pending, onRun, onClose }: { runId: string; capture: boolean; forkAt: number | null | undefined; pending: PendingAction; onRun: (v: string | undefined, estimate: RowPrice) => boolean; onClose: () => void }) {
  const [model, setModel] = useState('');
  const estimate = useDialogEstimate(runId, pending, forkAt != null || !!pending.action.asksFirst, model);
  const copy = dialogCopy(pending.action, {
    id: shortId(runId),
    callNo: pending.callNo,
    capture,
    forkAt: forkAt ?? null,
    ...(pending.callName !== undefined ? { callName: pending.callName } : {}),
    ...(pending.recorded !== undefined ? { recorded: pending.recorded } : {}),
    ...(pending.modelCall ? { modelCall: true } : {}),
  });
  const { title, lead, doc, warn, facts, factsUnder, cost, ok } = copy;
  const billed = estimate === false ? {} : { ...(cost ? { cost: estimate ? { ...cost, estimate } : cost } : {}), footNote: <AskNote estimate={estimate} form={!!pending.action.prompt} /> };
  const slots = { title: copy.titleName ? namedIn(title, copy.titleName) : title, lead, ok, onClose, ...(doc ? { doc } : {}), ...(warn ? { warn } : {}), ...(facts ? { facts } : {}), ...(cost ? { cost } : {}), ...billed };
  // Nothing to fill in: it asks only whether to start, as it runs live.
  if (!pending.action.prompt) return <ConfirmDialog {...slots} {...(copy.command ? { command: copy.command('') } : {})} onOk={() => onRun(undefined, estimate)} />;
  return (
    <PromptDialog
      {...slots}
      {...(pending.action.key === 'm' ? { onAnswer: setModel } : {})}
      {...(factsUnder ? { factsUnder } : {})}
      {...(copy.label ? { label: copy.label } : {})}
      {...(copy.fieldName ? { fieldName: copy.fieldName } : {})}
      {...(copy.command ? { command: copy.command } : {})}
      {...(copy.choices ? { choices: copy.choices } : {})}
      {...(copy.startFrom ? { startFrom: copy.startFrom } : {})}
      multiline={copy.multiline}
      initial={copy.initial}
      placeholder={copy.placeholder}
      onRun={(v) => onRun(v, estimate)}
    />
  );
}

/**
 * The fork menu at a call: what applies to that call, each with its flag on the right, then what
 * applies to the whole run. A capture has no command, so it says so and offers its replay.
 */
export function ForkMenu({ anchor, run, call, offers, onPick, onFindCommit, onClose }: { anchor: HTMLElement; run: RunDetail; call: CallDetail | null; offers: RunOffers | null; onPick: (p: PendingAction) => void; onFindCommit: () => void; onClose: () => void }) {
  const { hasKind } = useApp();
  // What each row bills at this call, asked as the menu opens on it: its answer redraws the menu in place.
  const estimates = useRunEstimates(run.run.runId, call ? call.call.callNo : undefined);
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
  const runId = run.run.runId;
  const shortName = callName(c.kind, c.name);
  const menu = forkMenu(call.actions, c.kind === 'tool' ? c.name : null);
  const recorded = (call.result as { result?: unknown } | null)?.result;
  const fork = isFork(call.actions);
  const pick = (action: ActionItem, callNo: number | null) => {
    onClose();
    onPick({ action, callNo, ...(recorded !== undefined ? { recorded } : {}), callName: shortName, ...(c.kind === 'api' ? { modelCall: true } : {}), estimate: rowPriced(estimates, action, fork) });
  };
  const capture = !!run.source;
  const replay = call.actions.find((a) => a.key === 'r');
  const blocked = bisectBlocked(runId, offers?.bisect ?? null, hasKind(JOB_KINDS.bisect));
  const bisect = bisectLabel(offers?.bisect);
  // A row's one line says what it runs; what it is for is on its card, with the flag on the command it adds it to.
  const item = (m: ReturnType<typeof forkMenu>['call'][number]) => ({
    why: m.action.disabled,
    tip: confirmWords(m.label),
    sub: forkRowLine(m.action),
    command: m.action.flag?.startsWith('--') ? `$ shadowlap replay ${shortId(runId)} ${m.action.flag}` : undefined,
    est: priceOnCard(rowPriced(estimates, m.action, fork), !!m.action.prompt),
  });
  return (
    <Popover key="menu" anchor={anchor} onClose={onClose} className="fkm" label={`Fork at #${c.callNo}`}>
      <div className="pk">{call.forkTitle ?? forkMenuTitle({ ...c, ...(c.input ? { input: true } : {}) }, shortName)}</div>
      {capture && replay ? (
        <>
          <div className="pnote">A capture has no command. Replay it with yours first; every fork works on that replay.</div>
          <ActionButton role="menuitem" tip={confirmWords(menuLabel(replay))} sub="Gives the capture your command; every fork works on that replay" command={`$ shadowlap replay ${shortId(runId)} -- <your command>`} onClick={() => pick(replay, null)}>
            <b>{menuLabel(replay)}</b>
            <small>replay</small>
          </ActionButton>
        </>
      ) : (
        <>
          {menu.call.map((m) => (
            <ActionButton key={m.action.key} role="menuitem" {...item(m)} onClick={() => pick(m.action, c.callNo)}>
              <b>{m.label}</b>
              <small>{m.flag}</small>
            </ActionButton>
          ))}
          {menu.call.length === 0 ? <div className="pnote">Nothing forks at this call.</div> : null}
          <hr />
          <div className="pk">The whole run</div>
          {menu.run.map((m) => (
            <ActionButton key={m.action.key} role="menuitem" {...item(m)} onClick={() => pick(m.action, null)}>
              <b>{m.label}</b>
              <small>{m.flag}</small>
            </ActionButton>
          ))}
          <ActionButton
            role="menuitem"
            why={blocked}
            tip={confirmWords(bisect.label)}
            sub={bisect.hint}
            command={bisectCardCommand(offers?.bisect ?? UNKNOWN_BISECT(runId))}
            onClick={() => {
              onClose();
              onFindCommit();
            }}
          >
            <b>{bisect.label}</b>
            <small>bisect</small>
          </ActionButton>
        </>
      )}
    </Popover>
  );
}

/** A row's price on its card: none for a row that bills nothing; an item that asks in a dialog says the amount alone. */
function priceOnCard(priced: RowPrice, form: boolean) {
  return priced === false ? null : tipEst(priced, form);
}
