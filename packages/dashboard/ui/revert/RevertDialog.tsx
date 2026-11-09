import { useState } from 'react';
import { UNTESTED_WORDS } from '../../../engine/src/bisect-words.js';
import { CodeBox } from '../components/CodeBox.js';
import { ConsentDialog, Dialog } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { goldenName } from '../format.js';
import { shortDate } from '../goldens.js';
import { ACTIONS } from '../labels.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { liveFacts } from '../tests-ask.js';
import type { Price } from '../tests-estimates.js';
import type { FoundCommit, NextStep } from '../types.js';
import { outsideWords, revertedLines } from './model.js';
import { startRevert, type CommandAsk } from './start.js';

/** What Revert's dialog is about: the golden's step, the commit as Find breaking commit named it, what the test after it bills, and the run it leads from. */
export interface RevertDialogProps {
  step: Extract<NextStep, { key: 'revert' }>;
  found: FoundCommit | null;
  /** Re-run test's price on the run page, Tests' `rerun` estimate elsewhere: undefined while it is read. */
  estimate: Price;
  runId: string | null;
  onClose: () => void;
}

/**
 * Revert <rev>?: what it does to your working tree, the commit (its author only where names are
 * shown), the commits just before it that couldn't be tested, then the test, and why it runs live
 * where it does, in the rows Run tests asks with (liveFacts, from the reasons liveAsk names); the
 * change undone, in a code box, the `$` row and what the test bills. It asks on every setting, since
 * it changes your working tree, and has no docs link: the docs don't cover reverting. It answers the
 * server's question about a test it said runs live; a yes to a command someone else recorded is
 * ConsentDialog's, drawn in its place (start.ts).
 */
export function RevertDialog({ step, found, estimate, runId, onClose }: RevertDialogProps) {
  const app = useApp();
  const [consent, setConsent] = useState<CommandAsk | null>(null);
  const change = found?.change ?? null;
  const live = step.live.length > 0;
  const when = [found?.author, found?.date ? shortDate(found.date) : null].filter(Boolean).join(', ');
  const fields = { golden: step.golden, rev: step.rev, ...(runId ? { runId } : {}), ...sentEstimate(estimate) };
  const asked = { golden: step.golden, rev: step.rev, live: step.live, command: step.command ?? null };
  if (consent) return <ConsentDialog why={consent.why} ok="Run command" onClose={onClose} onOk={() => startRevert(app, { ...fields, yes: consent.confirm }, asked, setConsent)} />;
  return (
    <Dialog
      title={namedIn(`Revert ${step.rev}?`, step.rev)}
      lead="Undoes the commit in your working tree, uncommitted, for you to review."
      warn={change?.outside ? { text: outsideWords(change.outside) } : null}
      facts={[
        found ? { label: 'Commit', value: found.subject || step.rev, ...(when ? { quiet: when } : {}) } : null,
        found?.untested.length ? { label: 'Untested', value: found.untested.join(', '), quiet: UNTESTED_WORDS.row, tone: 'amber' } : null,
        { label: 'Then', value: `\`${goldenName(step.golden)}\` is tested` },
        ...(live ? liveFacts([{ path: step.golden, why: step.live }]) : []),
      ]}
      command={step.command ?? null}
      cost={{ price: live ? 'Billed by your provider' : 'Free', parts: live ? [] : ['replays offline'], estimate }}
      ok={ACTIONS.revert.label}
      onClose={onClose}
      onOk={() => startRevert(app, fields, asked, setConsent)}
    >
      {change?.hunk ? <CodeBox lines={revertedLines(change.hunk)} change /> : null}
    </Dialog>
  );
}
