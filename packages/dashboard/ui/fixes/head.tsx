import { useLayoutEffect, useRef, type RefObject } from 'react';
import { JOB_KINDS } from '../api.js';
import { DotNodes } from '../components/DotParts.js';
import { ACTIONS } from '../labels.js';
import { href } from '../route.js';
import type { FixDetail, JobListItem, StepKey } from '../types.js';
import { pluralS as s } from '../../../engine/src/words.js';
import { sameCount } from './model.js';
import { isStepJob } from './page-fix.js';
import { Flagged } from './parts.js';
import { STEP_NAMES } from './row-scope.js';
import { useServerJobs } from './tree.js';

/**
 * A fix's header and stepper, as the design's pagePit() draws them: the header stacking where its
 * buttons would crowd the title, and each step's dot, word and title, the one a job of the fix runs
 * pulsing with what it is doing. Only the Fixes chunk loads it.
 */

/**
 * The fix's header, fitted as the design's fitFixHead() fits it: at 1280px and below its CSS always
 * stacks it (the title and its lines across the page, then the buttons, the lime one first); wider,
 * it stacks only where the buttons would leave the title less than 520px. Fitted again on every
 * render, as the buttons change, and as the window does. A page rendered with no layout (a test's)
 * fits nothing.
 */
export function useFitFixHead(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (typeof innerWidth !== 'number') return;
    const h = ref.current;
    if (!h) return;
    const fit = () => {
      h.classList.remove('stack');
      const left = h.firstElementChild;
      if (innerWidth > 1280 && left && left.getBoundingClientRect().width < 520) h.classList.add('stack');
    };
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  });
  return ref;
}

/** What a step says while a job of its fix runs it: the job's own word, and a line on what it does. */
export interface RunningStep {
  key: StepKey;
  title: string;
  meta: string;
}

/** A verify job's line, by what it settles: more attempts up to the limit the verdict's own step names, the same runs again, or the runs no accepted verdict checked. */
function verifyingLine(fix: Pick<FixDetail, 'actions' | 'verify'>, title: string | undefined): string {
  if (title === ACTIONS.runMoreAttempts.doing) {
    const max = fix.verify.find((v) => v.more?.kind === 'more')?.more?.max;
    return max ? `up to ${max} attempts a run` : '';
  }
  if (title === ACTIONS.verifyAgain.doing) return 'the same runs, once the judge answers';
  const n = fix.actions.verifyLeft?.runs.length ?? 1;
  return `the run${s(n)} it wasn’t verified on`;
}

/**
 * The step a job of the fix runs, as the stepper says it while it runs, or null: the job's title (its
 * button's doing word, `ACTIONS`) and an ellipsis, but Verifying… for every verify, as the Fixes row
 * says verifying… for each; the line under it from the job and the fix (the model a stronger blame
 * asks, from its command; the attempts a run Run more attempts goes up to), never sample words.
 */
export function runningStep(fix: Pick<FixDetail, 'fixId' | 'actions' | 'verify'>, jobs: readonly Pick<JobListItem, 'done' | 'fixId' | 'kind' | 'title' | 'args'>[]): RunningStep | null {
  const job = jobs.find((j) => !j.done && j.fixId === fix.fixId && isStepJob(j.kind));
  if (!job) return null;
  if (job.kind === JOB_KINDS.repair) return { key: 'repair', title: `${ACTIONS.runRepair.doing}…`, meta: 'trying candidates, each in a worktree of its own' };
  if (job.kind === JOB_KINDS.verify) return { key: 'verify', title: `${ACTIONS.runVerify.doing}…`, meta: verifyingLine(fix, job.title) };
  const title = job.title ?? ACTIONS.runBlame.doing;
  if (title === ACTIONS.runBlameStronger.doing) {
    const at = job.args.indexOf('--model');
    const model = at >= 0 ? job.args[at + 1] : undefined;
    return { key: 'blame', title: `${title}…`, meta: model ? `${model} answers from the probed call` : '' };
  }
  const again = title === ACTIONS.runBlameAgain.doing ? fix.actions.blameAgain : null;
  return { key: 'blame', title: `${title}…`, meta: again ? (again.underCheck ? 'under the fix’s check' : again.kind === 'stopped' ? 'from the first model call' : again.gate || !again.count ? 'at a lower bar' : `with ${sameCount(again.count)}`) : '' };
}

/**
 * The stepper: Blame, Repair and Verify, each its dot, its word in the UI face and its title; Verify's
 * dot lime once it is done; the step a job of the fix runs pulsing, said as it runs (`runningStep`).
 */
export function FixStepper({ fix, current }: { fix: FixDetail; current: StepKey }) {
  const running = runningStep(fix, useServerJobs());
  return (
    <nav className="stepper" aria-label="Steps">
      {fix.steps.map((x) => {
        const busy = running?.key === x.key ? running : null;
        return (
          <a key={x.key} className={`${busy ? 'busy' : x.state} s-${x.key}`} href={href.fixes(fix.fixId, x.key)} aria-current={x.key === current ? 'step' : undefined}>
            <span className="k">
              <i />
              {STEP_NAMES[x.key]}
            </span>
            <b>{busy ? busy.title : x.title}</b>
            <span className="m">{busy ? busy.meta : <StepMeta text={x.meta} />}</span>
          </a>
        );
      })}
    </nav>
  );
}

/** A step's line as dot parts, each of 32 characters or fewer kept whole ("candidate 3 of 3", "proposed by claude-code"), a flag in its part set as code. */
function StepMeta({ text }: { text: string }) {
  return text ? <DotNodes max={32} parts={text.split(' · ').map((t) => ({ text: t, node: <Flagged text={t} /> }))} /> : null;
}

/** Show patch's card: the patch in the working tree once applied, its goldens where they are; on main once merged with its pull request. */
export function showPatchCard(fix: Pick<FixDetail, 'rung' | 'actions'>): string {
  if (!fix.actions.applied && fix.rung === 'merged') return 'Merged: the patch is on main with its pull request';
  return fix.actions.apply?.pulled ? 'Applied: the patch is in the working tree; its goldens are on the machine that ran the repair' : 'Applied: the patch is in the working tree and its goldens pass';
}

/** Run repair's wait after a repair whose gate rejected every candidate, and its card: running it again would try the same, so its way out is Edit check…. */
export const REPAIR_SPENT = { why: 'Repair rejected every candidate', tip: 'Nothing has changed since its last repair, whose gate rejected every candidate: edit the check, or verify a change of your own' } as const;
