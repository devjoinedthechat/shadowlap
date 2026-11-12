import { useEffect, useRef, useState, type RefObject } from 'react';
import { useRetoast } from '../toast-place.js';
import { errorText } from '../toast.js';
import { letGoAfterPush, pushable, untilDone } from './push.js';
import { JOB_KINDS } from '../api.js';
import { DatasetDialog } from '../components/DatasetDialog.js';
import { Dialog, PromptDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { Id, namedIn } from '../components/Id.js';
import { num, plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { BULK, confirmWords } from '../labels.js';
import type { PendingRun } from '../pending-delete.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { defaultPackFolder } from '../run/share.js';
import { PACK_HOLDS, packRunCommand, redactsFact } from '../run/share-steps.js';
import { isLive } from '../runs.js';
import { guardedWayOn, useApp } from '../state.js';
import type { JobView } from '../types.js';
import { bulkToast, datasetOff, deleteFacts, deleteLead, inBatches, joinLabelled, labelCommands, labelSuggestions, named, packCommand, packOff, rmCommand } from './bulk.js';
import { useDeleteRuns } from './delete-runs.js';
import { PreviewChange } from './PreviewChange.js';
import { ActionButton } from '../components/ActionButton.js';

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
  const { client, toast, guard, hasKind, watchJob, runs: inMemory, exported } = useApp();
  const bar = useBulkHeight();
  useRetoast(bar);
  const startDelete = useDeleteRuns();
  const [open, setOpen] = useState<Open>(null);
  const ids = runs.map((r) => r.runId);
  const live = runs.filter(isLive);
  // Pack, Dataset and Delete take ended runs: a run still recording would be copied part way
  // through, and is left alone by a delete.
  const ended = runs.filter((r) => !isLive(r));
  const endedIds = ended.map((r) => r.runId);
  const attempts = ended.reduce((n, r) => n + (r.attempts ?? 0), 0);
  const rm = rmCommand(endedIds);
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
        <ActionButton className="btn sm" onClick={() => guard(() => setOpen('label'))}>
          <Icon name="plus" />
          {BULK.label}
        </ActionButton>
        {store && hasKind(JOB_KINDS.push) ? (
          <ActionButton className="btn sm" onClick={() => guard(() => void push())}>
            Push
          </ActionButton>
        ) : null}
        {hasKind(JOB_KINDS.pack) ? (
          <ActionButton className="btn sm" tip="Pack" why={waits ?? packOff(ended.length)} whyTip={waitsTip} onClick={() => guard(() => setOpen('pack'))}>
            Pack
          </ActionButton>
        ) : null}
        {hasKind(JOB_KINDS.dataset) ? (
          <ActionButton className="btn sm" tip={confirmWords(BULK.dataset)} why={waits ?? datasetOff(ended.length)} whyTip={waitsTip} onClick={() => guard(() => setOpen('dataset'))}>
            {BULK.dataset}
          </ActionButton>
        ) : null}
        {!exported && hasKind(JOB_KINDS.decisions) ? <PreviewChange picked={runs.map((r) => r.runId)} ended={endedIds} /> : null}
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
        <ActionButton className="btn sm quiet dz" onClick={() => guard(() => (ended.length ? setOpen('delete') : toast('A run that is still recording can’t be deleted.')))}>
          {BULK.delete(runs.length)}
        </ActionButton>
        <button className="linkbtn" type="button" onClick={clear}>
          {BULK.clear}
        </button>
      </div>
      {open === 'label' ? (
        <PromptDialog
          title={`Add label to ${plural(ids.length, 'run')}`}
          lead={ids.length === 1 ? 'Labels the run, so it can be found and exported with export dataset --label.' : 'Labels the runs, so they can be found and exported with export dataset --label.'}
          doc="labels"
          label="Label"
          placeholder="good"
          maxLength={40}
          suggestions={labelSuggestions(inMemory)}
          ok="Add label"
          command={(label) => {
            const c = labelCommands(ids, label);
            // A Copy named by what it holds, and the whole list wherever the box shows only its first few.
            return { command: c.shown, ...(ids.length > 1 ? { what: 'the commands' } : {}), ...(c.full !== c.shown.join('\n') ? { full: c.full } : {}) };
          }}
          onClose={() => setOpen(null)}
          onRun={(label) =>
            guardedWayOn(guard, () =>
              inBatches(ids, (part) => client.labelRuns(part, [label]))
                .then(joinLabelled)
                .then(
                  (out) => {
                    toast(bulkToast({ verb: 'Labelled', done: out.done.map((d) => d.runId), of: ids.length, skipped: out.skipped, suffix: ` “${label}”` }));
                    onDone();
                    return true;
                  },
                  (err: unknown) => {
                    toast(errorText(err), 'error');
                    return false;
                  },
                ),
            )
          }
        />
      ) : null}
      {open === 'delete' ? (
        <Dialog
          title={endedIds.length === 1 ? <>Delete <Id id={shortId(endedIds[0]!)} />?</> : `Delete ${plural(endedIds.length, 'run')}?`}
          lead={deleteLead(endedIds.length, attempts)}
          doc="deletingRuns"
          facts={deleteFacts(endedIds.length, live.map((r) => r.runId))}
          command={{ command: rm.shown, ...(rm.shown !== rm.full ? { full: rm.full } : {}) }}
          ok={`Delete ${ended.length === 1 ? 'run' : plural(ended.length, 'run')}`}
          tone="danger"
          onClose={() => setOpen(null)}
          onOk={() => {
            startDelete(ended.map(pendingOf));
            clear();
          }}
        />
      ) : null}
      {open === 'pack' ? <PackDialog ids={endedIds} onClose={() => setOpen(null)} onRun={(fields) => guard(() => watchJob(client.startJob(JOB_KINDS.pack, fields)))} /> : null}
      {open === 'dataset' ? <BulkDataset ids={endedIds} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/**
 * Pack, asked first as the run page asks it: one run goes into the folder typed, `.shadowlap/exports/
 * <id>` unless another is given; several go into a folder each, named by its id, inside the folder
 * typed (`.shadowlap/exports` unless another is given). One job packs them all, one after another,
 * and its drawer lists every folder it wrote.
 */
export function PackDialog({ ids, onClose, onRun }: { ids: readonly string[]; onClose: () => void; onRun: (fields: Record<string, unknown>) => boolean }) {
  const { client } = useApp();
  const one = ids.length === 1 ? ids[0]! : null;
  // The project's rules, as a copy made now applies them: the server says per copy, of any run.
  const offers = useLoad(() => client.offers(ids[0]!), `bulk-pack-rules:${ids[0]!}`);
  const rules = offers.data?.copies.formats.find((f) => f.id === 'pack')?.rules ?? null;
  return (
    <PromptDialog
      title={one ? namedIn(`Pack ${named(ids)}`, shortId(one)) : `Pack ${named(ids)}`}
      lead={one ? 'Packs the run into a folder to commit as a golden or send to someone.' : 'Packs each run into a folder of its own, to commit as goldens or send to someone.'}
      doc="packs"
      facts={[PACK_HOLDS, redactsFact(rules)]}
      label={one ? 'Folder, inside the project' : 'Folder for the packs, inside the project'}
      initial={one ? defaultPackFolder(one) : '.shadowlap/exports'}
      ok={one ? 'Pack run' : `Pack ${plural(ids.length, 'run')}`}
      command={(dir) => {
        if (one) return packRunCommand(one, dir);
        const cmd = packCommand(ids, dir);
        return { command: cmd.shown, what: 'the commands', ...(cmd.full !== cmd.shown ? { full: cmd.full } : {}) };
      }}
      onClose={onClose}
      onRun={(dir) => onRun(one ? { runId: one, dir } : { runIds: [...ids], dir })}
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
