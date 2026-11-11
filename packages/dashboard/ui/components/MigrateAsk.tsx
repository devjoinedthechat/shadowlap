import { ConfirmDialog } from './Dialog.js';

/**
 * Migrate to a model's one ask, wherever its step is: a retiring model's row on Needs a look and a
 * preview's next step. What the job asks again and verifies, its command, and that the provider
 * bills it, as nothing prices it yet. `from` are the models it switches from; with none, the
 * recorded model's calls.
 */
export function MigrateAsk({ from, to, command, ok, onOk, onClose }: { from: readonly string[]; to: string; command: string; ok: string; onOk: () => unknown; onClose: () => void }) {
  const was = from.join(', ') || 'the recorded model';
  return <ConfirmDialog title={`Migrate ${was} to ${to}`} lead={`Asks ${was}’s calls again under ${to} and verifies the runs whose decisions change.`} command={command} cost={{ price: 'Billed by your provider', estimate: null }} ok={ok} onOk={onOk} onClose={onClose} />;
}
