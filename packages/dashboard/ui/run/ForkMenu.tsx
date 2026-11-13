import { useEffect } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { JOB_KINDS, type ActionItem, type BisectOffer, type CallDetail, type RunDetail, type RunOffers } from '../api.js';
import { forkMenu, forkMenuTitle, forkRowLine, menuLabel } from '../actions.js';
import { ActionButton } from '../components/ActionButton.js';
import { Copy } from '../components/Copy.js';
import type { TipEst } from '../components/HoverCard.js';
import { tipEst } from '../components/JobButton.js';
import { Popover } from '../components/Popover.js';
import { callName, shortId } from '../format.js';
import { confirmWords } from '../labels.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { bisectQuery, useBisectEstimate } from '../runspage/bisect-estimate.js';
import { useApp } from '../state.js';
import type { UntrustedView } from '../types.js';
import type { PendingAction } from './actions.js';
import type { CheckEntry } from './check-entry.js';
import { isFork, rowPriced, useRunEstimates, type RowPrice } from './estimates.js';
import { bisectBlocked, bisectLabel, unknownBisect } from './offers.js';
import { bisectCardCommand } from './dialog-copy.js';

/*
 * The fork menu, a part of its own that only the served dashboard hands in (served-parts.ts): an
 * exported copy forks nothing (no Fork at #n in its header, none on a row, so f presses nothing), so
 * its script holds no menu. The run's page loads it as the pointer or the focus reaches Fork at #n or
 * a row's fork button, so it opens at once; f or ⌘K's Fork at #n… loads it as it opens.
 */

/**
 * The fork menu at a call: what applies to that call, each with its flag on the right, then what
 * applies to the whole run. A capture has no command, so it says so and offers its replay.
 */
export function ForkMenu({ anchor, run, call, offers, check, onPick, onFindCommit, onClose, untrusted }: { anchor: HTMLElement; run: RunDetail; call: CallDetail | null; offers: RunOffers | null; check?: CheckEntry | undefined; onPick: (p: PendingAction) => void; onFindCommit: () => void; onClose: () => void; untrusted?: ReadonlyMap<number, UntrustedView> | undefined }) {
  const { hasKind } = useApp();
  // What each row bills at this call, asked as the menu opens on it: its answer redraws the menu in place.
  const estimates = useRunEstimates(run.run.runId, call ? call.call.callNo : undefined);
  // Find breaking commit's, from the commit its offer starts at, asked as the menu opens.
  const bisectPrice = useBisectEstimate(bisectQuery(run.run.runId, offers?.bisect));
  // Add check… first at a tool call's own row, never at the head's Fork button: given only where the call takes it.
  const checkHere = !!check && !!call && anchor.id !== 'forkBtn';
  useEffect(() => {
    if (checkHere) check?.preload();
  }, [checkHere, check]);
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
      <div className="pk">{call.forkTitle ?? forkMenuTitle({ ...c, ...(c.input ? { input: true } : {}) }, shortName, { untrusted: !!untrusted?.has(c.callNo) })}</div>
      {capture && replay ? (
        <>
          <Copy as="div" className="pnote">
            A capture has no command. Replay it with yours first; every fork works on that replay.
          </Copy>
          <ActionButton role="menuitem" tip={confirmWords(menuLabel(replay))} sub="Gives the capture your command; every fork works on that replay" command={`$ shadowlap replay ${shortId(runId)} -- <your command>`} onClick={() => pick(replay, null)}>
            <b>{menuLabel(replay)}</b>
            <small>replay</small>
          </ActionButton>
        </>
      ) : (
        <>
          {checkHere ? (
            <ActionButton
              role="menuitem"
              onClick={() => {
                onClose();
                check?.open(anchor);
              }}
            >
              <b>Add check…</b>
            </ActionButton>
          ) : null}
          {menu.call.map((m) => (
            <ActionButton key={m.action.key} role="menuitem" {...item(m)} onClick={() => pick(m.action, c.callNo)}>
              <b>{m.label}</b>
              <small>{m.flag}</small>
            </ActionButton>
          ))}
          {menu.call.length === 0 ? (
            <Copy as="div" className="pnote">
              Nothing forks at this call.
            </Copy>
          ) : null}
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
            whyAct={offers?.bisect?.onTests ? { label: 'Open Tests', run: () => navigate(href.tests()) } : undefined}
            tip={confirmWords(bisect.label)}
            sub={bisect.hint}
            command={bisectCardCommand(offers?.bisect ?? unknownBisect(runId))}
            est={bisectOnCard(offers?.bisect, bisectPrice)}
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

/** Find breaking commit's line on its card, the amount alone as a form's: from the commit its offer starts at, `no estimate` with none to start from yet. */
function bisectOnCard(b: BisectOffer | null | undefined, e: Estimate | null | undefined): TipEst | null {
  if (!b || b.unavailable) return null;
  return tipEst(b.good ? e : null, true);
}

/** A row's price on its card: none for a row that bills nothing; an item that asks in a dialog says the amount alone. */
function priceOnCard(priced: RowPrice, form: boolean) {
  return priced === false ? null : tipEst(priced, form);
}
