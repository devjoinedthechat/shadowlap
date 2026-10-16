import { Fragment, useEffect, useState } from 'react';
import { ApiError } from '../../api.js';
import { tipCard, tipText } from '../../components/HoverCard.js';
import { Icon } from '../../components/Icon.js';
import { num } from '../../format.js';
import type { RedactionPreviewView, RedactionSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, ConfigProblem, LoadProblem, Loading, SAVING, useEditor, useSettingsData } from './common.js';
import { maskedLine, partialLine, previewChip, unmaskedLine } from './logic.js';
import { RuleDialog, RuleTable, addedText, removedText } from './RuleTable.js';

/**
 * Redaction: the rules applied to every copy of a run that leaves this machine, where each kind of
 * copy applies them, and a preview of what they would mask in a run you pick (path rules too),
 * counted per rule with up to two samples before and after, and under a rule what it matches that a
 * copy leaves as it is (a number), with the path rule that masks it.
 */

/** The run the preview shows, kept while the dashboard is open. */
const kept: { run: string | null } = { run: null };

export function RedactionTab() {
  const app = useApp();
  const { client } = app;
  const { data, error, reload } = useSettingsData(() => client.settings.redaction(), 'settings:redaction');
  const [adding, setAdding] = useState(false);
  const [run, setRun] = useState<string | null>(kept.run);
  const editor = useEditor(data?.config.version ?? null, reload);
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Redaction" />;
  const off = app.actionsOff ?? (data.config.error ? `Fix ${CONFIG_FILE} first` : editor.busy ? SAVING : null);
  const version = data.config.version ?? 'absent';
  const pick = run && data.runs.some((r) => r.runId === run) ? run : data.previewRunId;
  return (
    <>
      {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
      <section className="panel set">
        <header>
          <h2>Redaction</h2>
          <span className="sub">what leaves your machine</span>
          <span className="sp" />
          <button className="btn sm" type="button" disabled={!!off} title={off ?? undefined} onClick={() => app.guard(() => setAdding(true))}>
            Add rule
          </button>
        </header>
        <div className="pbody">
          <p className="muted">
            Applied to the copy whenever a run leaves this machine: <Where where={data.where} />. The local store is never modified, and API keys and authorization headers are never stored at all.
          </p>
        </div>
        <RuleTable list="redact" rows={data.rules} off={off} onRemove={(row) => void editor.run(() => client.settings.removeRule('redact', row.n, version), (r) => removedText('redact', r.n))} />
        <Preview
          data={data}
          pick={pick}
          onPick={(id) => {
            kept.run = id;
            setRun(id);
          }}
        />
      </section>
      {adding ? (
        <RuleDialog
          list="redact"
          kinds={data.form.kinds}
          patterns={data.form.patterns}
          version={version}
          onClose={() => setAdding(false)}
          onStale={reload}
          onAdded={(n, added, written) => {
            setAdding(false);
            editor.landed(written);
            reload();
            app.toast(addedText('redact', n, added));
          }}
        />
      ) : null}
    </>
  );
}

/** The commands a copy leaves by, each with how it applies the rules on hover. */
function Where({ where }: { where: RedactionSettings['where'] }) {
  return (
    <>
      {where.map((w, i) => (
        <Fragment key={w.id}>
          {i === 0 ? '' : i === where.length - 1 ? ' and ' : ', '}
          <code className="tipped" tabIndex={0} data-tip={tipText(`${w.command.replace(/^shadowlap /, '')}: ${w.note}`)}>
            {w.command.replace(/^shadowlap /, '')}
          </code>
        </Fragment>
      ))}
    </>
  );
}

/** How long the page waits before asking again when the server is reading other previews (a 503). */
const BUSY_RETRY_MS = 800;
const BUSY_RETRIES = 6;

/**
 * The preview of one run, read again when the key changes (another run, the rules edited). Asking
 * for another one stops waiting for the last, and the server stops reading it.
 */
function usePreview(runId: string | null, key: string): { view: RedactionPreviewView | null; error: Error | null; loading: boolean } {
  const { client } = useApp();
  const [state, setState] = useState<{ key: string; view: RedactionPreviewView | null; error: Error | null; loading: boolean }>({ key: '', view: null, error: null, loading: false });
  useEffect(() => {
    if (!runId) {
      setState({ key, view: null, error: null, loading: false });
      return;
    }
    const stop = new AbortController();
    setState({ key, view: null, error: null, loading: true });
    const ask = (tries: number): void => {
      client.settings.preview(runId, stop.signal).then(
        (view) => {
          if (!stop.signal.aborted) setState({ key, view, error: null, loading: false });
        },
        (err: unknown) => {
          if (stop.signal.aborted) return;
          // Other previews (another tab of the dashboard) are being read: ask again in a moment.
          if (err instanceof ApiError && err.status === 503 && tries < BUSY_RETRIES) return void setTimeout(() => !stop.signal.aborted && ask(tries + 1), BUSY_RETRY_MS);
          setState({ key, view: null, error: err instanceof Error ? err : new Error(String(err)), loading: false });
        },
      );
    };
    ask(0);
    return () => stop.abort();
  }, [client, runId, key]);
  return state.key === key ? state : { view: null, error: null, loading: !!runId };
}

function Preview({ data, pick, onPick }: { data: RedactionSettings; pick: string | null; onPick: (runId: string) => void }) {
  const broken = data.rules.find((r) => r.error);
  const can = !!pick && !data.config.error && !broken && data.rules.length > 0;
  // Read again when the rules change (the file's version) or another run is picked.
  const p = usePreview(can ? pick : null, `preview:${pick}:${data.config.version}:${data.rules.length}`);
  if (!pick || !data.runs.length) {
    return (
      <div className="pbody preview">
        <div className="pvhead">
          <b>Preview</b>
          <span className="muted">{data.previewError ?? 'Record a run first: the preview needs one to read.'}</span>
        </div>
      </div>
    );
  }
  const view = p.view;
  return (
    <div className="pbody preview">
      <div className="pvhead">
        <b>Preview</b>
        <label className="pick">
          <span className="sr">Run to preview</span>
          <select value={pick} onChange={(e) => onPick(e.target.value)}>
            {data.runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.label}
              </option>
            ))}
          </select>
          <Icon name="caret" className="caret" />
        </label>
        <span className="muted">{!data.rules.length ? 'no rules, so nothing would be masked' : !can ? '' : p.loading && !view ? 'reading the run…' : view ? maskedLine(view.preview.total, view.preview.unmasked) : ''}</span>
      </div>
      {data.config.error ? null : broken ? (
        <p className="fieldnote err">
          Redaction rule #{broken.n} can’t be used: {broken.error}. Remove it or fix it in {CONFIG_FILE} to see the preview.
        </p>
      ) : !data.rules.length ? (
        <p className="muted pvnone">Add a rule to see what it would mask in this run before a copy leaves the machine.</p>
      ) : p.error && !view ? (
        <p className="fieldnote err">{p.error.message}</p>
      ) : view ? (
        <>
          {view.preview.rules.map((r) => {
            // What it matches that a copy leaves as it is: the line says why its count is 0, when it is.
            const left = unmaskedLine(r.unmasked, r.count);
            return (
              <div className="pvrule" key={r.n}>
                <span className="chip" title={`#${r.n}`}>
                  {previewChip(r.rule)}
                </span>
                <span className="pvn">{num(r.count)}</span>
                {r.samples.length ? (
                  r.samples.map((s, i) => (
                    <div className="pvs" key={i}>
                      <span className="del">{s.before}</span>
                      <span className="add">{s.after}</span>
                    </div>
                  ))
                ) : left ? null : (
                  <span className="muted">{r.note ?? 'no matches in this run'}</span>
                )}
                {left ? (
                  <span className="muted pvd pvleft">
                    <span className="tipped" tabIndex={0} data-tip={tipCard(r.unmasked.count === 1 ? 'Left as it is' : 'Left as they are', left.rows)}>
                      {left.text}
                    </span>
                    {left.command ? (
                      <>
                        {' '}
                        <code>{left.command}</code>
                        {left.more ? ` and ${left.more} more ${left.more === 1 ? 'place' : 'places'}: ` : null}
                        {left.more ? <code>{view.command}</code> : null}
                        {left.more ? ` lists ${left.more === 1 ? 'it' : 'them'}.` : null}
                      </>
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          })}
          {view.preview.details.count ? (
            <div className="pvrule">
              <span className="chip">command line, labels, notes</span>
              <span className="pvn">{num(view.preview.details.count)}</span>
              {view.preview.details.samples.map((s, i) => (
                <div className="pvs" key={i}>
                  <span className="del">{s.before}</span>
                  <span className="add">{s.after}</span>
                </div>
              ))}
              <span className="muted pvd">masked in HTML copies, datasets and traces; a pack keeps them as recorded, since a replay runs the command</span>
            </div>
          ) : null}
          {view.preview.partial ? (
            <p className="muted pvfoot">
              {partialLine(view.preview.partial)} <code>{view.command}</code> reads them all.
            </p>
          ) : null}
          {view.preview.unreadable ? <p className="fieldnote warn">{view.preview.unreadable === 1 ? '1 call could not be read and is' : `${view.preview.unreadable} calls could not be read and are`} not counted.</p> : null}
        </>
      ) : null}
    </div>
  );
}
