import { useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { ConfirmDialog, Dialog, PromptDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { num, plural, shortId } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { isLive } from '../runs.js';
import { useApp } from '../state.js';
import type { BulkSkip } from '../types.js';

/**
 * The bar over the Runs table once runs are picked: Label, Push (with a team store), Pack, Dataset,
 * Compare (exactly two) and Delete, then Clear. Label and Delete act on every run picked at once,
 * by its full id; Pack and Dataset start the run page's export jobs, Push the team store's.
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

const named = (ids: readonly string[]) => (ids.length === 1 ? shortId(ids[0]!) : `${num(ids.length)} runs`);

/** "Deleted 3 runs", "Labelled 2 of 3 runs “good” · 01K5CQ6L0P was left alone: no such run". */
export function bulkToast(o: { verb: string; done: readonly string[]; of: number; skipped: readonly BulkSkip[]; suffix?: string }): string {
  const what = o.done.length === o.of ? named(o.done) : `${num(o.done.length)} of ${num(o.of)} runs`;
  const why = o.skipped.slice(0, 2).map((s) => `${shortId(s.runId)} ${s.reason === 'still recording' ? 'is still recording' : `was left alone: ${s.reason}`}`);
  return [`${o.verb} ${what}${o.suffix ?? ''}`, ...why].join(' · ');
}

export function BulkBar({ runs, store, clear, onDone }: { runs: readonly PickedRun[]; store: boolean; clear: () => void; onDone: () => void }) {
  const { actionsOff, client, toast, guard, hasKind, watchJob } = useApp();
  const [open, setOpen] = useState<Open>(null);
  const ids = runs.map((r) => r.runId);
  const live = runs.filter(isLive);
  const deletable = runs.filter((r) => !isLive(r));
  const off = actionsOff ?? undefined;

  const push = () => {
    const up = runs.filter((r) => !isLive(r) && r.local !== false);
    if (!up.length) return toast(live.length ? 'A run that is still recording is pushed when it ends.' : 'Already in the store.');
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
          <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => runs.forEach((r) => watchJob(client.startJob(JOB_KINDS.pack, { runId: r.runId, dir: `share/${shortId(r.runId).toLowerCase()}` }))))}>
            Pack
          </button>
        ) : null}
        {hasKind(JOB_KINDS.dataset) ? (
          <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => setOpen('dataset'))}>
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
        <button className="btn sm quiet dz" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => (deletable.length ? setOpen('delete') : toast('A run that is still recording can’t be deleted.')))}>
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
            client.labelRuns(ids, [label]).then(
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
        <ConfirmDialog
          title={`Delete ${named(deletable.map((r) => r.runId))}?`}
          text={`Removes the runs and the recorded data nothing else uses. Their forks keep their own data but lose the link.${live.length ? ` ${live.map((r) => shortId(r.runId)).join(', ')} ${live.length === 1 ? 'is' : 'are'} still recording and ${live.length === 1 ? 'is' : 'are'} left alone.` : ''}`}
          command={`shadowlap rm ${deletable.map((r) => shortId(r.runId)).join(' ')}`}
          ok={`Delete ${deletable.length === 1 ? 'run' : plural(deletable.length, 'run')}`}
          danger
          onClose={() => setOpen(null)}
          onOk={() => {
            setOpen(null);
            const doomed = deletable.map((r) => r.runId);
            client.deleteRuns(doomed).then(
              (out) => {
                toast(bulkToast({ verb: 'Deleted', done: out.done, of: doomed.length, skipped: out.skipped }));
                clear();
                onDone();
              },
              (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
            );
          }}
        />
      ) : null}
      {open === 'dataset' ? <DatasetDialog ids={ids} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** Runs as an eval dataset: the format and which calls become examples. */
export function DatasetDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { client, watchJob } = useApp();
  const [format, setFormat] = useState('jsonl');
  const [calls, setCalls] = useState('final');
  return (
    <Dialog
      title={`Export ${named(ids)} as an eval dataset`}
      text="One JSON line per example: the conversation exactly as the model saw it, its answer, and metadata with the labels, notes and check results."
      ok="Export"
      onClose={onClose}
      onOk={() => {
        onClose();
        watchJob(client.startJob(JOB_KINDS.dataset, { runIds: ids, format, calls }));
      }}
    >
      <div className="form">
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="jsonl">jsonl</option>
            <option value="braintrust">braintrust</option>
            <option value="langfuse">langfuse</option>
            <option value="openai-chat">openai-chat</option>
          </select>
        </label>
        <label>
          Examples
          <select value={calls} onChange={(e) => setCalls(e.target.value)}>
            <option value="final">Last model call of each run</option>
            <option value="model">Every model call</option>
          </select>
        </label>
      </div>
    </Dialog>
  );
}
