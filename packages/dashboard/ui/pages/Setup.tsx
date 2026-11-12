import { useState } from 'react';
import { ConfirmDialog } from '../components/Dialog.js';
import { Eyebrow, PageHeader, StepList } from '../components/bits.js';
import { ErrorState, failedRead, Skeleton } from '../components/States.js';
import { Page } from '../components/Page.js';
import { RECORD_PART } from '../../../engine/src/cost-words.js';
import { headingRef } from '../focus-manager.js';
import type { RecordConfirmation, SetupView } from '../projects-api.js';
import { setupPageShows } from '../projects.js';
import { RemoveProjectDialog } from '../shell/RemoveProject.js';
import { useTestsWait, useTreeBusy } from '../fixes/tree.js';
import { useApp } from '../state.js';
import { NotFoundPage } from './NotFound.js';
import { NoRunsSteps, setupSteps } from './no-runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { SETUP_INTRO } from '../../src/setup-words.js';
import { ActionButton } from '../components/ActionButton.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { useSetupFollow, useSetupJobs, useSetupView } from './setup-jobs.js';
import { SetupSteps } from './setup-steps.js';

export { keepAsk } from './setup-jobs.js';

/**
 * Setting a project up (#/setup, and the Overview of a project with no runs or mid-setup; every page
 * of one that can't be opened says so instead): four steps, each with the CLI command it runs.
 * Inspect runs `init` and shows what it found, flagging tools that aren't wrapped with the code to
 * wrap them; Record runs the editable command after asking the first time, then streams the run in;
 * Calibrate runs calibrate and adds what it proposes; Pack packs the run as a golden and tests it,
 * in one job (`pack-test`), and runs the test again once it is packed. The server's read model
 * (`setupView`) says what each step shows; this page runs the jobs and follows them (setup-jobs.ts),
 * and draws the steps (setup-steps.tsx).
 */

/** `asked`: opened at #/setup, rather than shown in place of a page; a project with nothing to set up says so there. */
export function SetupPage({ asked = false }: { asked?: boolean } = {}) {
  const { meta, runs, actionsOff } = useApp();
  const { view, failed, load, start } = useSetupView();
  const jobs = useSetupJobs(view, start);
  useSetupFollow(view);
  // Recording, calibrating and testing run the agent from the project's working tree: not while a repair or an apply changes it.
  const treeBusy = useTreeBusy('reads', 'run this step');
  // Pack as golden runs the golden's test as well: not while another test job runs here either, as the server refuses it.
  const testsWait = useTestsWait('run this step');

  const problem = meta?.project?.id && meta.project.problem ? meta.project : null;
  if (problem) return <ProjectProblem id={problem.id!} name={problem.name} problem={problem.problem!} />;

  const shows = setupPageShows({ meta, view, runs });
  // No setup to follow (a dashboard that serves one store): with runs, nothing to set up here; without, the steps and their commands.
  if (shows === 'nothing') return <NotFoundPage kind="setup" />;
  if (shows === 'steps') return <NoRunsSteps />;
  if (shows === 'wait' || !view) return <SetupWaiting failed={failed} retry={load} />;

  // #/setup on a project that is set up: nothing to do here, as the mock says.
  if (asked && view.shows === 'none') return <NotFoundPage kind="setup" />;

  const off = actionsOff;
  return (
    <Page>
      <SetupHeader view={view} onSkip={off ? null : jobs.finish} />
      {/* One part of the page (a section with an id): a step's job hands the focus on inside it, as the page follows. */}
      <section id="setup" aria-label="Steps">
        <SetupSteps view={view} jobs={jobs} off={off} treeBusy={treeBusy} testsWait={testsWait} />
        {view.done ? (
          <VerdictLine
            word={view.done.word}
            tone="ok"
            className="sdone"
            facts={view.done.text}
            actions={
              <ActionButton className="btn lime" why={off} onClick={jobs.finish}>
                {view.done.button.label}
              </ActionButton>
            }
          >
            {view.done.title}
          </VerdictLine>
        ) : null}
      </section>
      {jobs.asking ? <RecordRunDialog confirm={jobs.asking.confirm} onClose={jobs.closeAsking} onOk={jobs.confirmAsking} /> : null}
    </Page>
  );
}

/**
 * The setup still loading: its header as the meta gives it, over the four steps in their final
 * shape as quiet bars; or, where the read failed, the header and the error line with Retry.
 */
function SetupWaiting({ failed, retry }: { failed: Error | null; retry: () => void }) {
  const { meta } = useApp();
  const name = projectOf(meta)?.name ?? 'this project';
  const path = meta?.project?.display;
  return (
    <Page busy={!failed}>
      <PageHeader
        eyebrow={
          <>
            {name}
            {path ? (
              <>
                {' · '}
                <code>{path}</code>
              </>
            ) : null}
          </>
        }
        title={`Set up ${name}`}
        text={SETUP_INTRO}
      />
      {failed ? (
        <ErrorState retry={retry}>{failedRead(failed)}</ErrorState>
      ) : (
        <Skeleton what="the setup">
          <StepList steps={setupSteps()} />
        </Skeleton>
      )}
    </Page>
  );
}

/** What asks before a command's first run in a folder, or when its model calls moved. */
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

/**
 * A project whose store can't be opened (its folder is gone, or the store is from a newer
 * Shadowlap): what is wrong, in place of a setup it couldn't run, and Remove. The switcher still
 * works, and once the folder is back the project's pages come back with it.
 */
function ProjectProblem({ id, name, problem }: { id: string; name: string; problem: string }) {
  return (
    <Page>
      <ProblemHeader id={id} name={name} problem={problem} />
    </Page>
  );
}

/**
 * Why a project can't be opened (its folder is gone, its store is a newer Shadowlap's), as the
 * page's header, with Remove project…: on its setup in place of every page, and on Settings
 * above its tabs, which it can still show.
 */
export function ProblemHeader({ id, name, problem }: { id: string; name: string; problem: string }) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow={name}
        title={`Can’t open ${name}`}
        text={problem}
        copy={false}
        actions={
          <ActionButton className="btn" onClick={() => setRemoving(true)}>
            Remove project…
          </ActionButton>
        }
      />
      {removing ? <RemoveProjectDialog id={id} onClose={() => setRemoving(false)} /> : null}
    </>
  );
}

function SetupHeader({ view, onSkip }: { view: SetupView; onSkip: (() => void) | null }) {
  return (
    <div className="ph">
      <div>
        <Eyebrow>
          {view.project.name} · <code>{view.project.path}</code>
        </Eyebrow>
        <h1 ref={headingRef}>{view.title}</h1>
        <p>{view.intro}</p>
      </div>
      {view.skip ? (
        <div className="actions">
          <ActionButton className="btn quiet" disabled={!onSkip} onClick={() => onSkip?.()}>
            {view.skip.label}
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}

