import { useRef, useState, type DragEvent, type RefObject } from 'react';
import { JOB_KINDS } from '../api.js';
import { Seg } from '../components/bits.js';
import { DialogFacts, type DialogFactRows } from '../components/DialogFacts.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { ImportSources } from '../types.js';

type TraceSourceView = ImportSources['traces'][TraceSource];
import { FILE_FORMATS, fileHead, importWindowFieldProblem, importWords, HEAD_BYTES, IMPORT_ACCEPT, IMPORT_FILE_FORMATS, NO_WINDOW, OTEL_SAMPLE_NAME, phoenixProjectNote, phoenixProjectOk, pickedFormats, sampleTrace, SEVERAL_FILES, severalNote, TRACE_COPY, traceIdOk, windowGiven, WINDOWED, windowNote, type ImportFileFormat, type TraceSource, type WindowFields } from './imports.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { Copy } from '../components/Copy.js';

/**
 * Import a capture or a trace: a file (dropped or picked; its format guessed from its name and its
 * first bytes, and changeable; YAML refused with the reason; or the sample trace the dashboard
 * ships), several files where the CLI puts a run together from them (a LiteLLM proxy's file per
 * worker, OpenTelemetry traces and their logs), or a trace by its host and id from Langfuse,
 * LangSmith, Phoenix (in a project) or Logfire, read with the keys already on this machine, or from
 * Langfuse, Phoenix and Logfire the traces that started in a window, each a run of its own. The files
 * go up first (`POST /api/uploads`), then the import job runs the CLI; the drawer ends with a link to
 * each run it made.
 */

type Source = 'file' | TraceSource;

interface Picked {
  files: File[];
  format: ImportFileFormat | null;
  error: string | null;
}

/** A trace store's fields: its host and project, and one trace's id, or the window of the traces to import (`many`). */
interface TraceFields {
  host: string | null;
  id: string;
  project: string | null;
  many: boolean;
  window: WindowFields;
}

const NO_TRACE: TraceFields = { host: null, id: '', project: null, many: false, window: NO_WINDOW };

/** The sample, picked as a file would be, so it goes up and is imported the same way. */
function pickedSample(limit: number | null): Picked {
  const sample = sampleTrace();
  const file = new File([sample.text], sample.name, { type: 'application/json' });
  return { files: [file], ...pickedFormats([{ name: file.name, bytes: file.size, head: sample.text.slice(0, HEAD_BYTES) }], limit) };
}

/** Why the trace fields can't be imported yet, or null: one trace's id, or the window, as the CLI checks them. */
function traceProblem(source: TraceSource, trace: TraceFields): string | null {
  if (trace.many && WINDOWED.has(source)) return windowNote(trace.window);
  if (!traceIdOk(source, trace.id.trim())) return 'id';
  return TRACE_COPY[source].looksBack ? importWindowFieldProblem('since', trace.window.since) : null;
}

/** What the import job is sent for a trace store: one trace, Logfire's looking back as far as typed, or the window. */
function traceRequest(source: TraceSource, trace: TraceFields): Record<string, unknown> {
  if (trace.many && WINDOWED.has(source)) return { window: windowGiven(trace.window) };
  const since = TRACE_COPY[source].looksBack ? trace.window.since.trim() : '';
  return { traceId: trace.id.trim(), ...(since ? { window: { since } } : {}) };
}

/** Sends the files picked up, one after another: the server keeps so many uploads waiting at once. */
async function uploadAll(client: ReturnType<typeof useApp>['client'], files: readonly File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) ids.push((await client.upload(file, file.name)).uploadId);
  return ids;
}

/** The import of the files sent up: `uploadId` for one, `uploadIds` for several. */
const fileRequest = (picked: Picked, ids: string[]) => ({ format: picked.format, ...(ids.length === 1 ? { uploadId: ids[0] } : { uploadIds: ids }) });

/** Whether the import can start: the files picked read as one format, or the store's fields check out and its keys are set here. */
function canImport(source: Source, picked: Picked | null, trace: TraceFields, project: string, at: TraceSourceView | null | undefined): boolean {
  if (source === 'file') return !!picked && !picked.error && !!picked.format;
  return traceProblem(source, trace) === null && (source !== 'phoenix' || phoenixProjectOk(project.trim())) && !!at?.keys;
}

/** Where a trace store is, when not where the CLI would look: a host typed, and Phoenix's project. */
function placeRequest(source: TraceSource, typed: { host: string; project: string }, at: TraceSourceView | null | undefined): Record<string, string> {
  const project = typed.project.trim();
  return { ...(typed.host && typed.host !== at?.host ? { host: typed.host } : {}), ...(source === 'phoenix' && project !== at?.project ? { project } : {}) };
}

/** A file that closing would lose: dropped, or the sample, it fired no field's change. A refused one holds nothing to keep. */
const holdsFile = (picked: Picked | null): boolean => !!picked && !picked.error;

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { client, watchJob, toast, meta } = useApp();
  const [source, setSource] = useState<Source>('file');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<TraceFields>(NO_TRACE);
  const input = useRef<HTMLInputElement>(null);
  const sources = useLoad(() => client.importSources(), 'import-sources');
  const limit = sources.data?.uploadLimit ?? meta?.uploadLimit ?? null;

  // The newest files picked: reading others' first bytes may end after them, and must not replace them.
  const picking = useRef(0);
  const pick = (list: FileList | null | undefined) => {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    const n = ++picking.current;
    // Their first bytes tell a HAR saved as .json from a nock recording, and OTLP lines from LiteLLM's.
    void Promise.all(files.map((f) => fileHead(f))).then((heads) => {
      if (n === picking.current) setPicked({ files, ...pickedFormats(files.map((f, i) => ({ name: f.name, bytes: f.size, head: heads[i] })), limit) });
    });
  };
  const pickSample = () => {
    ++picking.current;
    setPicked(pickedSample(limit));
  };
  const drop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files);
  };

  const t = source === 'file' ? null : sources.data?.traces[source];
  const host = source === 'file' ? '' : (trace.host ?? t?.host ?? '');
  // Phoenix looks in a project: the one the CLI would pick unless another is typed.
  const project = source === 'phoenix' ? (trace.project ?? t?.project ?? 'default') : '';
  const idOk = source !== 'file' && traceIdOk(source, trace.id.trim());
  const ready = !busy && canImport(source, picked, trace, project, t);

  // Stays open on a refusal, with what was picked.
  const run = async (): Promise<boolean> => {
    if (!ready) return false;
    setBusy(true);
    try {
      const fields = source === 'file' ? fileRequest(picked!, await uploadAll(client, picked!.files)) : { format: source, ...traceRequest(source, trace), ...placeRequest(source, { host, project }, t) };
      watchJob(client.startJob(JOB_KINDS.importCapture, fields));
      return true;
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
      return false;
    }
  };
  const words = importWords({ source, picked, id: trace.id, host, project, window: { many: trace.many, fields: trace.window }, keys: t ?? null, defaults: t ?? null, uploads: limit !== null });

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
          if (s !== source) setTrace(NO_TRACE);
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

/** A capture from a file, or several: the drop zone, the format read from their first bytes, and a sample where uploads work. */
function FilePane({ picked, over, setOver, drop, input, pick, setPicked, pickSample, uploads, rows }: { rows: DialogFactRows; picked: Picked | null; over: boolean; setOver: (on: boolean) => void; drop: (e: DragEvent<HTMLLabelElement>) => void; input: RefObject<HTMLInputElement | null>; pick: (files: FileList | null | undefined) => void; setPicked: (p: Picked) => void; pickSample: () => void; uploads: boolean }) {
  const several = (picked?.files.length ?? 0) > 1;
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
        <input ref={input} type="file" accept={IMPORT_ACCEPT} multiple hidden onChange={(e) => pick(e.target.files)} />
        <Icon name="import" />
        <b>Drop a capture or trace file here</b>
        <span>or click to choose · HAR, nock, VCR (JSON), LiteLLM (JSONL) or OpenTelemetry (OTLP JSON); several LiteLLM or OpenTelemetry files go in together</span>
      </label>
      {picked?.error ? <p className="fieldnote err">{picked.error}</p> : null}
      {picked && !picked.error && picked.format ? (
        <div className="capfile">
          <Icon name="folder" />
          <span className="capnames">
            {picked.files.map((f) => (
              <code key={`${f.name}:${f.size}:${f.lastModified}`}>{f.name}</code>
            ))}
          </span>
          <label className="pick">
            <span className="sr">Format</span>
            {/* Several files go in together as a format the CLI puts a run together from. */}
            <select value={picked.format} onChange={(e) => setPicked({ ...picked, format: e.target.value as ImportFileFormat, error: severalNote(picked.files.length, e.target.value as ImportFileFormat) })}>
              {FILE_FORMATS.filter((f) => !several || SEVERAL_FILES.has(f)).map((f) => (
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

/**
 * A trace in a store you run: where it is, and its id, each checked as it is typed; or, from Langfuse,
 * Phoenix and Logfire, the traces that started in a window. Logfire looks a trace up as far back as
 * Looks back says.
 */
function TracePane({ source, host, project, trace, setTrace, idOk }: { source: TraceSource; host: string; project: string; trace: TraceFields; setTrace: (t: TraceFields) => void; idOk: boolean }) {
  const many = trace.many && WINDOWED.has(source);
  const field = (k: keyof WindowFields) => (e: { target: { value: string } }) => setTrace({ ...trace, window: { ...trace.window, [k]: e.target.value } });
  const looksBack = !many && TRACE_COPY[source].looksBack ? importWindowFieldProblem('since', trace.window.since) : null;
  return (
    <div className="impbody">
      {WINDOWED.has(source) ? (
        <Seg
          className="impmode"
          label="What to import"
          items={[
            { key: 'one', label: 'One trace' },
            { key: 'many', label: 'Traces in a window' },
          ]}
          value={many ? 'many' : 'one'}
          onChange={(k) => setTrace({ ...trace, many: k === 'many' })}
        />
      ) : null}
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
        {many ? null : (
          <label>
            Trace id
            <input spellCheck={false} autoComplete="off" placeholder={TRACE_COPY[source].id} value={trace.id} onChange={(e) => setTrace({ ...trace, id: e.target.value })} />
          </label>
        )}
        {!many && TRACE_COPY[source].looksBack ? (
          <label>
            Looks back
            <input spellCheck={false} autoComplete="off" placeholder="30d" value={trace.window.since} onChange={field('since')} />
          </label>
        ) : null}
      </div>
      {many ? <WindowFieldsForm window={trace.window} field={field} /> : null}
      {!many && trace.id.trim() && !idOk ? <Copy className="fieldnote err">{`That is not a trace id: ${TRACE_COPY[source].idRule}.`}</Copy> : null}
      {looksBack ? <Copy className="fieldnote err">{looksBack}</Copy> : null}
      {phoenixProjectNote(project) ? <Copy className="fieldnote err">{phoenixProjectNote(project)}</Copy> : null}
    </div>
  );
}

/** The window of the traces to import, as the CLI takes it, each field empty for the CLI's own: the last 30 days, the newest 100, any name. */
function WindowFieldsForm({ window, field }: { window: WindowFields; field: (k: keyof WindowFields) => (e: { target: { value: string } }) => void }) {
  const note = windowNote(window);
  return (
    <>
      <div className="form impwin">
        <label>
          Since
          <input spellCheck={false} autoComplete="off" placeholder="30d" value={window.since} onChange={field('since')} />
        </label>
        <label>
          Until
          <input spellCheck={false} autoComplete="off" placeholder="now" value={window.until} onChange={field('until')} />
        </label>
        <label>
          At most
          <input spellCheck={false} autoComplete="off" inputMode="numeric" placeholder="100" value={window.limit} onChange={field('limit')} />
        </label>
        <label>
          Trace name
          <input spellCheck={false} autoComplete="off" placeholder="any" value={window.traceName} onChange={field('traceName')} />
        </label>
      </div>
      {note ? <Copy className="fieldnote err">{note}</Copy> : <Copy className="fieldnote">A date (2026-09-30), a time, or how long ago (30d, 12h); the newest traces first.</Copy>}
    </>
  );
}
