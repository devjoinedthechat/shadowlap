import { useId, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { BisectRevision, DivergenceView, TestsView } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import { JobButton } from '../components/JobButton.js';
import { DialogSteps } from '../components/DialogFacts.js';
import { COMMIT_NAME, GoodCommitField } from '../components/GoodCommit.js';
import { namedIn } from '../components/Id.js';
import { UpdateGoldenDialog } from '../components/UpdateGolden.js';
import { commandText, revisionChoices } from '../goldens.js';
import { updatePlan, type UpdatePlan } from '../update-plan.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { useBisectEstimate } from '../runspage/bisect-estimate.js';
import { bisectCost } from '../runspage/find-commit.js';
import { sentEstimate } from '../spending.js';
import { bisectCard } from './tests-cards.js';

/**
 * The Tests screen's dialogs: Update golden (one or several), Find the commit when it needs a good
 * commit or costs tokens, and Add normalizer when the rule alone can't make the replay match, so the
 * golden is updated after it.
 */

/**
 * Update golden, or Update goldens for every diverged one. `has` says which jobs the server runs;
 * `onInstead` runs the lime way on beside Update anyway, when there is one.
 */
export function UpdateGoldensDialog({ view, paths, has, estimate, onUpdate, onInstead, onClose }: { view: TestsView; paths: string[]; has: (kind: string) => boolean; estimate?: Estimate | null | undefined; onUpdate: () => unknown; onInstead: (instead: NonNullable<UpdatePlan['instead']>) => unknown; onClose: () => void }) {
  const plan = updatePlan(view, paths, has);
  return <UpdateGoldenDialog plan={plan} estimate={estimate} onUpdate={onUpdate} {...(plan.instead ? { onInstead: () => onInstead(plan.instead!) } : {})} onClose={onClose} />;
}

/**
 * Find breaking commit for a golden when it can't just start: no revision where it passed under today's
 * checks is known, or a search from it (`tried`) named no first bad commit, so it asks for a commit
 * where it worked, offering the commits the golden was tested at, starting on an older one than
 * `tried`; or the golden may fork, so each replay runs live from where it forks, which its cost line
 * says first. With a `range` there is nothing to ask: it says the two commits.
 */
export function FindCommitDialog({ name, golden, range, live, revisions, tried, onRun, onClose }: { name: string; golden: string; range: { good: string; bad: string | null } | null; live: boolean; revisions: readonly BisectRevision[]; tried: string | null; onRun: (fields: Record<string, unknown>) => unknown; onClose: () => void }) {
  const choices = revisionChoices(revisions, tried);
  const id = useId();
  const [picked, setPicked] = useState(choices.initial);
  const [typed, setTyped] = useState('');
  const rev = range ? range.good : typed.trim() || picked;
  const args = ['bisect', golden, '--good', rev || '<commit>', ...(range?.bad ? ['--bad', range.bad] : [])];
  // The search's estimate from the commit given, once it has rested: the job keeps the last one shown.
  const estimate = useBisectEstimate({ golden, good: rev, ...(range?.bad ? { bad: range.bad } : {}) });
  return (
    <Dialog
      title={namedIn(`Find breaking commit for ${name}`, name)}
      lead={`Finds the first commit that broke ${name}, from ${tried ? 'an older one' : 'one'} where it worked.`}
      doc="bisect"
      facts={[range ? { label: 'Good', value: `\`${range.good}\``, wide: true } : null, { label: 'Bad', value: `\`${range?.bad ?? 'HEAD'}\``, quiet: range?.bad ? 'the commit the last test session ran at' : 'this checkout as it stands' }]}
      command={commandText(args)}
      cost={{ ...bisectCost({ fork: false, live }), estimate }}
      ok={confirmWords(ACTIONS.findBreakingCommit.label)}
      okDisabled={!COMMIT_NAME.test(rev)}
      onOk={() => onRun({ good: rev, ...(range?.bad ? { bad: range.bad } : {}), ...sentEstimate(estimate) })}
      onClose={onClose}
    >
      {range ? null : <GoodCommitField id={id} choices={choices.options} picked={picked} typed={typed} onPick={setPicked} onType={setTyped} />}
    </Dialog>
  );
}

/**
 * Find breaking commit under a golden's report. Over a range it replays offline it starts on the press,
 * billing nothing; where it asks for a commit it opens its dialog. For a golden marked fork it is a
 * form, its card the search's estimate from the commit its dialog opens on (`GET /api/estimates/bisect`).
 */
export function FindCommitButton({ f, live, why, onBisect }: { f: Pick<DivergenceView, 'golden' | 'bisect' | 'missed' | 'revisions'>; live: boolean; why: string | null | undefined; onBisect: () => void }) {
  const range = f.missed ? null : f.bisect;
  const good = range ? range.good : revisionChoices(f.revisions, f.missed?.good ?? null).initial;
  const estimate = useBisectEstimate(live ? { golden: f.golden, good, ...(range?.bad ? { bad: range.bad } : {}) } : { good: '' });
  return (
    <JobButton className="btn" why={why} {...bisectCard(f, live)} {...(live ? { form: true, estimate } : { bills: false })} start={onBisect} ask={onBisect}>
      {live || !range ? ACTIONS.findBreakingCommit.label : confirmWords(ACTIONS.findBreakingCommit.label)}
    </JobButton>
  );
}

/**
 * Add normalizer when the rules alone can't make the replay match (the request carries a field the
 * recording never had, or more changed): the rules are added, then the golden is updated, which
 * re-records it live. It asks first, as Update golden does, with each command.
 */
export function NormalizeUpdateDialog({ name, steps, estimate, onRun, onClose }: { name: string; steps: string[][]; estimate?: Estimate | null | undefined; onRun: () => unknown; onClose: () => void }) {
  return (
    <Dialog
      title={`${ACTIONS.addNormalizerAndUpdate.label} ${name}?`}
      lead={`Masks the value, then re-records ${name}, for a change you meant.`}
      doc="goldenUpdates"
      command={{ command: steps.map((s) => commandText(s)) }}
      cost={{ price: 'Billed by your provider', parts: ['as its recording cost'], estimate }}
      ok={ACTIONS.addNormalizerAndUpdate.label}
      onOk={onRun}
      onClose={onClose}
    >
      <DialogSteps
        steps={[
          { what: 'Normalizer added', where: 'shadowlap.config.json' },
          { what: 'Re-recorded live', where: 'writes stubbed' },
          { what: 'Replaced only if its checks pass', where: 'in your working tree' },
          { what: 'You review the change', where: 'in your pull request' },
        ]}
      />
    </Dialog>
  );
}
