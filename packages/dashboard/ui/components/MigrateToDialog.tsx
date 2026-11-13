import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { MigrateEstimateView } from '../estimates-api.js';
import { migrateCommand, type MigrateSwitch } from '../migrate-command.js';
import { Dialog } from './Dialog.js';

/**
 * Migrate to a model's one ask (MigrateDialog.tsx presses it): title, lead, Writes and Preview, the
 * command, the cost line and Migrate to <model>. A part of its own (pages/served.tsx), loaded the
 * first time a press asks: an exported copy, which runs no job, never draws it.
 */
export function MigrateToDialog({ s, estimate, preview, onOk, onClose }: { s: MigrateSwitch; estimate: Estimate | null | undefined; preview: MigrateEstimateView['preview']; onOk: () => unknown; onClose: () => void }) {
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
      command={migrateCommand(s)}
      cost={{ price: 'Billed by your provider', estimate }}
      ok={`Migrate to ${s.to}`}
      onOk={onOk}
      onClose={onClose}
    />
  );
}
