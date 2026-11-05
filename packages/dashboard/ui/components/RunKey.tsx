import { useCallback, useState } from 'react';
import { shortId } from '../format.js';
import { hasMark, markChange, markTitle, markToast, MARKS, undoChange, withChange, type RunMark } from '../runkey.js';
import { shortcut } from '../shortcuts.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { Icon } from './Icon.js';

/**
 * The good/bad key (runkey.ts): two buttons that label a run `good` or `bad` in one press, a press
 * of the one it holds taking it off, each change said in a toast with Undo. On a run's header with
 * their words; in a row of Runs as their marks, the words read to a screen reader.
 */
export function RunKey({ runId, labels, onMark, off, compact = false }: { runId: string; labels: readonly string[]; onMark: (m: RunMark, from?: HTMLElement) => void; off: string | null; compact?: boolean }) {
  return (
    <span className={`runkey${compact ? ' sm' : ''}`} role="group" aria-label={`Good or bad: ${shortId(runId)}`}>
      {MARKS.map((m) => {
        const on = hasMark(labels, m);
        return (
          <button
            key={m}
            type="button"
            className={`rk ${m}`}
            aria-pressed={on}
            disabled={!!off}
            title={off ?? markTitle(m, on)}
            // The key answers on a run's header; on Runs' rows only with the focus in that row, so those say nothing of it.
            {...(compact ? {} : shortcut(m === 'good' ? 'markGood' : 'markBad'))}
            onClick={(e) => {
              e.stopPropagation();
              onMark(m, e.currentTarget);
            }}
          >
            <Icon name={m === 'good' ? 'check' : 'x'} />
            {compact ? <span className="sr">{m}</span> : m}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Pressing the key: the run's labels change at once (`onLabels`), the server is told, and a toast
 * says what changed, with Undo (its button, or the undo key), which puts back what the press changed
 * and hands the focus back to `from`, the key pressed (else what had the focus). A change the server
 * refuses puts the labels back as they were, and says why.
 */
export function useMarkRun(onLabels: (runId: string, labels: string[]) => void): (runId: string, labels: readonly string[], m: RunMark, from?: HTMLElement | null) => void {
  const { client, toast, guard, refresh } = useApp();
  return useCallback(
    (runId: string, labels: readonly string[], m: RunMark, from?: HTMLElement | null) =>
      guard(() => {
        const focused = document.activeElement;
        const returnTo = from ?? (focused instanceof HTMLElement && focused !== document.body ? focused : null);
        const before = [...labels];
        const change = markChange(before, m);
        onLabels(runId, withChange(before, change));
        client.labels(runId, change.add, change.remove).then(
          (r) => {
            onLabels(runId, r.labels);
            refresh();
            const undo = undoChange(before, change);
            toast(markToast(runId, m, change.add.includes(m)), 'notice', {
              label: 'Undo',
              returnTo,
              run: () =>
                guard(() =>
                  void client.labels(runId, undo.add, undo.remove).then(
                    (u) => {
                      onLabels(runId, u.labels);
                      refresh();
                      toast(`${shortId(runId)}: put back as it was`);
                    },
                    (err: unknown) => toast(errorText(err), 'error'),
                  ),
                ),
            });
          },
          (err: unknown) => {
            onLabels(runId, before);
            toast(errorText(err), 'error');
          },
        );
      }),
    [client, toast, guard, refresh, onLabels],
  );
}

/**
 * A run's labels as the page shows them: the server's, or those a change made here gave it until the
 * server's say the same (or say otherwise, changed elsewhere since).
 */
export function useRunLabels(runId: string, server: readonly string[] | undefined): [string[], (labels: string[]) => void] {
  const base = JSON.stringify(server ?? []);
  const [mine, setMine] = useState<{ runId: string; base: string; labels: string[] } | null>(null);
  const labels = mine && mine.runId === runId && mine.base === base ? mine.labels : [...(server ?? [])];
  const set = useCallback((next: string[]) => setMine({ runId, base, labels: next }), [runId, base]);
  return [labels, set];
}
