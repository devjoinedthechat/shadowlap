import { useState } from 'react';
import { errorText } from '../toast.js';
import { letGoAfterPush, pushable, untilDone } from './push.js';
import { JOB_KINDS } from '../api.js';
import { DatasetDialog } from '../components/DatasetDialog.js';
import { CmdLine, CopyButton } from '../components/bits.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { num, plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { jobCommand } from '../jobs.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { defaultPackFolder } from '../run/share.js';
import { isLive } from '../runs.js';
import { useApp } from '../state.js';
import type { JobView } from '../types.js';
import { bulkToast, datasetOff, deleteText, deleteWhat, inBatches, joinDeleted, joinLabelled, named, packCommand, packOff, rmCommand } from './bulk.js';

/**
 * The bar over the Runs table once runs are picked: Label, Push (with a team store), Pack, Dataset,
 * Compare (exactly two) and Delete, then Clear. Label and Delete act on every run picked by its full
 * id, a thousand to a request; Delete takes the attempts bundled under each run, as `shadowlap rm`
 * does, and says how many. Pack asks for a folder first, as the run page's does, then packs every run
 * in one job, a folder each; Dataset (at most 500 runs) starts the run page's export job, and Push
 * the team store's.
 */

/** What the bar needs of a run picked: it may no longer be on the page shown. */
export interface PickedRun {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'crashed';
  startedAt: number;
  /** Only on this machine (a team store is set and its index doesn't list it). */
  local?: boolean;
  /** Attempts bundled under it, which a delete takes with it, as the table counted them. */
  attempts?: number;
}

type Open = 'label' | 'delete' | 'pack' | 'dataset' | null;

export function BulkBar({ runs, store, clear, onDone }: { runs: readonly PickedRun[]; store: boolean; clear: () => void; onDone: () => void }) {
  const { actionsOff, client, toast, guard, hasKind, watchJob } = useApp();
  const [open, setOpen] = useState<Open>(null);
  const ids = runs.map((r) => r.runId);
  const live = runs.filter(isLive);
  // Pack, Dataset and Delete take ended runs: a run still recording would be copied part way
  // through, and is left alone by a delete.
  const ended = runs.filter((r) => !isLive(r));
  const endedIds = ended.map((r) => r.runId);
  const attempts = ended.reduce((n, r) => n + (r.attempts ?? 0), 0);
  const off = actionsOff ?? undefined;
  // The bar picks up to 1,000 runs; one dataset, and one pack job, take fewer.
  const tooMany = datasetOff(ended.length);
  const tooManyPacks = packOff(ended.length);

  // A run still recording goes too: the CLI queues it, and pushes it when it ends. Once the push has
  // worked the selection is let go, as the runs it picked are in the store (push.ts).
  const push = async () => {
    const up = pushable(runs);
    if (!up.length) return toast('Already in the store.');
    let job: JobView;
    try {
      job = await client.startJob(JOB_KINDS.push, { runIds: up });
    } catch (err) {
      return toast(errorText(err), 'error');
    }
    watchJob(Promise.resolve(job));
    if (letGoAfterPush(await untilDone(job, (id, since) => client.job(id, since)))) clear();
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
          <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => void push())}>
            Push
          </button>
        ) : null}
        {hasKind(JOB_KINDS.pack) ? (
          <button className="btn sm" type="button" disabled={!!actionsOff || !!tooManyPacks} title={off ?? tooManyPacks ?? undefined} onClick={() => guard(() => (ended.length ? setOpen('pack') : toast('A run that is still recording can’t be packed until it ends.')))}>
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
              (err: unknown) => toast(errorText(err), 'error'),
            );
          }}
        />
      ) : null}
      {open === 'delete' ? (
        <Dialog
          title={`Delete ${deleteWhat(endedIds, attempts)}?`}
          text={deleteText(endedIds.length, attempts, live.map((r) => r.runId))}
          ok={`Delete ${ended.length === 1 ? 'run' : plural(ended.length, 'run')}`}
          tone="danger"
          onClose={() => setOpen(null)}
          onOk={() => {
            setOpen(null);
            inBatches(endedIds, (part) => client.deleteRuns(part)).then(joinDeleted).then(
              (out) => {
                toast(bulkToast({ verb: 'Deleted', done: out.done, of: endedIds.length, skipped: out.skipped, attempts: out.attempts.length }));
                clear();
                onDone();
              },
              (err: unknown) => toast(errorText(err), 'error'),
            );
          }}
        >
          <DeleteCommand ids={endedIds} />
        </Dialog>
      ) : null}
      {open === 'pack' ? <PackDialog ids={endedIds} onClose={() => setOpen(null)} onRun={(fields) => guard(() => watchJob(client.startJob(JOB_KINDS.pack, fields)))} /> : null}
      {open === 'dataset' ? <BulkDataset ids={endedIds} onClose={() => setOpen(null)} /> : null}
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

/**
 * Pack, asked first as the run page asks it: one run goes into the folder typed, `.shadowlap/exports/
 * <id>` unless another is given; several go into a folder each, named by its id, inside the folder
 * typed (`.shadowlap/exports` unless another is given). One job packs them all, one after another,
 * and its drawer lists every folder it wrote.
 */
function PackDialog({ ids, onClose, onRun }: { ids: readonly string[]; onClose: () => void; onRun: (fields: Record<string, unknown>) => void }) {
  const one = ids.length === 1 ? ids[0]! : null;
  return (
    <PromptDialog
      title={`Pack ${named(ids)}`}
      text={
        one
          ? 'A folder to commit as a golden or send to someone: run.json, calls.jsonl and one file per blob. Redaction rules apply to the copy; the store is never changed.'
          : 'A folder for each run, named by its id, inside the folder below: run.json, calls.jsonl and one file per blob, to commit as goldens or send to someone. Redaction rules apply to the copies; the store is never changed.'
      }
      label={one ? 'Folder, inside the project' : 'Folder for the packs, inside the project'}
      initial={one ? defaultPackFolder(one) : '.shadowlap/exports'}
      ok={one ? 'Pack' : `Pack ${plural(ids.length, 'run')}`}
      command={(dir) => (one ? jobCommand(['pack', shortId(one), dir]) : packCommand(ids, dir).shown)}
      after={(dir) => {
        const cmd = one ? null : packCommand(ids, dir);
        return cmd && cmd.full !== cmd.shown ? (
          <div className="cmdcopy">
            <CopyButton text={cmd.full} label="the commands">
              Copy every command
            </CopyButton>
          </div>
        ) : null;
      }}
      onClose={onClose}
      onRun={(dir) => {
        onClose();
        onRun(one ? { runId: one, dir } : { runIds: [...ids], dir });
      }}
    />
  );
}

/** Dataset for the runs picked, saying how many redaction rules its copy applies, as the run page's Share says it. */
function BulkDataset({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { client } = useApp();
  // The project's rules, as a copy made now applies them: the server says per copy, of any run.
  const offers = useLoad(() => client.offers(ids[0]!), `bulk-dataset-rules:${ids[0]}`);
  const rules = offers.data?.copies.formats.find((f) => f.id === 'dataset')?.rules ?? null;
  return <DatasetDialog ids={ids} rules={rules} onClose={onClose} />;
}
