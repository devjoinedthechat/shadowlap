import { useEffect, useId, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { AskNote } from '../components/AskNote.js';
import type { CostLineProps } from '../components/CostLine.js';
import { Dialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import { guardedWayOn, useApp } from '../state.js';
import type { BlameOffer } from '../types.js';
import { parseCheck } from './model.js';
import { commandWithBudget, StopAtField, useStopAt } from './stop-at.js';

/**
 * Run blame's ask with its settings beside the check, as the terminal UI's B shows the check before
 * a blame runs: the check it is judged by (`--expect`), shown to edit, or emptied for the exit code
 * alone; the agent it searches, where the run's model calls name several (`--scope`); request fields
 * set from each probed call on (`--set`), `temperature=1` to start from for a run recorded at
 * temperature 0, where a model asked again answers the same; another model to rescue with
 * (`--model`); and Stop at $. The run page's offers say the check, the agents and the temperature;
 * a dialog opened where they weren't read (a list's row) reads them as it opens.
 */

/** What the dialog starts from: the offer as the button was given it, the agent the Agents bar picked. */
export interface BlameSettingsProps {
  runId: string;
  offer: Pick<BlameOffer, 'from' | 'failed'> & Partial<Pick<BlameOffer, 'expect' | 'scopes' | 'temperature0'>>;
  scope?: string | undefined;
  /** The command it runs, where the button knows it (a capture's `-- <command>` among it). */
  line: string | undefined;
  cost: CostLineProps;
  estimate: Estimate | null | undefined;
  form: boolean;
  start: (fields: Record<string, unknown>) => Promise<string | null>;
  onClose: () => void;
}

/** The check as its field shows it: its JSON, or empty for the exit code alone. */
const checkText = (expect: unknown): string => (expect === undefined || expect === null ? '' : JSON.stringify(expect));

/** The request fields typed, each `key=value`, apart at spaces or commas. */
export const fieldsTyped = (typed: string): string[] => typed.split(/[\s,]+/).filter(Boolean);

/** The command the settings run, after `shadowlap blame <run>`, as the job builds it. */
export function blameSettingsLine(o: { check: string; scope: string; fields: readonly string[]; model: string }): string {
  const quote = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  return [o.check.trim() ? `--expect ${quote(o.check.trim())}` : '', o.scope ? `--scope ${quote(o.scope)}` : '', ...o.fields.map((f) => `--set ${quote(f)}`), o.model.trim() ? `--model ${quote(o.model.trim())}` : ''].filter(Boolean).join(' ');
}

export function BlameSettingsDialog({ runId, offer: given, scope: picked, line, cost, estimate, form, start, onClose }: BlameSettingsProps) {
  const app = useApp();
  const { client } = app;
  // The run page's offer says the check, the agents and the temperature; one a list gave says less, so it is read again.
  const [offer, setOffer] = useState(given);
  useEffect(() => {
    if (given.expect !== undefined || given.scopes || given.temperature0) return;
    let live = true;
    client.offers(runId).then(
      (o) => {
        if (live && o?.blame) setOffer(o.blame);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, runId, given]);
  const [check, setCheck] = useState<string | null>(null);
  const shown = check ?? checkText(offer.expect);
  const [scope, setScope] = useState(picked ?? '');
  const [fields, setFields] = useState<string | null>(null);
  const typedFields = fields ?? (offer.temperature0 ? 'temperature=1' : '');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stop = useStopAt(null);
  const ids = { check: useId(), scope: useId(), fields: useId(), model: useId() };
  const id = shortId(runId);
  const base = line ?? `shadowlap blame ${id}`;
  const cut = base.indexOf(' -- ');
  const settings = blameSettingsLine({ check: shown, scope, fields: fieldsTyped(typedFields), model });
  const command = commandWithBudget(`${cut < 0 ? base : base.slice(0, cut)}${settings ? ` ${settings}` : ''}${cut < 0 ? '' : base.slice(cut)}`, stop.fields.budget ?? null);
  const submit = () => {
    const parsed = shown.trim() ? parseCheck(shown) : null;
    if (parsed && 'error' in parsed) {
      setError(parsed.error);
      return false;
    }
    // The check as it opened goes unsent: the server picks the same one, as the CLI judges the run.
    const fieldsSent = { ...(check !== null ? { expect: parsed ? parsed.expect : null } : {}), ...(scope ? { scope } : {}), ...(fieldsTyped(typedFields).length ? { set: fieldsTyped(typedFields) } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...stop.fields };
    // What it starts closes it, or asks in its place; it stays only for a refusal of what was typed here.
    return guardedWayOn(app.guard, () =>
      start(fieldsSent).then((refused) => {
        if (refused) setError(refused);
        return null;
      }),
    );
  };
  const scopes = offer.scopes ?? [];
  return (
    <Dialog
      title={namedIn(`${ACTIONS.runBlame.label} on ${id}`, id)}
      lead="Finds the model call that lost the run."
      doc="blame"
      warn={error ? { text: error } : null}
      command={command}
      cost={cost}
      footNote={<AskNote estimate={estimate} form={form} />}
      ok={ACTIONS.runBlame.label}
      onOk={submit}
      onClose={onClose}
    >
      <div className="form one fxblame">
        <label htmlFor={ids.check}>Judged by (JSON, empty for the exit code alone)</label>
        <textarea id={ids.check} value={shown} placeholder="the exit code alone" spellCheck={false} onChange={(e) => (setCheck(e.target.value), setError(null))} />
        {scopes.length ? (
          <>
            <label htmlFor={ids.scope}>Agent</label>
            <select id={ids.scope} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">every agent</option>
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor={ids.fields}>Request fields from each probed call (key=value)</label>
        <input id={ids.fields} type="text" value={typedFields} placeholder="none, as recorded" spellCheck={false} onChange={(e) => setFields(e.target.value)} />
        {offer.temperature0 ? <p className="muted fieldhint">Recorded at temperature 0, where a model asked again answers the same: temperature=1 lets each probe sample.</p> : null}
        <label htmlFor={ids.model}>Rescue with model</label>
        <input id={ids.model} type="text" value={model} placeholder="the recorded one" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      </div>
      <StopAtField typed={stop.typed} setTyped={stop.setTyped} />
    </Dialog>
  );
}
