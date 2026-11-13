import { Fragment, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api.js';
import { CopyButton } from '../../components/bits.js';
import { Code, Copy, Words } from '../../components/Copy.js';
import { tipCard, tipText } from '../../components/HoverCard.js';
import { RunPicker } from '../../compare/RunPicker.js';
import { num } from '../../format.js';
import { ACTIONS } from '../../labels.js';
import { REDACTION_ASK } from '../../page-ask.js';
import type { RedactionPreviewView, RedactionSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import { useTeamStore } from '../../teamstore.js';
import { CONFIG_FILE, ConfigProblem, LoadProblem, Loading, rulesUnreadable, SAVING, useEditor, useFolderGone, useSettingsData } from './common.js';
import { maskedLine, partialLine, previewChip, redactionNotes, returnedLine, unmaskedLine } from './logic.js';
import { RuleDialog, RuleTable, addedText, removeRule } from './RuleTable.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Section } from '../../components/Section.js';

/**
 * Redaction: the rules applied to every export, pack and share link of a run, where each applies
 * them, that a push copies runs to the team store as recorded (with one), what is never stored at
 * all, and a preview of what the rules would mask in a run you pick (path rules too),
 * counted per rule with up to two samples before and after. Under a rule, quiet lines: what a path
 * rule masks only in HTML, HAR and dataset copies (in what calls got back, which a pack keeps for its
 * replay), and what it matches that a pack leaves as it is (a number), with the path rule that masks
 * it ready to copy, or why none can.
 */

/** The run the preview shows, kept while the dashboard is open. */
const kept: { run: string | null } = { run: null };

export function RedactionTab() {
  const app = useApp();
  const { client } = app;
  const { data, error, reload } = useSettingsData(() => client.settings.redaction(), 'settings:redaction');
  // Asked for from the palette too, which opens this tab first.
  const [adding, setAdding] = useState(() => REDACTION_ASK.take());
  useEffect(() => REDACTION_ASK.on(() => setAdding(true)), []);
  const [run, setRun] = useState<string | null>(kept.run);
  const editor = useEditor(data?.config.version ?? null, reload);
  // A rule an Undo put back: its Remove takes the focus once the table shows it.
  const putBack = useRef<number | null>(null);
  const teamStore = !!useTeamStore();
  const gone = useFolderGone();
  if (error && !data) return <LoadProblem error={error} retry={reload} />;
  if (!data) return <Loading title="Redaction" />;
  const off = app.actionsOff ?? gone ?? (data.config.error ? `Fix ${CONFIG_FILE} first` : editor.busy ? SAVING : null);
  const version = data.config.version ?? 'absent';
  const unreadable = rulesUnreadable(data.config.error, gone);
  const pick = run && data.runs.some((r) => r.runId === run) ? run : data.previewRunId;
  return (
    <>
      {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
      <Section
        className="set"
        title="Redaction"
        sub="what leaves your machine"
        actions={
          <ActionButton className="btn sm" why={off} onClick={() => app.guard(() => setAdding(true))}>
            {ACTIONS.addRedactionRule.label}
          </ActionButton>
        }
      >
        <div className="pbody">
          <Copy className="muted">
            Applied to every export, pack and share link: {whereCodes(data.where)}. {redactionNotes(teamStore)}
          </Copy>
        </div>
        <RuleTable list="redact" rows={data.rules} off={off} unreadable={unreadable} onRemove={removeRule(app, editor, 'redact', version, putBack)} focus={putBack} />
        {/* No rules to preview while the file can't be read or the folder is gone: the table says so. */}
        {unreadable ? null : (
          <Preview
            data={data}
            pick={pick}
            onPick={(id) => {
              kept.run = id;
              setRun(id);
            }}
          />
        )}
      </Section>
      {adding ? (
        <RuleDialog
          list="redact"
          teamStore={teamStore}
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

/** The commands a copy leaves by, each with how it applies the rules on hover: pieces of the lead, so its `Copy` sets them as words. */
function whereCodes(where: RedactionSettings['where']) {
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
  const { runs } = useApp();
  const broken = data.rules.find((r) => r.error);
  const can = !!pick && !data.config.error && !broken && data.rules.length > 0;
  // Read again when the rules change (the file's version) or another run is picked.
  const p = usePreview(can ? pick : null, `preview:${String(pick)}:${String(data.config.version)}:${data.rules.length}`);
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
        {/* The run picker Compare uses: each run by its id, with its about line beside it (decision 10); a recording's as the run list has it. */}
        <RunPicker
          label="Run to preview"
          value={pick}
          runs={data.runs.map((r) => {
            const listed = runs?.find((x) => x.runId === r.runId);
            return { runId: r.runId, about: r.about ?? listed?.about ?? null, ...(listed ? { labels: listed.labels } : {}) };
          })}
          onPick={onPick}
        />
        <span className="muted">
          <Words>{!data.rules.length ? 'no rules, so nothing would be masked' : !can ? '' : p.loading && !view ? 'reading the run…' : view ? maskedLine(view.preview.total, view.preview.unmasked, view.preview.returned, view.preview.kept) : ''}</Words>
        </span>
      </div>
      {data.config.error ? null : broken ? (
        <p className="fieldnote err">
          Redaction rule #{broken.n} can’t be used: {broken.error}. Remove it or fix it in {CONFIG_FILE} to see the preview.
        </p>
      ) : !data.rules.length ? (
        <Copy className="muted pvnone">Add a rule to see what it would mask in this run before you export, pack or share it.</Copy>
      ) : p.error && !view ? (
        <p className="fieldnote err">{p.error.message}</p>
      ) : view ? (
        <>
          {view.preview.rules.map((r) => {
            // What only HTML, HAR and dataset copies mask, and what a pack leaves as it is: either
            // line says why the count is 0, when it is.
            const read = returnedLine(r.returned);
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
                ) : left || read ? null : (
                  <span className="muted">{r.note ?? 'no matches in this run'}</span>
                )}
                {read ? (
                  <span className="muted pvd">
                    <span className="tipped" tabIndex={0} data-tip={tipCard('In HTML, HAR and dataset copies', read.rows)}>
                      {read.text}
                    </span>
                  </span>
                ) : null}
                {left ? (
                  <span className="muted pvd pvleft">
                    <span className="tipped" tabIndex={0} data-tip={tipCard(r.unmasked.count === 1 ? 'Left as it is' : 'Left as they are', left.rows)}>
                      {left.text}
                    </span>
                    {left.path ? (
                      <>
                        {' at '}
                        <code>{left.path}</code>
                      </>
                    ) : null}
                    {left.command ? (
                      <>
                        {' '}
                        <span className="pvcopy" title={left.command}>
                          <CopyButton text={left.command} label="the path rule" />
                        </span>
                      </>
                    ) : null}
                    {left.more > 0 ? (
                      <>
                        {' · '}
                        {num(left.more)} more {left.more === 1 ? 'place' : 'places'} in{' '}
                        <span className="tipped" tabIndex={0} data-tip={tipText(view.command)}>
                          redact preview
                        </span>
                      </>
                    ) : null}
                    {left.after ? ` · ${left.after}` : null}
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
            <Copy className="muted pvfoot">
              {partialLine(view.preview.partial)} <Code>{view.command}</Code> reads them all.
            </Copy>
          ) : null}
          {view.preview.unreadable ? <Copy className="fieldnote warn">{view.preview.unreadable === 1 ? '1 call could not be read and is' : `${view.preview.unreadable} calls could not be read and are`} not counted.</Copy> : null}
        </>
      ) : null}
    </div>
  );
}

