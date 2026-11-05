import { useRef, useState, type DragEvent, type RefObject } from 'react';
import { JOB_KINDS } from '../api.js';
import { Seg } from '../components/bits.js';
import { DialogFacts, type DialogFactRows } from '../components/DialogFacts.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { FILE_FORMATS, fileHead, importWords, HEAD_BYTES, IMPORT_ACCEPT, IMPORT_FILE_FORMATS, OTEL_SAMPLE_NAME, phoenixProjectNote, phoenixProjectOk, pickedFormat, sampleTrace, TRACE_COPY, traceIdOk, type ImportFileFormat, type TraceSource } from './imports.js';
import { ACTIONS, confirmWords } from '../labels.js';

/**
 * Import a capture or a trace: a file (dropped or picked; its format guessed from its name and its
 * first bytes, and changeable; YAML refused with the reason; or the sample trace the dashboard
 * ships), or a trace by its host and id from Langfuse, LangSmith, Phoenix (in a project) or Logfire,
 * read with the keys already on this machine. The file goes up first (`POST /api/uploads`), then
 * the import job runs the CLI; the drawer ends with a link to each run it made.
 */

type Source = 'file' | TraceSource;

interface Picked {
  file: File;
  format: ImportFileFormat | null;
  error: string | null;
}

/** The sample, picked as a file would be, so it goes up and is imported the same way. */
function pickedSample(limit: number | null): Picked {
  const sample = sampleTrace();
  const file = new File([sample.text], sample.name, { type: 'application/json' });
  return { file, ...pickedFormat(file.name, file.size, sample.text.slice(0, HEAD_BYTES), limit) };
}

/** A file that closing would lose: dropped, or the sample, it fired no field's change. A refused one holds nothing to keep. */
const holdsFile = (picked: Picked | null): boolean => !!picked && !picked.error;

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { client, watchJob, toast, meta } = useApp();
  const [source, setSource] = useState<Source>('file');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<{ host: string | null; id: string; project: string | null }>({ host: null, id: '', project: null });
  const input = useRef<HTMLInputElement>(null);
  const sources = useLoad(() => client.importSources(), 'import-sources');
  const limit = sources.data?.uploadLimit ?? meta?.uploadLimit ?? null;

  // The newest file picked: reading another's first bytes may end after it, and must not replace it.
  const picking = useRef(0);
  const pick = (file: File | undefined) => {
    if (!file) return;
    const n = ++picking.current;
    // Its first bytes tell a HAR saved as .json from a nock recording, and OTLP lines from LiteLLM's.
    void fileHead(file).then((head) => {
      if (n === picking.current) setPicked({ file, ...pickedFormat(file.name, file.size, head, limit) });
    });
  };
  const pickSample = () => {
    ++picking.current;
    setPicked(pickedSample(limit));
  };
  const drop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files[0]);
  };

  const t = source === 'file' ? null : sources.data?.traces[source];
  const host = source === 'file' ? '' : (trace.host ?? t?.host ?? '');
  // Phoenix looks in a project: the one the CLI would pick unless another is typed.
  const project = source === 'phoenix' ? (trace.project ?? t?.project ?? 'default') : '';
  const idOk = source !== 'file' && traceIdOk(source, trace.id.trim());
  const projectOk = source !== 'phoenix' || phoenixProjectOk(project.trim());
  const traceOk = idOk && projectOk && !!t?.keys;
  const ready = !busy && (source === 'file' ? !!picked && !picked.error && !!picked.format : traceOk);

  // Stays open on a refusal, with what was picked.
  const run = async (): Promise<boolean> => {
    if (!ready) return false;
    setBusy(true);
    try {
      if (source === 'file' && picked?.format) {
        const up = await client.upload(picked.file, picked.file.name);
        watchJob(client.startJob(JOB_KINDS.importCapture, { format: picked.format, uploadId: up.uploadId }));
      } else if (source !== 'file') {
        const named = source === 'phoenix' && project.trim() !== t?.project ? { project: project.trim() } : {};
        watchJob(client.startJob(JOB_KINDS.importCapture, { format: source, traceId: trace.id.trim(), ...(host && host !== t?.host ? { host } : {}), ...named }));
      }
      return true;
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
      return false;
    }
  };
  const words = importWords({ source, picked, id: trace.id, host, project, keys: t ?? null, defaults: t ?? null, uploads: limit !== null });

  return (
    <Dialog
      title={confirmWords(ACTIONS.importCapture.label)}
      lead="Turns a capture, or a trace you store, into a recording you can replay your code against."
      doc="imports"
      warn={words.line ? { text: words.line } : null}
      // A file's row sits in its pane, above the sample, as the mock draws it.
      factsUnder={source === 'file' ? undefined : words.rows}
      command={words.command}
      ok={busy ? 'Uploading…' : confirmWords(ACTIONS.importCapture.label)}
      okDisabled={!ready}
      onOk={run}
      onClose={onClose}
      dirty={holdsFile(picked)}
      className="impdlg"
    >
      <Seg
        className="impsrc"
        label="Source"
        items={[
          { key: 'file', label: 'File' },
          { key: 'langfuse', label: 'Langfuse' },
          { key: 'langsmith', label: 'LangSmith' },
          { key: 'phoenix', label: 'Phoenix' },
          { key: 'logfire', label: 'Logfire' },
        ]}
        value={source}
        onChange={(s) => {
          // Each trace store has its own host and ids: what was typed for one isn't the other's.
          if (s !== source) setTrace({ host: null, id: '', project: null });
          setSource(s);
        }}
      />
      {source === 'file' ? (
        <FilePane picked={picked} over={over} setOver={setOver} drop={drop} input={input} pick={pick} setPicked={setPicked} pickSample={pickSample} uploads={limit !== null} rows={words.rows} />
      ) : (
        <TracePane source={source} host={host} project={project} trace={trace} setTrace={setTrace} idOk={idOk} />
      )}
    </Dialog>
  );
}

/** A capture from a file: its drop zone, the format read from its first bytes, and a sample where uploads work. */
function FilePane({ picked, over, setOver, drop, input, pick, setPicked, pickSample, uploads, rows }: { rows: DialogFactRows; picked: Picked | null; over: boolean; setOver: (on: boolean) => void; drop: (e: DragEvent<HTMLLabelElement>) => void; input: RefObject<HTMLInputElement | null>; pick: (file: File | undefined) => void; setPicked: (p: Picked) => void; pickSample: () => void; uploads: boolean }) {
  return (
    <div className="impbody">
      <label
        className={`drop${over ? ' over' : ''}${picked && !picked.error ? ' has' : ''}`}
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.current?.click();
          }
        }}
      >
        <input ref={input} type="file" accept={IMPORT_ACCEPT} hidden onChange={(e) => pick(e.target.files?.[0])} />
        <Icon name="import" />
        <b>Drop a capture or trace file here</b>
        <span>or click to choose · HAR, nock, VCR (JSON), LiteLLM (JSONL) or OpenTelemetry (OTLP JSON)</span>
      </label>
      {picked?.error ? <p className="fieldnote err">{picked.error}</p> : null}
      {picked && !picked.error && picked.format ? (
        <div className="capfile">
          <Icon name="folder" />
          <code>{picked.file.name}</code>
          <label className="pick">
            <span className="sr">Format</span>
            <select value={picked.format} onChange={(e) => setPicked({ ...picked, format: e.target.value as ImportFileFormat })}>
              {FILE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {IMPORT_FILE_FORMATS[f]}
                </option>
              ))}
            </select>
            <Icon name="caret" className="caret" />
          </label>
        </div>
      ) : null}
      <DialogFacts rows={rows} />
      {uploads ? (
        <div className="impsamples">
          <button className="linkbtn" type="button" onClick={pickSample}>
            Use sample: {OTEL_SAMPLE_NAME}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A trace in a store you run: where it is, and its id, each checked as it is typed. */
function TracePane({ source, host, project, trace, setTrace, idOk }: { source: TraceSource; host: string; project: string; trace: { host: string | null; id: string; project: string | null }; setTrace: (t: { host: string | null; id: string; project: string | null }) => void; idOk: boolean }) {
  return (
    <div className="impbody">
      <div className="form one">
        <label>
          Host
          <input spellCheck={false} value={host} onChange={(e) => setTrace({ ...trace, host: e.target.value })} />
        </label>
        {source === 'phoenix' ? (
          <label>
            Project
            <input spellCheck={false} autoComplete="off" value={project} onChange={(e) => setTrace({ ...trace, project: e.target.value })} />
          </label>
        ) : null}
        <label>
          Trace id
          <input spellCheck={false} autoComplete="off" placeholder={TRACE_COPY[source].id} value={trace.id} onChange={(e) => setTrace({ ...trace, id: e.target.value })} />
        </label>
      </div>
      {trace.id.trim() && !idOk ? <p className="fieldnote err">That is not a trace id: {TRACE_COPY[source].idRule}.</p> : null}
      {phoenixProjectNote(project) ? <p className="fieldnote err">{phoenixProjectNote(project)}</p> : null}
    </div>
  );
}
