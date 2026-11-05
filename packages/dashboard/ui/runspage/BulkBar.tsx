import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { errorText } from '../toast.js';
import { letGoAfterPush, pushable, untilDone } from './push.js';
import { JOB_KINDS } from '../api.js';
import { DatasetDialog } from '../components/DatasetDialog.js';
import { CmdLine, CopyButton } from '../components/bits.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { num, plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { jobCommand } from '../jobs.js';
import { BULK, confirmWords } from '../labels.js';
import type { PendingRun } from '../pending-delete.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { defaultPackFolder } from '../run/share.js';
import { isLive } from '../runs.js';
import { useApp } from '../state.js';
import type { JobView } from '../types.js';
import { bulkToast, datasetOff, labelSuggestions, deleteText, deleteWhat, inBatches, joinLabelled, named, packCommand, packOff, rmCommand } from './bulk.js';
import { useDeleteRuns } from './delete-runs.js';

/**
 * The bar over the Runs table once runs are picked: Add label…, Push (with a team store), Pack,
 * Export dataset…, Compare (exactly two) and Delete, then Clear selection. Label and Delete act on
 * every run picked by its full id, a thousand to a request; Delete takes the attempts bundled under
 * each run, as `shadowlap rm` does, and says how many, with Undo while its toast shows
 * (`delete-runs.ts`). Pack asks for a folder first, as the run page's does, then packs every run in
 * one job, a folder each; Export dataset… (at most 500 runs) starts the run page's export job, and
 * Push the team store's. Pack and Export dataset… wait while every run picked is still recording.
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
  /** The chips it counts under, `all` aside: what it takes from their counts while its delete waits. */
  chips?: readonly string[];
}

/** What a run picked takes from the lists and their counts while its delete waits. */
const pendingOf = (r: PickedRun): PendingRun => ({ runId: r.runId, chips: r.chips ?? [], attempts: r.attempts ?? 0, startedAt: r.startedAt });

/**
 * One of the bar's buttons: off on a dashboard that changes nothing, saying why on hover. While
 * `why` holds (every run picked still recording, too many for one job) it waits: `aria-disabled`,
 * its card saying why in full (`whyTip`), and a press says why.
 */
function BulkButton({ why = null, whyTip, tip, className = 'btn sm', onClick, children }: { why?: string | null; whyTip?: string | undefined; tip: string; className?: string; onClick: () => void; children: ReactNode }) {
  const { actionsOff, toast } = useApp();
  if (why && !actionsOff)
    return (
      <button className={className} type="button" aria-disabled="true" data-why={why} data-tip={tipCard(tip, [], whyTip ?? why)} onClick={() => toast(why)}>
        {children}
      </button>
    );
  return (
    <button className={className} type="button" disabled={!!actionsOff} title={actionsOff ?? undefined} onClick={onClick}>
      {children}
    </button>
  );
}

type Open = 'label' | 'delete' | 'pack' | 'dataset' | null;

/** The bar's height on the root, for as long as it shows: the window keeps a row in focus clear of it however many lines it wraps to. */
function useBulkHeight(): RefObject<HTMLDivElement | null> {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const root = document.documentElement;
    const sized = new ResizeObserver(() => root.style.setProperty('--bulk-h', `${el.offsetHeight}px`));
    sized.observe(el);
    return () => {
      sized.disconnect();
      root.style.removeProperty('--bulk-h');
    };
  }, []);
  return bar;
}

export function BulkBar({ runs, store, clear, onDone }: { runs: readonly PickedRun[]; store: boolean; clear: () => void; onDone: () => void }) {
  const { client, toast, guard, hasKind, watchJob, runs: inMemory } = useApp();
  const bar = useBulkHeight();
  const startDelete = useDeleteRuns();
  const [open, setOpen] = useState<Open>(null);
  const ids = runs.map((r) => r.runId);
  const live = runs.filter(isLive);
  // Pack, Dataset and Delete take ended runs: a run still recording would be copied part way
  // through, and is left alone by a delete.
  const ended = runs.filter((r) => !isLive(r));
  const endedIds = ended.map((r) => r.runId);
  const attempts = ended.reduce((n, r) => n + (r.attempts ?? 0), 0);
  // The bar picks up to 1,000 runs; one dataset, and one pack job, take fewer. A copy of runs still recording would be cut off.
  const waits = ended.length ? null : BULK.waits(runs.length);
  const waitsTip = waits ? BULK.waitsTip(runs.length) : undefined;

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
      <div className="bulkbar" role="toolbar" aria-label="Selected runs" ref={bar}>
        <b>{num(runs.length)} selected</b>
        <span className="sep" />
        <BulkButton tip={BULK.label} onClick={() => guard(() => setOpen('label'))}>
          <Icon name="plus" />
          {BULK.label}
        </BulkButton>
        {store && hasKind(JOB_KINDS.push) ? (
          <BulkButton tip="Push" onClick={() => guard(() => void push())}>
            Push
          </BulkButton>
        ) : null}
        {hasKind(JOB_KINDS.pack) ? (
          <BulkButton tip="Pack" why={waits ?? packOff(ended.length)} whyTip={waitsTip} onClick={() => guard(() => setOpen('pack'))}>
            Pack
          </BulkButton>
        ) : null}
        {hasKind(JOB_KINDS.dataset) ? (
          <BulkButton tip={confirmWords(BULK.dataset)} why={waits ?? datasetOff(ended.length)} whyTip={waitsTip} onClick={() => guard(() => setOpen('dataset'))}>
            {BULK.dataset}
          </BulkButton>
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
        <BulkButton className="btn sm quiet dz" tip={BULK.delete(runs.length)} onClick={() => guard(() => (ended.length ? setOpen('delete') : toast('A run that is still recording can’t be deleted.')))}>
          {BULK.delete(runs.length)}
        </BulkButton>
        <button className="linkbtn" type="button" onClick={clear}>
          {BULK.clear}
        </button>
      </div>
      {open === 'label' ? (
        <PromptDialog
          title={`Label ${named(ids)}`}
          text="A label says what a run is, so it can be found and exported as part of a dataset (export dataset --label)."
          label="Label"
          placeholder="good"
          maxLength={40}
          suggestions={labelSuggestions(inMemory)}
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
            startDelete(ended.map(pendingOf));
            clear();
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
  const offers = useLoad(() => client.offers(ids[0]!), `bulk-dataset-rules:${ids[0]!}`);
  const rules = offers.data?.copies.formats.find((f) => f.id === 'dataset')?.rules ?? null;
  return <DatasetDialog ids={ids} rules={rules} onClose={onClose} />;
}
