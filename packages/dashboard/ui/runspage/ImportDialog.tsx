import { useRef, useState, type DragEvent } from 'react';
import { JOB_KINDS } from '../api.js';
import { Seg } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { FILE_FORMATS, FORMAT_LABEL, guessImportFormat, IMPORT_ACCEPT, keyList, tooLargeNote, TRACE_COPY, TRACE_ID, type FileFormat, type TraceSource } from './imports.js';

/**
 * Import a capture or a trace: a file (dropped or picked; its format guessed from its name and
 * changeable, YAML refused with the reason), or a Langfuse or LangSmith trace by its host and id,
 * read with the keys already on this machine. The file goes up first (`POST /api/uploads`), then
 * the import job runs the CLI; the drawer ends with a link to each run it made.
 */

type Source = 'file' | TraceSource;

interface Picked {
  file: File;
  format: FileFormat | null;
  error: string | null;
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { client, watchJob, toast, meta } = useApp();
  const [source, setSource] = useState<Source>('file');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<{ host: string | null; id: string }>({ host: null, id: '' });
  const input = useRef<HTMLInputElement>(null);
  const sources = useLoad(() => client.importSources(), 'import-sources');
  const limit = sources.data?.uploadLimit ?? meta?.uploadLimit ?? null;

  const pick = (file: File | undefined) => {
    if (!file) return;
    const g = guessImportFormat(file.name);
    const big = tooLargeNote(file.size, limit, g.format);
    setPicked({ file, format: g.format, error: g.error ?? big });
  };
  const drop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files[0]);
  };

  const t = source === 'file' ? null : sources.data?.traces[source];
  const host = source === 'file' ? '' : (trace.host ?? t?.host ?? '');
  const traceOk = source !== 'file' && TRACE_ID.test(trace.id.trim()) && !!t?.keys;
  const ready = !busy && (source === 'file' ? !!picked && !picked.error && !!picked.format : traceOk);

  const run = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      if (source === 'file' && picked?.format) {
        const up = await client.upload(picked.file, picked.file.name);
        watchJob(client.startJob(JOB_KINDS.importCapture, { format: picked.format, uploadId: up.uploadId }));
      } else if (source !== 'file') {
        watchJob(client.startJob(JOB_KINDS.importCapture, { format: source, traceId: trace.id.trim(), ...(host && host !== t?.host ? { host } : {}) }));
      }
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Import a capture or a trace"
      text="Turns traffic another tool captured, or a trace you already store, into a recording you can replay your own code against. What the source didn’t keep runs live on replay, with writes fenced."
      ok={busy ? 'Uploading…' : 'Import'}
      okDisabled={!ready}
      onOk={() => void run()}
      onClose={onClose}
      className="impdlg"
    >
      <Seg
        label="Source"
        items={[
          { key: 'file', label: 'File' },
          { key: 'langfuse', label: 'Langfuse' },
          { key: 'langsmith', label: 'LangSmith' },
        ]}
        value={source}
        onChange={(s) => setSource(s)}
      />
      {source === 'file' ? (
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
                <select value={picked.format} onChange={(e) => setPicked({ ...picked, format: e.target.value as FileFormat })}>
                  {FILE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABEL[f]}
                    </option>
                  ))}
                </select>
                <Icon name="caret" className="caret" />
              </label>
            </div>
          ) : null}
          {limit === null ? <p className="fieldnote warn">This dashboard takes no files: start it in your project with shadowlap dashboard, or import in a terminal with shadowlap import.</p> : null}
        </div>
      ) : (
        <div className="impbody">
          <div className="form one">
            <label>
              Host
              <input spellCheck={false} value={host} onChange={(e) => setTrace({ ...trace, host: e.target.value })} />
            </label>
            <label>
              Trace id
              <input spellCheck={false} autoComplete="off" placeholder={`the id from the trace’s page in ${TRACE_COPY[source].name}`} value={trace.id} onChange={(e) => setTrace({ ...trace, id: e.target.value })} />
            </label>
          </div>
          <p className="muted impnote">
            {TRACE_COPY[source].keeps} The key comes from {t ? keyList(t.keyNames) : source === 'langfuse' ? 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY' : 'LANGSMITH_API_KEY'} on this machine; nothing passes through Shadowlap.
          </p>
          {t && !t.keys ? (
            <p className="fieldnote warn">
              {keyList(t.keyNames)} {t.keyNames.length === 1 ? 'is' : 'are'} not set where this dashboard runs: set {t.keyNames.length === 1 ? 'it' : 'them'}, then start shadowlap dashboard again.
            </p>
          ) : null}
          {trace.id.trim() && !TRACE_ID.test(trace.id.trim()) ? <p className="fieldnote err">That is not a trace id: letters, digits, dashes, dots and colons.</p> : null}
        </div>
      )}
    </Dialog>
  );
}
