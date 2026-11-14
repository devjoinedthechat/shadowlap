import { useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { stopAt } from '../../src/decisions-argv.js';
import type { MigrateEstimateView } from '../estimates-api.js';
import { migrateCommand, type MigrateSwitch } from '../migrate-command.js';
import { sentEstimate } from '../spending.js';
import { Dialog } from './Dialog.js';
import { useMigrateEstimate } from './MigrateDialog.js';

/** Why Migrate waits on what its Stop at $ holds. */
const NO_AMOUNT = 'Stop at $ is an amount in dollars above 0, such as 2.00';

/**
 * Migrate to a model's one ask (MigrateDialog.tsx presses it): title, lead, Writes and Preview, its
 * Scope where the runs' calls were made in more than one, Stop at $, the command, the cost line and
 * Migrate to <model>. What it bills is what its press priced until a field narrows it, then read
 * again for the scope and Stop at $ picked; its way on sends them, with that estimate. A part of its
 * own (pages/served.tsx), loaded the first time a press asks: an exported copy, which runs no job,
 * never draws it.
 */
export function MigrateToDialog({ s, estimate, preview, onOk, onClose }: { s: MigrateSwitch; estimate: Estimate | null | undefined; preview: MigrateEstimateView['preview']; onOk: (more: Record<string, unknown>) => unknown; onClose: () => void }) {
  const [scope, setScope] = useState('');
  const [budget, setBudget] = useState('');
  const stops = stopAt(budget);
  const narrow = { ...(scope ? { scope } : {}), ...(stops ? { budget: stops } : {}) };
  const narrowed: MigrateSwitch = { ...s, ...narrow };
  const read = useMigrateEstimate(narrowed);
  // Narrowed, only its own read prices it; else what its press priced, until its read comes.
  const priced = scope || stops ? read.estimate : (read.estimate ?? estimate);
  const was = s.from.join(', ') || 'the recorded model';
  return (
    <Dialog
      title={`Migrate ${was} to ${s.to}`}
      lead={`Asks ${was}’s calls again under ${s.to}, then verifies end to end the runs the preview can’t clear.`}
      doc="migrate"
      facts={[
        { label: 'Writes', value: 'a config change and a pull request body, beside the store', quiet: 'your files stay as they are' },
        preview ? { label: 'Preview', value: <><code>{preview.sessionId.slice(0, 13)}</code> asked these already</>, quiet: `migrate asks${preview.verified ? ' and verifies' : ''} again, its answers not reused` } : null,
      ]}
      command={migrateCommand(narrowed)}
      cost={{ price: 'Billed by your provider', estimate: priced }}
      ok={`Migrate to ${s.to}`}
      okWhy={budget.trim() && stops === null ? NO_AMOUNT : null}
      onOk={() => onOk({ ...narrow, ...sentEstimate(priced) })}
      onClose={onClose}
    >
      <div className="form">
        {read.scopes.length > 1 ? (
          <label>
            Scope
            <select value={scope} onChange={(e) => setScope(e.currentTarget.value)}>
              <option value="">every scope</option>
              {read.scopes.map((x) => (
                <option key={x.scope ?? ''} value={x.scope ?? 'none'}>
                  {x.scope ?? 'calls in no scope'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Stop at $
          <input type="number" min={0.01} step={0.5} placeholder="none" value={budget} onChange={(e) => setBudget(e.currentTarget.value)} />
        </label>
      </div>
    </Dialog>
  );
}
