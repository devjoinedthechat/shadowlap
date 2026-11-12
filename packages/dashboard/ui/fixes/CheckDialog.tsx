import { useState } from 'react';
import { probesPart } from '../../../engine/src/cost-words.js';
import type { CostLineProps } from '../components/CostLine.js';
import { Dialog, pressWayOn } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { shortId } from '../format.js';
import { ACTIONS } from '../labels.js';
import { parseCheck } from './model.js';
import { Copy } from '../components/Copy.js';

/**
 * The check a blame needs, typed as JSON. It is read before anything is sent, and the dialog stays
 * open, with what was typed, until the job has started: a check that isn't an object, or one the
 * server refuses, says why under the field.
 */
export function CheckDialog({ runId, line, command = null, cost = { price: 'Billed by your provider', parts: [probesPart()] }, onClose, onRun }: { runId: string; line: string | null; /** A capture's, which it runs the blame with. */ command?: string | null; cost?: CostLineProps; onClose: () => void; onRun: (expect: Record<string, unknown>) => Promise<string | null> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const check = parseCheck(value);
    if ('error' in check) {
      setError(check.error);
      return false;
    }
    // What it starts closes it, or asks in its place; it stays only for what it says here.
    return onRun(check.expect).then((refused) => {
      if (refused) setError(refused);
      return false;
    });
  };
  return (
    <Dialog
      title={namedIn(`${ACTIONS.runBlame.label} on ${shortId(runId)}`, shortId(runId))}
      lead="Finds the model call that lost the run."
      doc="blame"
      warn={line ? { text: line } : null}
      command={`shadowlap blame ${shortId(runId)} --expect ${value.trim() ? `'${value.trim().replace(/'/g, `'\\''`)}'` : `'<check>'`}${command ? ` -- ${command}` : ''}`}
      cost={cost}
      ok={ACTIONS.runBlame.label}
      okDisabled={!value.trim()}
      onOk={submit}
      onClose={onClose}
    >
      <div className="form one">
        <label>
          Check (JSON)
          <textarea
            value={value}
            placeholder='{"tools":{"send_email":1}}'
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                pressWayOn(e.currentTarget);
              }
            }}
          />
        </label>
      </div>
      <Copy className="muted fieldhint">What a passing run must do, as an outcome check’s expect object</Copy>
      {error ? (
        <p className="fieldnote err" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
