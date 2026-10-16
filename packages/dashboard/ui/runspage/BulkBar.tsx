import { useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { DatasetDialog } from '../components/DatasetDialog.js';
import { CmdLine, CopyButton } from '../components/bits.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { num, plural, shortId } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { isLive } from '../runs.js';
import { useApp } from '../state.js';
import type { JobView } from '../types.js';
import { bulkToast, datasetOff, inBatches, joinDeleted, joinLabelled, named, rmCommand } from './bulk.js';

/**
 * The bar over the Runs table once runs are picked: Label, Push (with a team store), Pack, Dataset,
 * Compare (exactly two) and Delete, then Clear. Label and Delete act on every run picked by its full
 * id, a thousand to a request; Pack (one run after another) and Dataset (at most 500 runs) start the
 * run page's export jobs, Push the team store's.
 */

/** What the bar needs of a run picked: it may no longer be on the page shown. */
export interface PickedRun {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'crashed';
  startedAt: number;
  /** Only on this machine (a team store is set and its index doesn't list it). */
  local?: boolean;
}

type Open = 'label' | 'delete' | 'dataset' | null;

export function BulkBar({ runs, store, clear, onDone }: { runs: readonly PickedRun[]; store: boolean; clear: () => void; onDone: () => void }) {
  const { actionsOff, client, toast, guard, hasKind, watchJob } = useApp();
  const [open, setOpen] = useState<Open>(null);
  const ids = runs.map((r) => r.runId);
  const live = runs.filter(isLive);
  // Pack, Dataset and Delete take ended runs: a run still recording would be copied part way
  // through, and is left alone by a delete.
  const ended = runs.filter((r) => !isLive(r));
  const off = actionsOff ?? undefined;
  // The bar picks up to 1,000 runs; one dataset takes fewer.
  const tooMany = datasetOff(ended.length);

  // Each run into share/<id>, one after another: pack takes one run, and a dashboard runs at most
  // 16 jobs at once.
  const pack = async () => {
    if (!ended.length) return toast('A run that is still recording can’t be packed until it ends.');
    for (const r of ended) {
      let job: JobView;
      try {
        job = await client.startJob(JOB_KINDS.pack, { runId: r.runId, dir: `share/${shortId(r.runId).toLowerCase()}` });
      } catch (err) {
        return toast(err instanceof Error ? err.message : String(err));
      }
      watchJob(Promise.resolve(job));
      for (let v = job; !v.done; ) {
        await new Promise((ok) => setTimeout(ok, 400));
        try {
          v = await client.job(job.id, v.total);
        } catch {
          return;
        }
      }
    }
  };

  // A run still recording goes too: the CLI queues it, and pushes it when it ends.
  const push = () => {
    const up = runs.filter((r) => isLive(r) || r.local !== false);
    if (!up.length) return toast('Already in the store.');
    watchJob(client.startJob(JOB_KINDS.push, { runIds: up.map((r) => r.runId) }));
  };

  return (
    <>
      <div className="bulkbar" role="toolbar" aria-label="Selected runs">
        <b>{num(runs.length)} selected</b>
        <span className="sep" />
        <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => setOpen('label'))}>
          <Icon name="plus" />
          Label
        </button>
        {store && hasKind(JOB_KINDS.push) ? (
          <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(push)}>
            Push
          </button>
        ) : null}
        {hasKind(JOB_KINDS.pack) ? (
          <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => void pack())}>
            Pack
          </button>
        ) : null}
        {hasKind(JOB_KINDS.dataset) ? (
          <button className="btn sm" type="button" disabled={!!actionsOff || !!tooMany} title={off ?? tooMany ?? undefined} onClick={() => guard(() => (ended.length ? setOpen('dataset') : toast('A run that is still recording can’t be exported until it ends.')))}>
            Dataset
          </button>
        ) : null}
        <button
          className="btn sm"
          type="button"
          disabled={runs.length !== 2}
          title={runs.length === 2 ? undefined : 'Pick exactly two runs'}
          onClick={() => {
            const [a, b] = [...runs].sort((x, y) => x.startedAt - y.startedAt);
            if (!a || !b) return;
            clear();
            navigate(href.compare(a.runId, b.runId));
          }}
        >
          Compare
        </button>
        <button className="btn sm quiet dz" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => (ended.length ? setOpen('delete') : toast('A run that is still recording can’t be deleted.')))}>
          Delete
        </button>
        <button className="linkbtn" type="button" onClick={clear}>
          Clear
        </button>
      </div>
      {open === 'label' ? (
        <PromptDialog
          title={`Label ${named(ids)}`}
          text="A label says what a run is, so it can be found and exported as part of a dataset (export dataset --label)."
          label="Label"
          placeholder="good"
          maxLength={40}
          ok="Add label"
          onClose={() => setOpen(null)}
          onRun={(label) => {
            setOpen(null);
            inBatches(ids, (part) => client.labelRuns(part, [label])).then(joinLabelled).then(
              (out) => {
                toast(bulkToast({ verb: 'Labelled', done: out.done.map((d) => d.runId), of: ids.length, skipped: out.skipped, suffix: ` “${label}”` }));
                onDone();
              },
              (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
            );
          }}
        />
      ) : null}
      {open === 'delete' ? (
        <Dialog
          title={`Delete ${named(ended.map((r) => r.runId))}?`}
          text={`Removes the runs and the recorded data nothing else uses. Their forks keep their own data but lose the link.${live.length ? ` ${live.map((r) => shortId(r.runId)).join(', ')} ${live.length === 1 ? 'is' : 'are'} still recording and ${live.length === 1 ? 'is' : 'are'} left alone.` : ''}`}
          ok={`Delete ${ended.length === 1 ? 'run' : plural(ended.length, 'run')}`}
          tone="danger"
          onClose={() => setOpen(null)}
          onOk={() => {
            setOpen(null);
            const doomed = ended.map((r) => r.runId);
            inBatches(doomed, (part) => client.deleteRuns(part)).then(joinDeleted).then(
              (out) => {
                toast(bulkToast({ verb: 'Deleted', done: out.done, of: doomed.length, skipped: out.skipped }));
                clear();
                onDone();
              },
              (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
            );
          }}
        >
          <DeleteCommand ids={ended.map((r) => r.runId)} />
        </Dialog>
      ) : null}
      {open === 'dataset' ? <DatasetDialog ids={ended.map((r) => r.runId)} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** The command a bulk Delete runs: every id for a few runs, the first few and how many more for a long pick, whole behind Copy. */
function DeleteCommand({ ids }: { ids: readonly string[] }) {
  const rm = rmCommand(ids);
  return (
    <>
      <CmdLine>{rm.shown}</CmdLine>
      {rm.shown !== rm.full ? (
        <div className="cmdcopy">
          <CopyButton text={rm.full} label="the command">
            Copy the whole command
          </CopyButton>
        </div>
      ) : null}
    </>
  );
}
