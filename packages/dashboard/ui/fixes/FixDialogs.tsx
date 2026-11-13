import { useEffect, useState } from 'react';
import { CodeBox } from '../components/CodeBox.js';
import { Dialog } from '../components/Dialog.js';
import { DialogSteps, DialogTip } from '../components/DialogFacts.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import type { FixDetail } from '../types.js';
import { copiedTo, GoldenNameFields, nameFields, nameFlags, useGoldenNames } from './ApplyNames.js';
import { applySteps, keepsOf, markLead, PULLED_LINE, repairCost } from './dialog-words.js';
import { OLD_BLAME_REPAIR, useFixEstimates } from './estimates.js';
import { patchLines, repairAsk, repairAside, shortFixId } from './model.js';

/**
 * The dialogs a fix's Run repair, Show patch and Apply fix ask in, on the fix's page and on a list
 * row that leads with the fix (LeadDialog.tsx): apart from the page, so a row's dialog loads none of
 * the page's steps.
 */

/**
 * Asks before a repair, naming who is asked for candidates: the repairer shadowlap.config.json names,
 * read again as the dialog opens (the config can change while the page stays open), and sent with
 * the job, which the server refuses if the config names another by then. One that can't be asked
 * from here (claude isn't on the PATH) is said instead, with what to do, and nothing can start.
 */
export function RepairDialog({ fix, onClose, onRun }: { fix: FixDetail; onClose: () => void; onRun: (repairer: string, sent: Record<string, unknown>) => boolean }) {
  const { client } = useApp();
  const [fresh, setFresh] = useState<{ fix: FixDetail | null } | null>(null);
  useEffect(() => {
    let live = true;
    client.fix(fix.fixId).then(
      (d) => {
        if (live) setFresh({ fix: d });
      },
      () => {
        if (live) setFresh({ fix: null });
      },
    );
    return () => {
      live = false;
    };
  }, [client, fix.fixId]);
  const ask = repairAsk(fix, fresh);
  const now = fresh?.fix ?? fix;
  // Priced again for the fix as it re-read it, so the repairer priced is the one it names.
  const estimate = useFixEstimates(now)?.repair;
  const aside = repairAside(now);
  const repair = now.actions.repair;
  const stopped = now.actions.blameAgain?.kind === 'stopped';
  const keeps = repair ? keepsOf(repair.argv) : [];
  // A line is one sentence with no stop; the engine's own sentence keeps it where the terminal UI shows it.
  const line = ask.why?.replace(/\.$/, '') ?? aside ?? (now.blame?.oldCheck ? OLD_BLAME_REPAIR : stopped ? 'Blame stopped part way: repair blames the run again first' : null);
  // While it reads, what it is doing; then who it asks, or "the repairer" where it can't ask one from here.
  const lead = fresh ? `Asks ${ask.who ?? 'the repairer'} for prompt and tool rewrites and picks the smallest that fixes the failing runs.` : 'Reading which repairer shadowlap.config.json names…';
  return (
    <Dialog
      title={ACTIONS.runRepair.label}
      lead={lead}
      {...(fresh ? { doc: 'repair' as const } : {})}
      warn={line ? { text: line } : null}
      // A repair that ends "No fix to try" runs nothing, so none of what a repair does is said.
      facts={
        ask.why || aside
          ? []
          : [
              { label: 'Changes', value: 'nothing in your working tree', quiet: 'each candidate is tried in a worktree of its own' },
              { label: 'Hands over', value: 'the accepted one, as a patch for you to apply' },
              keeps.length ? { label: <DialogTip title="Keeps" tip="A candidate that breaks a good run is rejected">Keeps</DialogTip>, value: `${keeps.map((k) => `\`${k}\``).join(', ')} passing` } : null,
              { label: 'While it runs', value: 'leave the prompt and tools alone' },
            ]
      }
      command={ask.command}
      cost={repair && (!ask.why || repair.noFixWhy) ? { ...repairCost(repair, stopped), estimate } : null}
      ok={ACTIONS.runRepair.label}
      okDisabled={!ask.ready}
      onClose={onClose}
      onOk={() => (ask.ready && ask.repairer ? onRun(ask.repairer, sentEstimate(estimate)) : false)}
    />
  );
}

/** An applied fix's patch, to read: what went into the working tree, and where it is kept. */
export function PatchDialog({ fix, diff, onClose }: { fix: FixDetail; diff: string; onClose: () => void }) {
  const file = fix.actions.apply?.patchFile;
  return (
    <Dialog title="Show patch" lead={fix.rung === 'merged' ? `The fix as repair handed it over, on main since ${fix.pr?.number == null ? 'its pull request' : `PR #${fix.pr.number}`} merged.` : 'The fix as repair handed it over, in your working tree since you applied it.'} doc="repairHandover" facts={file ? [{ label: 'Path', value: <code>{file}</code>, wide: true }] : []} onClose={onClose}>
      <CodeBox lines={patchLines(diff)} className="fxpatch" />
    </Dialog>
  );
}

/**
 * Asks before applying: Apply fix with the patch and every file it changes, Mark fix applied for a
 * patch in the working tree already (or none to apply), Finish applying fix for what an apply left
 * undone. Each that copies goldens asks each its name under the rest (ApplyNames.tsx), and sends
 * them with the job; it waits until each will do.
 */
export function ApplyDialog({ fix, label, onClose, onRun }: { fix: FixDetail; label: string; onClose: () => void; onRun: (names: Record<string, string> | null) => boolean }) {
  const apply = fix.actions.apply!;
  const names = useGoldenNames(apply);
  const asks = { command: `shadowlap fix apply ${shortFixId(fix.fixId)}${nameFlags(names)}`, ok: label, okDisabled: !!names.problem, onOk: () => onRun(nameFields(names)), onClose, doc: 'repairHandover' as const };
  const fields = <GoldenNameFields names={names} />;
  // No patch to apply: verified on the working tree as it is, or its patch is there already.
  if (apply.kind === 'mark' || (apply.inTree && !fix.actions.applied))
    return (
      <Dialog {...asks} title={apply.inTree && apply.goldens ? 'Mark fix applied?' : 'Mark fix applied'} lead={markLead(apply)} facts={apply.pulled ? [{ label: 'Recordings', value: 'stay on the machine that ran the repair' }] : []}>
        {fields}
      </Dialog>
    );
  if (fix.actions.applied)
    return (
      <Dialog {...asks} title="Finish applying fix?" lead="Finishes what applying the fix left undone." facts={[{ label: 'Left', value: apply.pending ?? 'nothing' }]}>
        {fields}
      </Dialog>
    );
  // What goes in is what is shown: the patch itself, with every file it changes named.
  return (
    <Dialog {...asks} title={`${confirmWords(ACTIONS.applyFix.label)}?`} lead="Applies the fix to your working tree, for you to review before you commit." warn={apply.pulled ? { text: PULLED_LINE } : null}>
      {/* What the fields name, once the goldens folder was read; else every recording, as far as the page knows. */}
      <DialogSteps steps={applySteps(apply, { count: apply.held ? names.offered.length : apply.goldens, to: copiedTo(names) })} />
      {apply.diff ? (
        <CodeBox lines={patchLines(apply.diff)} className="fxpatch" />
      ) : null}
      {fields}
    </Dialog>
  );
}
