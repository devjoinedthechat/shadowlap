import { useCallback, useLayoutEffect, useRef } from 'react';
import { JOB_KINDS } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { ACTIONS } from '../labels.js';
import { useApp } from '../state.js';
import type { TeamStoreView } from '../types.js';

/** Pull's and Push's cards: what each brings or sends, and the command its job runs. */
const PULL = { tip: 'Pull', sub: 'Teammates’ runs from the store', command: '$ shadowlap pull' };
const PUSH = { tip: 'Push local runs', sub: 'Copies them to the store with your credentials; nothing passes through Shadowlap', command: '$ shadowlap push --all' };
export const PULL_TIP = tipCard(PULL.tip, [], PULL.sub, PULL.command);
export const PUSH_TIP = tipCard(PUSH.tip, [], PUSH.sub, PUSH.command);

/**
 * Runs' header actions, in this order: Pull with a team store, Import capture…, and Push local runs in
 * lime while runs are only on this machine (the store's own count, which leaves out a run still
 * recording). Push leaving once its runs are in the store hands its focus to Import capture…, never
 * the page's body. On a dashboard that changes nothing each waits, its card saying why.
 */
export function RunsActions({ store, onImport }: { store: TeamStoreView | null; onImport: () => void }) {
  const { client, hasKind, guard, watchJob } = useApp();
  const importButton = useRef<HTMLButtonElement>(null);
  const toImport = useCallback(() => importButton.current?.focus(), []);
  return (
    <>
      {store && hasKind(JOB_KINDS.pull) ? (
        <ActionButton className="btn" {...PULL} onClick={() => guard(() => watchJob(client.startJob(JOB_KINDS.pull, {})))}>
          Pull
        </ActionButton>
      ) : null}
      {hasKind(JOB_KINDS.importCapture) ? (
        <ActionButton ref={importButton} className="btn" onClick={() => guard(onImport)}>
          <Icon name="import" />
          {ACTIONS.importCapture.label}
        </ActionButton>
      ) : null}
      {store && hasKind(JOB_KINDS.push) && store.onlyLocal > 0 ? <PushButton onPush={() => guard(() => watchJob(client.startJob(JOB_KINDS.push, { all: true })))} onGone={toImport} /> : null}
    </>
  );
}

/** Push local runs, in lime; `onGone`, when it leaves the page holding the focus, which would otherwise fall to the body. */
function PushButton({ onPush, onGone }: { onPush: () => void; onGone: () => void }) {
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
    <ActionButton ref={button} className="btn lime" {...PUSH} onClick={onPush}>
      Push local runs
    </ActionButton>
  );
}
