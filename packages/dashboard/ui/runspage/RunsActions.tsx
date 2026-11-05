import { useCallback, useLayoutEffect, useRef } from 'react';
import { JOB_KINDS } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { ACTIONS } from '../labels.js';
import { useApp } from '../state.js';
import type { TeamStoreView } from '../types.js';

/** Pull's and Push's cards: what each brings or sends, and the command its job runs. */
export const PULL_TIP = tipCard('Pull', [], 'Teammates’ runs from the store', '$ shadowlap pull');
export const PUSH_TIP = tipCard('Push local runs', [], 'Copies them to the store with your credentials; nothing passes through Shadowlap', '$ shadowlap push --all');

/**
 * Runs' header actions, in this order: Pull with a team store, Import capture…, and Push local runs in
 * lime while runs are only on this machine (the store's own count, which leaves out a run still
 * recording). Push leaving once its runs are in the store hands its focus to Import capture…, never
 * the page's body. On a dashboard that changes nothing each says why it is off.
 */
export function RunsActions({ store, onImport }: { store: TeamStoreView | null; onImport: () => void }) {
  const { client, actionsOff, hasKind, guard, watchJob } = useApp();
  const off = actionsOff ?? undefined;
  const importButton = useRef<HTMLButtonElement>(null);
  const toImport = useCallback(() => importButton.current?.focus(), []);
  return (
    <>
      {store && hasKind(JOB_KINDS.pull) ? (
        <button className="btn" type="button" disabled={!!off} title={off} data-tip={off ? undefined : PULL_TIP} onClick={() => guard(() => watchJob(client.startJob(JOB_KINDS.pull, {})))}>
          Pull
        </button>
      ) : null}
      {hasKind(JOB_KINDS.importCapture) ? (
        <button ref={importButton} className="btn" type="button" disabled={!!off} title={off} onClick={() => guard(onImport)}>
          <Icon name="import" />
          {ACTIONS.importCapture.label}
        </button>
      ) : null}
      {store && hasKind(JOB_KINDS.push) && store.onlyLocal > 0 ? <PushButton off={off} onPush={() => guard(() => watchJob(client.startJob(JOB_KINDS.push, { all: true })))} onGone={toImport} /> : null}
    </>
  );
}

/** Push local runs, in lime; `onGone`, when it leaves the page holding the focus, which would otherwise fall to the body. */
function PushButton({ off, onPush, onGone }: { off: string | undefined; onPush: () => void; onGone: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = button.current;
    return () => {
      if (!el || document.activeElement !== el) return;
      // Once it is out of the page, unless something else took the focus meanwhile.
      queueMicrotask(() => {
        if (!document.activeElement || document.activeElement === document.body) onGone();
      });
    };
  }, [onGone]);
  return (
    <button ref={button} className="btn lime" type="button" disabled={!!off} title={off} data-tip={off ? undefined : PUSH_TIP} onClick={onPush}>
      Push local runs
    </button>
  );
}
