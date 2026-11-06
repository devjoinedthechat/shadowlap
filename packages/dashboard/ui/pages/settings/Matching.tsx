import { useEffect, useRef, useState } from 'react';
import { JOB_KINDS } from '../../api.js';
import { useTreeBusy } from '../../fixes/tree.js';
import { ACTIONS } from '../../labels.js';
import { NORMALIZER_ASK } from '../../page-ask.js';
import { useApp } from '../../state.js';
import { CONFIG_FILE, ConfigProblem, LoadProblem, Loading, rulesUnreadable, SAVING, useEditor, useFolderGone, useSettingsData } from './common.js';
import { RuleDialog, RuleTable, addedText, removeRule } from './RuleTable.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Section } from '../../components/Section.js';

/** A clock write's toast, naming the mode now in force. */
const clockText = (mode: string) => `clock: ${mode} · written to ${CONFIG_FILE}`;

/**
 * Matching: the normalizers (what isn't part of a request's identity), the clock that lets dates
 * near a run's start match across days, and Calibrate, which replays a recording until it is clean
 * and proposes a normalizer for each value that changed. While shadowlap.config.json can't be read
 * there are no rules to show and nothing to calibrate against (every command refuses the file), so
 * the table says so, the clock shows no mode as chosen, and Calibrate isn't offered; the same with
 * the project's folder gone, where nothing is edited either.
 */
export function MatchingTab() {
  const app = useApp();
  const { client } = app;
  const { data, error, reload } = useSettingsData(() => client.settings.matching(), 'settings:matching');
  // Asked for from the palette too, which opens this tab first.
  const [adding, setAdding] = useState(() => NORMALIZER_ASK.take());
  useEffect(() => NORMALIZER_ASK.on(() => setAdding(true)), []);
  const editor = useEditor(data?.config.version ?? null, reload);
  // A rule an Undo put back: its Remove takes the focus once the table shows it.
  const putBack = useRef<number | null>(null);
  // Calibrate replays the agent from the project's working tree: not while a repair or an apply changes it.
  const tree = useTreeBusy('reads', 'calibrate');
  const gone = useFolderGone();
  if (error && !data) return <LoadProblem error={error} />;
  if (!data) return <Loading title="Matching" />;
  const off = app.actionsOff ?? gone ?? (data.config.error ? `Fix ${CONFIG_FILE} first` : editor.busy ? SAVING : null);
  const version = data.config.version ?? 'absent';
  // No rules to show, and nothing to calibrate against: the file can't be read, or the folder is gone.
  const unreadable = rulesUnreadable(data.config.error, gone);
  const cal = data.calibrate;
  const canCalibrate = !!cal.argv && !app.actionsOff && !gone && app.hasKind(JOB_KINDS.calibrate) && !tree;
  const calibrateTitle = gone ?? (!cal.argv ? 'Calibrate replays a finished recording made here' : (app.actionsOff ?? (!app.hasKind(JOB_KINDS.calibrate) ? 'This dashboard doesn’t run calibrate: shadowlap calibrate in a terminal' : (tree ?? `${cal.command!}${cal.source === 'setup' ? ' · the run this project’s setup recorded' : ''}`))));
  return (
    <>
      {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
      <Section
        className="set"
        title="Matching"
        sub="what is not part of a request’s identity"
        actions={
          <ActionButton className="btn sm" why={off} onClick={() => app.guard(() => setAdding(true))}>
            {ACTIONS.addNormalizerRule.label}
          </ActionButton>
        }
      >
        <div className="pbody">
          <p className="muted">A replay forks at the first request that differs. Normalizers mask values the agent makes anew on every run before matching, and never touch what is stored.</p>
        </div>
        <RuleTable
          list="normalize"
          rows={data.rules}
          off={off}
          unreadable={unreadable}
          onRemove={removeRule(app, editor, 'normalize', version, putBack)}
          focus={putBack}
        />
        <div className="setrow">
          <div>
            <b id="clock-name">Dates and times</b>
            <span id="clock-help">Dates within about a day of each run’s start match across days, so a golden recorded in June still replays in September.</span>
          </div>
          <div className="seg" role="group" aria-labelledby="clock-name" aria-describedby="clock-help">
            {(['auto', 'exact'] as const).map((k) => (
              <ActionButton
                key={k}
                // Which the file says isn't known while it can't be read: neither is shown as chosen.
                aria-pressed={!unreadable && data.clock.mode === k}
                why={off}
                title={k === 'exact' ? 'Dates must match exactly' : 'Dates near each run’s start match across days'}
                onClick={() => {
                  // The mode it has already, written or not (auto is what a file without one means): nothing to write.
                  if (data.clock.mode === k) return;
                  void editor.run(
                    () => client.settings.setClock(k, version),
                    (r) => clockText(r.clock),
                    // Back to what the file said, or to saying nothing (auto) where it had no clock.
                    (r) => (r.changed ? { edit: () => client.settings.setClock(r.was, r.version), ok: clockText(r.was ?? 'auto') } : null),
                  );
                }}
              >
                {k}
              </ActionButton>
            ))}
          </div>
        </div>
        {unreadable ? null : (
          <div className="setrow">
            <div>
              <b>Calibrate</b>
              <span id="calibrate-help">Replays a recording offline with the same code until it is clean, and proposes a normalizer for every value that changed. No model calls; writes are blocked.</span>
            </div>
            <ActionButton className="btn" aria-describedby="calibrate-help" why={canCalibrate ? null : calibrateTitle} title={calibrateTitle} onClick={() => app.guard(() => app.watchJob(client.startJob(JOB_KINDS.calibrate, { runId: cal.runId })))}>
              {cal.label}
            </ActionButton>
          </div>
        )}
      </Section>
      {adding ? (
        <RuleDialog
          list="normalize"
          kinds={data.form.kinds}
          patterns={data.form.patterns}
          version={version}
          onClose={() => setAdding(false)}
          onStale={reload}
          onAdded={(n, added, written) => {
            setAdding(false);
            editor.landed(written);
            reload();
            app.toast(addedText('normalize', n, added));
          }}
        />
      ) : null}
    </>
  );
}
