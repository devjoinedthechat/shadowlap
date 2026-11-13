import { Dialog } from '../components/Dialog.js';
import { DialogSteps, inCode } from '../components/DialogFacts.js';
import { goldenName } from '../format.js';
import { ACTIONS } from '../labels.js';
import type { MigrateApplyOffer, MigrateView } from '../types.js';
import { Patch } from './Patch.js';

/**
 * Apply config change?: what it does in steps, what it leaves out, the patch, the goldens left behind
 * (else why none diverges), and the command. A part of its own (pages/served.tsx), loaded the first
 * time the Migrate report's Apply config change asks: it opens on that press alone, and an exported
 * copy, which runs no job, never draws it.
 */
export function ApplyConfigDialog({ m, offer, onOk, onClose }: { m: MigrateView; offer: MigrateApplyOffer; onOk: () => void; onClose: () => void }) {
  const behind = offer.leftBehind;
  const one = behind.length === 1;
  const steps = [
    { what: 'Patch applied', where: <>{inCode(offer.files.map((f) => `\`${f}\``).join(', '))}, with git apply</> },
    { what: 'Goldens replayed', where: 'offline, any that diverge are named' },
    ...(behind.length ? [{ what: 'Update goldens next', where: `to re-record ${one ? 'it' : 'them'} under ${m.to}` }] : []),
  ];
  return (
    <Dialog
      title={`${ACTIONS.applyConfigChange.label}?`}
      lead="Applies the migration’s config change to your working tree, for you to review before you commit."
      doc="migrate"
      facts={[
        offer.leftOut ? { label: 'Leaves out', value: inCode(offer.leftOut), quiet: 'as What to set says' } : null,
        // The goldens left behind are listed under the patch; with none, why each stays as recorded.
        behind.length ? null : { label: 'Diverges', value: 'no golden', quiet: offer.stays ?? undefined },
      ]}
      command={offer.command}
      ok={ACTIONS.applyConfigChange.label}
      onOk={onOk}
      onClose={onClose}
    >
      <DialogSteps steps={steps} />
      {m.config.patch ? <Patch text={m.config.patch} /> : null}
      {behind.length ? (
        <div className="ondisk">
          <span className="k">Left behind</span>
          <ul className="plain">
            {behind.map((g) => (
              <li key={g.golden}>
                <i aria-hidden="true" />
                <span>{goldenName(g.golden)}</span>
                <code>{`#${g.callNo} · $.model`}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  );
}
