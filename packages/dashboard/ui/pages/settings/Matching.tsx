import { useState } from 'react';
import { JOB_KINDS } from '../../api.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, ConfigProblem, LoadProblem, Loading, SAVING, useEditor, useSettingsData } from './common.js';
import { RuleDialog, RuleTable, addedText, removedText } from './RuleTable.js';

/**
 * Matching: the normalizers (what isn't part of a request's identity), the clock that lets dates
 * near a run's start match across days, and Calibrate, which replays a recording until it is clean
 * and proposes a normalizer for each value that changed.
 */
export function MatchingTab() {
  const app = useApp();
  const { client } = app;
  const { data, error, reload } = useSettingsData(() => client.settings.matching(), 'settings:matching');
  const [adding, setAdding] = useState(false);
  const editor = useEditor(data?.config.version ?? null, reload);
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Matching" />;
  const off = app.actionsOff ?? (data.config.error ? `Fix ${CONFIG_FILE} first` : editor.busy ? SAVING : null);
  const version = data.config.version ?? 'absent';
  const cal = data.calibrate;
  const canCalibrate = !!cal.argv && !app.actionsOff && app.hasKind(JOB_KINDS.calibrate);
  const calibrateTitle = !cal.argv ? 'Calibrate replays a finished recording made here' : app.actionsOff ?? (!app.hasKind(JOB_KINDS.calibrate) ? 'This dashboard doesn’t run calibrate: shadowlap calibrate in a terminal' : `${cal.command}${cal.source === 'setup' ? ' · the run this project’s setup recorded' : ''}`);
  return (
    <>
      {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
      <section className="panel set">
        <header>
          <h2>Matching</h2>
          <span className="sub">what is not part of a request’s identity</span>
          <span className="sp" />
          <button className="btn sm" type="button" disabled={!!off} title={off ?? undefined} onClick={() => app.guard(() => setAdding(true))}>
            Add normalizer
          </button>
        </header>
        <div className="pbody">
          <p className="muted">A replay forks at the first request that differs. Normalizers mask values the agent makes anew on every run before matching, and never touch what is stored.</p>
        </div>
        <RuleTable
          list="normalize"
          rows={data.rules}
          off={off}
          onRemove={(row) => void editor.run(() => client.settings.removeRule('normalize', row.n, version), (r) => removedText('normalize', r.n))}
        />
        <div className="setrow">
          <div>
            <b>Dates and times</b>
            <span>Dates within about a day of each run’s start match across days, so a golden recorded in June still replays in September.</span>
          </div>
          <div className="seg" role="group" aria-label="Clock">
            {(['auto', 'exact'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={data.clock.mode === k}
                disabled={!!off}
                title={off ?? (k === 'exact' ? 'Dates must match exactly' : 'Dates near each run’s start match across days')}
                onClick={() => {
                  // The mode it has already, written or not (auto is what a file without one means): nothing to write.
                  if (data.clock.mode === k) return;
                  void editor.run(() => client.settings.setClock(k, version), (r) => `clock: ${r.clock} · written to ${CONFIG_FILE}`);
                }}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="setrow">
          <div>
            <b>Calibrate</b>
            <span>Replays a recording offline with the same code until it is clean, and proposes a normalizer for every value that changed. No model calls; writes are blocked.</span>
          </div>
          <button className="btn" type="button" disabled={!canCalibrate} title={calibrateTitle} onClick={() => app.guard(() => app.watchJob(client.startJob(JOB_KINDS.calibrate, { runId: cal.runId })))}>
            {cal.label}
          </button>
        </div>
      </section>
      {adding ? (
        <RuleDialog
          list="normalize"
          kinds={data.form.kinds}
          patterns={data.form.patterns}
          version={version}
          onClose={() => setAdding(false)}
          onStale={reload}
          onAdded={(n, added) => {
            setAdding(false);
            reload();
            app.toast(addedText('normalize', n, added));
          }}
        />
      ) : null}
    </>
  );
}
