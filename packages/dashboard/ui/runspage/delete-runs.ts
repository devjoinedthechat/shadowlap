import type { Client } from '../api.js';
import { begin, cancel, sendNow, type PendingRun } from '../pending-delete.js';
import { useApp } from '../state.js';
import { errorText, type ToastAction } from '../toast.js';
import type { DeleteResult } from '../types.js';
import { BULK_BATCH, bulkToast, inBatches, joinDeleted, named } from './bulk.js';

/**
 * The bulk bar's Delete, once its dialog is confirmed: the runs leave the lists `pending-delete.ts`
 * names at once and the toast says so, with Undo (⌘Z). The delete goes to the server when the toast
 * goes, however it goes (its time out, a newer toast), or before, as the page or the project
 * changes, the toast then saying the same with no Undo; Undo before then puts the runs back on the
 * lists, as nothing was deleted. Sent, a second toast says only what differs from the first: runs
 * left alone, or a failure, and the runs come back.
 */

/** The browser lets keepalive requests carry 64 KiB between them while in flight: room for two batches of a thousand ids. */
export const KEEPALIVE_BYTES = 60_000;
let keepaliveInFlight = 0;

/**
 * A delete as the bar sends it: a batch at a time; or, as the page goes, every batch at once, those
 * that fit the browser's keepalive room with keepalive, the rest as plain requests, which a page that
 * goes cancels, their runs left in the store. What failed fails alone: the answers that came are kept.
 */
export async function sendDelete(client: Pick<Client, 'deleteRuns'>, ids: readonly string[], keepalive: boolean): Promise<{ out: DeleteResult; failed: unknown }> {
  if (!keepalive) {
    try {
      return { out: joinDeleted(await inBatches(ids, (part) => client.deleteRuns(part))), failed: null };
    } catch (err) {
      return { out: joinDeleted([]), failed: err };
    }
  }
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += BULK_BATCH) parts.push(ids.slice(i, i + BULK_BATCH));
  const answers = await Promise.allSettled(
    parts.map(async (part) => {
      const bytes = JSON.stringify({ ids: part }).length;
      const keep = keepaliveInFlight + bytes <= KEEPALIVE_BYTES;
      if (keep) keepaliveInFlight += bytes;
      try {
        return await client.deleteRuns(part, keep ? { keepalive: true } : undefined);
      } finally {
        if (keep) keepaliveInFlight -= bytes;
      }
    }),
  );
  const came = answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : []));
  const failed: unknown = answers.find((a): a is PromiseRejectedResult => a.status === 'rejected')?.reason ?? null;
  return { out: joinDeleted(came), failed };
}

/** Starts the bulk bar's Delete for the ended runs picked: `from`, the control the focus goes back to after Undo. */
export function useDeleteRuns(): (runs: readonly PendingRun[], from?: HTMLElement | null) => void {
  const { client, toast, refresh } = useApp();
  return (runs, from) => {
    const ids = runs.map((r) => r.runId);
    const said = bulkToast({ verb: 'Deleted', done: ids, of: ids.length, skipped: [], attempts: runs.reduce((n, r) => n + r.attempts, 0) });
    let toastGone = false;
    const send = async (keepalive: boolean) => {
      // Sent before its toast goes, as the project or the page changes, the toast says the same with no Undo: nothing
      // waits to undo, here or on a page the browser brings back from its cache.
      if (!toastGone) toast(said);
      const { out, failed } = await sendDelete(client, ids, keepalive);
      if (failed) toast(errorText(failed), 'error');
      else if (out.skipped.length || out.done.length < ids.length) toast(bulkToast({ verb: 'Deleted', done: out.done, of: ids.length, skipped: out.skipped, attempts: out.attempts.length }));
      refresh();
      return out.done;
    };
    const batch = begin(runs, send);
    const go = () => void sendNow(batch);
    const undo: ToastAction = {
      label: 'Undo',
      undo: true,
      returnTo: from ?? null,
      run: () => {
        if (cancel(batch)) toast(`Restored ${named(ids)}`);
      },
      // Pressed, by its button or its key, the toast goes before Undo's own work is done: by the next tick Undo has taken the runs back.
      onGone: (acted) => {
        toastGone = true;
        if (acted) queueMicrotask(go);
        else go();
      },
    };
    toast(said, 'notice', undo);
  };
}
