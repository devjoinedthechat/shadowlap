import { useEffect, useState, type ReactNode } from 'react';
import { JOB_KINDS, type DivergenceView } from '../api.js';
import { PageHeader } from '../components/bits.js';
import { glossed } from '../components/Term.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { Icon } from '../components/Icon.js';
import { JobButton } from '../components/JobButton.js';
import { Page } from '../components/Page.js';
import { treeBusy } from '../fixes/model.js';
import { useServerJobs } from '../fixes/tree.js';
import { asksUpdate, divergenceButtons, findCommitButton, sessionWait, testsBusy } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { sentEstimate } from '../spending.js';
import { useApp } from '../state.js';
import { divergedAsk, gateAgainAsk, moreAttemptsAsk, runTestsAsk, startTestsJob, type TestsAsk } from '../tests-ask.js';
import { estimatesKey, runPrice, updatesPrice, useTestsEstimates, type Price } from '../tests-estimates.js';
import { keepTests } from '../tests-palette.js';
import { FailurePanel, DivergencePanel, InconclusivePanel } from '../tests/Reports.js';
import { CiSections } from '../tests/Sections.js';
import { TestsEmpty, TestsFailed, TestsLoading } from '../tests/States.js';
import type { GoodCommitsOf } from '../tests/good-commits.js';
import { GoldensTable } from '../tests/Table.js';
import { leadStep } from '../tests/lead.js';
import { Verdict, type LeadPress } from '../tests/Verdict.js';
import { bisectLive, runTestsCard, testsJob, updatesCard } from './tests-cards.js';
import { FindCommitDialog, NormalizeUpdateDialog, UpdateGoldensDialog } from './TestsDialogs.js';

/**
 * Tests (#/tests): every golden CI runs and how it did at each revision. The verdict for the goldens'
 * last results, the table (each golden with its mode and where it came from, its checks marked by
 * how its last result came out, its history and its last result, fitted to its panel's width as the
 * mock's container queries fit it), each failure as the CLI prints it with what fixes it, and how CI
 * runs them: replay goldens offline, those marked fork live from where they fork.
 */

/** The jobs that change what this page shows: while one of this tab's runs, the verdict's session reads as running. */
const TEST_KINDS = new Set<string>([JOB_KINDS.tests, JOB_KINDS.testUpdate, JOB_KINDS.normalizeAndTest]);

type Open =
  | { kind: 'update'; paths: string[]; estimate?: Price }
  | { kind: 'bisect'; name: string; golden: string; range: { good: string; bad: string | null } | null; live: boolean; goods: GoodCommitsOf }
  | { kind: 'normalize-update'; name: string; golden: string; steps: string[][]; estimate?: Price };


export function TestsPage() {
  const app = useApp();
  const { client, tick, feeds, hasKind, actionsOff, guard, jobs, toast, meta } = app;
  // Read again when runs or calls move, when a session of error-path presets starts or ends (that
  // moves only their own count, and the actions wait for one on goldens: `chaosRunning`),
  // and when one of this tab's test jobs starts or ends, so its drawer can end on the step it leaves.
  const running = jobs.some((w) => !w.job.done && !w.lost && TEST_KINDS.has(w.job.kind ?? ''));
  const loaded = useLoad(() => client.tests(), 'tests', `${tick}:${feeds.chaos ?? 0}:${running}`);
  const view = loaded.data;
  const prices = useTestsEstimates(view ? estimatesKey(view) : null, view?.diverged);
  const [open, setOpen] = useState<Open | null>(null);
  // What the server is running, from every tab and terminal dashboard: a test job (Find breaking commit
  // on a golden among them), a test session started in a terminal, or a repair holding the working
  // tree makes it refuse an action that replays or rewrites the goldens.
  const serverJobs = useServerJobs();
  const wait = (verb: string): string | null => actionsOff ?? testsBusy(serverJobs, verb, meta?.project?.id ?? null) ?? sessionWait(view, verb) ?? treeBusy(serverJobs, 'reads', verb, meta?.project?.path ?? null);

  useEffect(() => {
    if (view) keepTests(view);
  }, [view]);

  // Update goldens, asked for by the palette or a link (#/tests?update), on arriving here or while
  // here: the address goes back to #/tests at once, so nothing is left to open the dialog later.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    const take = () => {
      if (!asksUpdate(location.hash)) return;
      navigate(href.tests(), true);
      setAsked(true);
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);
  useEffect(() => {
    if (!asked || !view) return;
    setAsked(false);
    const why = wait('update them');
    if (why) toast(why);
    else if (!view.diverged.length || !hasKind(JOB_KINDS.testUpdate)) toast('No golden diverged: there is nothing to update');
    else setOpen({ kind: 'update', paths: view.diverged });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once: `wait`, new each render, is read as it is when the ask is taken
  }, [asked, view, actionsOff, hasKind, toast]);

  // A job that would run goldens live asks first, in the shell's dialog, saying `ask`'s words around
  // the server's; one that only replays starts on the click (tests-ask.ts).
  const start = (kind: string, fields: Record<string, unknown>, ask?: TestsAsk, e?: Price) => {
    const went = startTestsJob(app, kind, { ...fields, ...sentEstimate(e) }, ask && { ...ask, estimate: e });
    if (went !== false) setOpen(null);
    return went;
  };
  const header = (actions?: ReactNode) => <PageHeader eyebrow={`${projectOf(meta)?.name ?? 'this project'} · goldens`} title="Tests" text={glossed('Every golden CI runs, and how it did at each revision.')} actions={actions} />;

  if (!view || view.empty) {
    return (
      <Page busy={!view && !loaded.error}>
        {header()}
        {view ? <TestsEmpty view={view} runs={app.runs} /> : loaded.error ? <TestsFailed error={loaded.error} retry={loaded.reload} /> : <TestsLoading />}
      </Page>
    );
  }

  const [runWait, updateWait, updateGoldenWait, findWait] = ['run the tests', 'update them', 'update it', 'find the breaking commit'].map((verb) => wait(verb));
  // The first failure's step leads, lime, and Run tests reads plain; none while a session runs every golden.
  const lead = leadStep(view, hasKind, !!view.following?.whole);
  // Settings → CI by the name the mock links it by, its tab opening; Update goldens only for several,
  // as each has its own in its report.
  const actions = (
    <>
      <a className="btn" href={href.settings('ci')}>
        <Icon name="gear" />
        Open CI settings
      </a>
      {view.diverged.length > 1 && hasKind(JOB_KINDS.testUpdate) ? (
        <JobButton className="btn" why={updateWait} {...testsJob(updatesCard(view.diverged), updatesPrice(prices, view.diverged), (e) => guard(() => setOpen({ kind: 'update', paths: view.diverged, estimate: e })))}>
          {ACTIONS.updateGoldens.label}
        </JobButton>
      ) : null}
      {hasKind(JOB_KINDS.tests) ? (
        <JobButton className={lead ? 'btn' : 'btn lime'} why={runWait} {...testsJob(runTestsCard(view), runPrice(prices), (e) => start(JOB_KINDS.tests, {}, runTestsAsk(view), e))}>
          {ACTIONS.runTests.label}
        </JobButton>
      ) : null}
    </>
  );

  const normalize = (d: DivergenceView, e?: Price) => {
    const run = divergenceButtons(d, hasKind).normalize?.run;
    if (run === 'rerun') start(JOB_KINDS.tests, { golden: d.golden }, divergedAsk(view, d.golden, run), e);
    // The rules alone can't make it match: the golden is re-recorded after them, so it asks first.
    else if (run === 'normalize-update' && d.normalizeAndTest) setOpen({ kind: 'normalize-update', name: d.name, golden: d.golden, steps: d.normalizeAndTest, estimate: e });
    else if (run === 'normalize') start(JOB_KINDS.normalizeAndTest, { golden: d.golden }, divergedAsk(view, d.golden, run), e);
  };
  const findCommit = (f: Pick<DivergenceView, 'name' | 'golden' | 'bisect' | 'missed' | 'revisions' | 'untested'>) => {
    // Once a search over the known range named no first bad commit, it asks for an older good one.
    const range = f.missed ? null : f.bisect;
    const live = bisectLive(view, f);
    // Free replays over a known range start at once; a search that needs a good commit, or costs tokens, asks first.
    if (range && !live) start(JOB_KINDS.bisect, { golden: f.golden, good: range.good, ...(range.bad ? { bad: range.bad } : {}) });
    else setOpen({ kind: 'bisect', name: f.name, golden: f.golden, range: range ? { good: range.good, bad: range.bad } : null, live, goods: f });
  };

  const press: LeadPress = {
    wait,
    prices,
    live: (f) => bisectLive(view, f),
    onNormalize: (d, e) => guard(() => normalize(d, e)),
    onUpdate: (golden, e) => guard(() => setOpen({ kind: 'update', paths: [golden], estimate: e })),
    onFind: findCommit,
    onMore: (v, e) => v.gate?.more && start(JOB_KINDS.tests, v.gate.more.job, moreAttemptsAsk(v.name, v.gate.more), e),
    onAgain: (lead, e) => start(JOB_KINDS.tests, { golden: lead.golden }, gateAgainAsk(lead.name, lead.golden), e),
  };

  return (
    <Page>
      {header(actions)}
      <Verdict view={view} running={running} lead={lead} press={press} />
      <GoldensTable view={view} press={press} />
      {view.divergences.map((d) => (
        <DivergencePanel key={d.golden} d={d} has={hasKind} updateLeads={view.steps?.[d.golden]?.key === 'update-golden'} wait={wait} live={bisectLive(view, d)} prices={prices} onNormalize={(e) => guard(() => normalize(d, e))} onUpdate={(e) => guard(() => setOpen({ kind: 'update', paths: [d.golden], estimate: e }))} onFind={() => findCommit(d)} />
      ))}
      {view.failures.map((f) => (
        <FailurePanel key={f.golden} f={f} off={findWait} live={bisectLive(view, f)} button={findCommitButton(f, hasKind)} onBisect={() => findCommit(f)} />
      ))}
      {view.inconclusive.map((v) => (
        <InconclusivePanel
          key={v.golden}
          v={v}
          off={runWait ?? undefined}
          canRun={hasKind(JOB_KINDS.tests)}
          onMore={(job, ask, e) => start(JOB_KINDS.tests, job, ask, e)}
          prices={prices}
          updateOff={updateGoldenWait ?? undefined}
          canUpdate={hasKind(JOB_KINDS.testUpdate)}
          onUpdate={(e) => guard(() => setOpen({ kind: 'update', paths: [v.golden], estimate: e }))}
        />
      ))}
      <CiSections view={view} />
      {/* What it offers instead opens no dialog of its own, though a session that runs a golden live still asks first (tests-ask.ts); several goldens' normalizer and update is the update this dialog asks about. */}
      {open?.kind === 'update' ? (
        <UpdateGoldensDialog
          view={view}
          paths={open.paths}
          has={hasKind}
          estimate={open.estimate}
          onClose={() => setOpen(null)}
          onUpdate={() => start(JOB_KINDS.testUpdate, open.paths.length === 1 ? { golden: open.paths[0] } : { goldens: open.paths }, undefined, open.estimate)}
          onInstead={(i) => (i.run === 'normalize-update-all' ? start(JOB_KINDS.testUpdate, { goldens: i.goldens, normalize: true }, undefined, open.estimate) : start(i.run === 'rerun' ? JOB_KINDS.tests : JOB_KINDS.normalizeAndTest, { golden: i.golden }, divergedAsk(view, i.golden, i.run)))}
        />
      ) : null}
      {open?.kind === 'bisect' ? (
        <FindCommitDialog
          name={open.name}
          golden={open.golden}
          range={open.range}
          live={open.live}
          goods={open.goods}
          onClose={() => setOpen(null)}
          onRun={(fields) => start(JOB_KINDS.bisect, { golden: open.golden, ...fields })}
        />
      ) : null}
      {open?.kind === 'normalize-update' ? <NormalizeUpdateDialog name={open.name} steps={open.steps} estimate={open.estimate} onClose={() => setOpen(null)} onRun={() => start(JOB_KINDS.normalizeAndTest, { golden: open.golden }, divergedAsk(view, open.golden, 'normalize-update'), open.estimate)} /> : null}
    </Page>
  );
}
