import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icon.js';
import type { Dismissed } from '../dismissals-api.js';
import { num } from '../format.js';
import { useLatest } from '../hooks.js';
import { onShownProject, shownProject } from '../projects-api.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { type AppState, useApp } from '../state.js';
import { errorText, type ToastAction } from '../toast.js';
import type { NeedsLookRow } from '../types.js';
import { hold, holdBack, leftOf, lookGroups, type LookGroupRows, lookMemory, setFold, settle, subscribeLook } from './dismissed.js';

/**
 * Dismiss, on Needs a look's advice only (a failure has none): the quiet × in the row's last column,
 * shown on the row's hover or focus and always on a touch screen. The row goes at once into its
 * group's Dismissed (n), the focus to the row after it there, else to Dismissed (n), and a toast
 * offers Undo (⌘Z). Under Dismissed (n), opened, each row is muted, still opens what it is about,
 * and has Restore in its step's place. Undo and Restore put the row back in its place with the focus
 * on it, raising no toast; the fold closes once its last row is back. Each press is kept in the
 * project's store (dismissals-api.ts), and the page holds its own view of it until a list that has
 * it arrives (dismissed.ts). Only a press reads the client and the toast.
 */

/** What a Dismiss's toast says. */
export const DISMISSED_WORDS = 'Dismissed until it changes';

const quoted = (s: string) => s.replace(/["\\]/g, '\\$&');
/** A row by its key, and what in it takes the focus once a press is drawn. */
export const rowAt = (key: string) => `[data-rowkey="${quoted(key)}"]`;
const linkOf = (key: string) => `${rowAt(key)} a.at`;
const foldOf = (group: string) => `[data-fold="${quoted(group)}"]`;

type Advised = NeedsLookRow & { advice: NonNullable<NeedsLookRow['advice']> };

export interface Dismissing {
  /** The rows by group, each put away or not, as the page shows them. */
  groups: LookGroupRows[];
  /** The groups whose Dismissed (n) is open. */
  open: ReadonlySet<string>;
  /** What is left to look at: the panel's count. */
  left: number;
  dismiss: (x: NeedsLookRow) => void;
  restore: (x: NeedsLookRow) => void;
  toggle: (group: string) => void;
}

/** What the press reads of the page as it is when pressed: the latest list and what is held. */
interface Now {
  app: AppState;
  project: string;
  items: readonly NeedsLookRow[];
  stamp: number | undefined;
}

/** The fold closes once nothing of its group but `x` is left in it. */
function foldIfLast(now: Now, x: NeedsLookRow): () => void {
  const memory = lookMemory(now.project);
  const was = memory.open.has(x.group);
  const g = lookGroups(now.items, memory.held, now.stamp).find((y) => y.group === x.group);
  if (g && !g.dismissed.some((y) => y.key !== x.key)) setFold(now.project, x.group, false);
  return () => setFold(now.project, x.group, was);
}

/**
 * A Dismiss's toast, with its Undo. The Undo writes through the client, which asks for the project
 * the page shows, and a key (`local`, `coverage`, `retire <model>`) is the same in every project, so
 * it is offered only while the page shows the project the Dismiss was made in (`madeIn`). The toast
 * goes once the page turns to another, and an Undo pressed after does nothing: it never undoes that
 * project's own dismissal.
 */
function offerUndo(app: AppState, madeIn: string | null, undo: () => void): void {
  if (shownProject() !== madeIn) return;
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const action: ToastAction = {
    label: 'Undo',
    undo: true,
    returnTo,
    run: () => {
      if (shownProject() === madeIn) undo();
    },
  };
  const stop = onShownProject(() => {
    stop();
    app.dropToast(action);
  });
  action.onGone = stop;
  app.toast(DISMISSED_WORDS, 'notice', action);
}

/**
 * Brings `x` back, and writes it: Restore deletes what was kept, and Undo writes back what was kept
 * before its Dismiss (`was`: its facts, or nothing). Refused, the row is put back where it stood,
 * and the toast says why.
 */
function bringBack(now: Now, x: Advised, write: () => Promise<{ dismissals: number }>, focus: (to: string) => void, refused: string): void {
  const key = x.advice.key;
  const was = lookMemory(now.project).held.get(key);
  const unfold = foldIfLast(now, x);
  focus(linkOf(x.key));
  hold(now.project, key, { dismissed: false, stamp: null });
  write().then(
    (a) => hold(now.project, key, { dismissed: false, stamp: a.dismissals }),
    (err: unknown) => {
      unfold();
      focus(refused);
      holdBack(now.project, key, was);
      now.app.toast(errorText(err), 'error');
    },
  );
}

/** The groups as the page shows them, and Dismiss, Restore and Undo, each moving the focus once drawn. */
export function useDismissals(items: readonly NeedsLookRow[], total: number, stamp: number | undefined, box: RefObject<HTMLElement | null>): Dismissing {
  const app = useApp();
  const project = projectOf(app.meta)?.path ?? '';
  const memory = useSyncExternalStore(subscribeLook, () => lookMemory(project));
  const groups = useMemo(() => lookGroups(items, memory.held, stamp), [items, memory.held, stamp]);
  const now = useLatest<Now>({ app, project, items, stamp });
  // A list that has a press: the server's word rules for it again.
  useEffect(() => settle(project, stamp), [project, stamp]);
  // Where the focus goes once a press is drawn: tried once, on the drawing after it.
  const want = useRef<string | null>(null);
  useLayoutEffect(() => {
    const to = want.current;
    want.current = null;
    if (to) box.current?.querySelector<HTMLElement>(to)?.focus();
  });
  const focus = useCallback((to: string) => void (want.current = to), []);

  const undo = useCallback(
    (x: Advised, answer: Dismissed) =>
      now.current.app.guard(() => {
        const { dismissals } = now.current.app.client;
        bringBack(now.current, x, () => (answer.was ? dismissals.dismiss(answer.key, answer.was.facts) : dismissals.restore(answer.key)), focus, foldOf(x.group));
      }),
    [now, focus],
  );

  const dismiss = useCallback(
    (row: NeedsLookRow) => {
      if (!row.advice) return;
      const x = row as Advised;
      const n = now.current;
      const key = x.advice.key;
      const was = lookMemory(n.project).held.get(key);
      // The row after it in its group takes the focus, else its Dismissed (n): never the row above.
      const g = lookGroups(n.items, lookMemory(n.project).held, n.stamp).find((y) => y.group === x.group);
      const next = g?.open[g.open.findIndex((y) => y.key === x.key) + 1];
      focus(next ? linkOf(next.key) : foldOf(x.group));
      const madeIn = shownProject();
      hold(n.project, key, { dismissed: true, stamp: null });
      n.app.client.dismissals.dismiss(key, x.advice.facts).then(
        (answer) => {
          hold(n.project, key, { dismissed: true, stamp: answer.dismissals });
          offerUndo(n.app, madeIn, () => undo(x, answer));
        },
        (err: unknown) => {
          focus(`${rowAt(x.key)} .adis`);
          holdBack(n.project, key, was);
          n.app.toast(errorText(err), 'error');
        },
      );
    },
    [now, focus, undo],
  );

  const restore = useCallback(
    (row: NeedsLookRow) => {
      if (!row.advice) return;
      const { dismissals } = now.current.app.client;
      bringBack(now.current, row as Advised, () => dismissals.restore(row.advice!.key), focus, `${rowAt(row.key)} .ast .btn`);
    },
    [now, focus],
  );

  const toggle = useCallback((group: string) => setFold(now.current.project, group, !lookMemory(now.current.project).open.has(group)), [now]);
  return { groups, open: memory.open, left: leftOf(items, total, memory.held, stamp), dismiss, restore, toggle };
}

/** The ×: named for its row, its card saying when the row comes back once put away. */
export function DismissButton({ x, onDismiss }: { x: NeedsLookRow; onDismiss: (x: NeedsLookRow) => void }) {
  return (
    <ActionButton className="adis" aria-label={`Dismiss: ${x.title}`} tip="Dismiss" sub={x.advice?.until ?? null} onClick={() => onDismiss(x)}>
      <Icon name="x" />
    </ActionButton>
  );
}

/** Restore, in a dismissed row's step's place. */
export function RestoreButton({ x, onRestore }: { x: NeedsLookRow; onRestore: (x: NeedsLookRow) => void }) {
  return (
    <ActionButton className="btn sm quiet" aria-label={`Restore: ${x.title}`} onClick={() => onRestore(x)}>
      Restore
    </ActionButton>
  );
}

/** A group's Dismissed (n): a quiet disclosure at its end, its caret in the icons' column, folded until opened. It opens offline too. */
export function DismissedFold({ group, n, open, onToggle }: { group: string; n: number; open: boolean; onToggle: (group: string) => void }) {
  return (
    <div className="aoff">
      <button type="button" className="linkbtn" data-fold={group} aria-expanded={open} onClick={() => onToggle(group)}>
        <Icon name="caret" />
        Dismissed ({num(n)})
      </button>
    </div>
  );
}
