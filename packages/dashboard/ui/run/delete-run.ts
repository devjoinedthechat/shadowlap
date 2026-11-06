import type { RunDetail, RunOffers } from '../api.js';
import { begin, cancel, sendNow, type PendingRun } from '../pending-delete.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { isFailed, runType } from '../runs.js';
import { bulkToast, named } from '../runspage/bulk.js';
import { useApp } from '../state.js';
import { errorText, type ToastAction } from '../toast.js';
import { runLikeOf } from './model.js';

/** The run as a delete waits to take it: the chips Runs counts it under (its kind, failed, local) and its attempts. */
export function pendingRunOf(run: RunDetail, offers: RunOffers | null): PendingRun {
  const like = runLikeOf(run);
  const chips = [runType(like), ...(isFailed(like) ? ['failed'] : []), ...(offers?.team?.state === 'only-here' ? ['local'] : [])];
  return { runId: run.run.runId, chips, attempts: run.attempts ?? 0, startedAt: run.run.startedAt };
}

/**
 * A run page's Delete, once its dialog is confirmed, as Runs' bulk Delete: the run leaves the lists
 * at once (`pending-delete.ts`), the page goes to Runs, and the toast says so, with Undo (⌘Z). The
 * delete goes to the server when the toast goes, however it goes (its time out, its ×, a newer toast),
 * or before, as the page or the project changes, the toast then saying the same with no Undo; as the
 * page goes, it is sent with keepalive, so the browser sees it out. Undo
 * before then puts the run back, as nothing was deleted. A delete the server refuses says why, and
 * the run comes back.
 */
export function useDeleteRun(): (run: PendingRun, from?: HTMLElement | null) => void {
  const { client, toast, refresh } = useApp();
  return (run, from) => {
    const ids = [run.runId];
    const said = bulkToast({ verb: 'Deleted', done: ids, of: 1, skipped: [], attempts: run.attempts });
    let toastGone = false;
    const send = async (keepalive: boolean): Promise<readonly string[] | null> => {
      if (!toastGone) toast(said);
      try {
        const out = await client.remove(run.runId, keepalive ? { keepalive } : undefined);
        return [out.deleted, ...(out.attempts ?? [])];
      } catch (err) {
        toast(errorText(err), 'error');
        return null;
      } finally {
        refresh();
      }
    };
    const batch = begin([run], send);
    const go = () => void sendNow(batch);
    const undo: ToastAction = {
      label: 'Undo',
      undo: true,
      returnTo: from ?? null,
      run: () => {
        if (cancel(batch)) toast(`Restored ${named(ids)}`);
      },
      // Pressed, by its button or its key, the toast goes before Undo's own work is done: by the next tick Undo has taken the run back.
      onGone: (acted) => {
        toastGone = true;
        if (acted) queueMicrotask(go);
        else go();
      },
    };
    navigate(href.runs());
    toast(said, 'notice', undo);
  };
}
