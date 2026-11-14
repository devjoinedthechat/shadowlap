import { RECORD_PART } from '../../../engine/src/cost-words.js';
import type { RecordConfirmation } from '../projects-api.js';
import { ConfirmDialog } from './Dialog.js';

/**
 * What asks before a command's first run in a folder, or when its model calls moved: the setup's
 * Record run and Runs' Record run… alike, in the words the server plans it with (`planRecording`).
 */
export function RecordRunDialog({ confirm, onOk, onClose }: { confirm: RecordConfirmation; onOk: () => unknown; onClose: () => void }) {
  return (
    <ConfirmDialog
      title={confirm.title}
      lead={confirm.lead}
      doc="quickstart"
      warn={confirm.moved ? { text: confirm.moved } : null}
      facts={[
        { label: 'Command', value: 'yours, run once', quiet: 'through a local sidecar' },
        { label: 'Calls', ...confirm.calls },
      ]}
      ok={confirm.button}
      command={confirm.command}
      cost={{ price: 'Billed by your provider', parts: [RECORD_PART] }}
      onClose={onClose}
      onOk={onOk}
    />
  );
}
