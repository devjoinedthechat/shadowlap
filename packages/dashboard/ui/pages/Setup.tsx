import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { JOB_KINDS, type JobView } from '../api.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { Eyebrow, PageHeader, StepList, type Step } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { copyText } from '../dom.js';
import { RECORD_PART } from '../../../engine/src/cost-words.js';
import { headingRef } from '../focus-manager.js';
import { messageOf } from '../../../engine/src/message-of.js';
import type { CalibrateStep, InspectStep, RecordConfirmation, RecordStep, SetupView, TestStep } from '../projects-api.js';
import { RECORD_PLACEHOLDER, aroundRunId, aroundWord, asksForSetup, codeParts, confirmedRecording, liveCalls, recordingLine, setupPageShows, stepClass, terminalLine } from '../projects.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { RemoveProjectDialog } from '../shell/RemoveProject.js';
import { useTestsWait, useTreeBusy } from '../fixes/tree.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import { SETUP_INTRO } from '../../src/setup-words.js';
import { NotFoundPage } from './NotFound.js';
import { ActionButton } from '../components/ActionButton.js';
import { tipEst } from '../spending.js';

/**
 * Setting a project up (#/setup, and in place of the pages of a project with no runs, or of the
 * Overview mid-setup): four steps, each with the CLI command it runs. Inspect runs `init` and shows
 * what it found, flagging tools that aren't wrapped with the code to wrap them; Record runs the
 * editable command after asking the first time, then streams the run in; Make the replay clean runs
 * calibrate and adds what it proposes; Keep it as a test packs the run as a golden and tests it, in
 * one job (`pack-test`), and runs the test again once it is packed. The server's read model
 * (`setupView`) says what each step shows; this page runs the jobs and follows them. A step whose
 * job kind this dashboard doesn't run says so and keeps its command.
 */

/**
 * The four steps with their commands, for a page that can't follow this project's setup (a
 * dashboard that serves one store, the Overview before its summary): from the first, with nothing
 * marked done, since nothing here can tell how far the project got.
 */
export function setupSteps(): Step[] {
  return [
    {
      title: 'Inspect the folder',
      text: 'Finds the model SDKs, the command that starts the agent, and every tool with the effect it declares. It runs nothing.',
      command: 'shadowlap init',
      state: 'cur',
    },
    {
      title: 'Record a first run',
      text: 'Runs your command once with a local sidecar in front of the model API. Model calls go to the real API with your keys, which are never stored.',
      command: `shadowlap run -- ${RECORD_PLACEHOLDER}`,
      state: 'todo',
    },
    {
      title: 'Make the replay clean',
      text: 'Replays the run offline until it is clean, and proposes a normalizer for every value the agent makes anew.',
      command: 'shadowlap calibrate <run> --write',
      state: 'todo',
    },
    {
      title: 'Keep it as a test',
      text: 'Packs the run into the repository, and CI replays it offline on every commit.',
      command: 'shadowlap pack <run> goldens/first-run && shadowlap test goldens/first-run',
      state: 'todo',
    },
  ];
}

/** Words with the names in them shown as code, as the mock writes tools, paths and goldens. */
function Coded({ text, names }: { text: string; names: readonly string[] }) {
  return (
    <>
      {codeParts(text, names).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** JSON paths in a sentence (`$.metadata.user_id`): calibrate's words name them. */
const pathsIn = (text: string) => text.match(/\$\.[^\s:,;]*[^\s:,;.]/g) ?? [];

/** One step: its number (a tick once done), its title, what it shows, and the command beside it. */
function SetupStep({ n, state, title, cli, children }: { n: number; state: InspectStep['state']; title: string; cli: readonly string[]; children: ReactNode }) {
  const cls = stepClass(state);
  return (
    <li className={cls}>
      <span className="sn">{cls === 'done' ? '✓' : n}</span>
      <div className="sb">
        <h3>{title}</h3>
        {children}
        {cli.length ? (
          <div className="cli">
            <span>or in a terminal</span>
            <code>$ {cli.join(' && ')}</code>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** `asked`: opened at #/setup, rather than shown in place of a page; a project with nothing to set up says so there. */
export function SetupPage({ asked = false }: { asked?: boolean } = {}) {
  const app = useApp();
  const { client, meta, runs, tick, live, jobs, hasKind, actionsOff, guard, toast } = app;
  const [view, setView] = useState<SetupView | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [golden, setGolden] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [goldenError, setGoldenError] = useState<string | null>(null);
  // The first run's confirmation, for the project it was asked in: the job it starts names that one.
  const [asking, setAsking] = useState<{ confirm: RecordConfirmation; command: string; project: string } | null>(null);
  // The jobs this page started: the setup is read again as each ends.
  const mine = useRef(new Set<string>());
  const projectId = meta?.project?.id ?? null;
  // A dashboard that serves one store (`--read-only`, the terminal UI's) has no setup to follow: it isn't asked for one.
  const asks = asksForSetup(meta);
  // Recording, calibrating and testing run the agent from the project's working tree: not while a repair or an apply changes it.
  const treeBusy = useTreeBusy('reads', 'run this step');
  // Keeping it as a test replays a golden as well: not while another test job runs here either, as the server refuses it.
  const testsWait = useTestsWait('run this step');

  const load = useCallback(() => {
    client.projects.setup().then(
      (v) => {
        setView(v);
        setFailed(null);
      },
      (err: unknown) => setFailed(messageOf(err)),
    );
  }, [client]);

  // Read again as runs move (a recording streaming in), when the project changes, and every few
  // seconds while the page shows: what a terminal does (init, a pack) moves the setup on too. Not
  // before the meta says whether there is a setup to read.
  useEffect(() => {
    if (asks) load();
  }, [load, tick, projectId, asks]);
  const polling = !!view && view.shows !== 'none';
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 4000);
    return () => clearInterval(t);
  }, [load, polling]);
  // A new project starts from its own command and golden, and asks nothing the last one asked.
  useEffect(() => {
    setCommand(null);
    setGolden(null);
    setRecordError(null);
    setGoldenError(null);
    setAsking(null);
  }, [projectId]);

  const start = useCallback(
    (p: Promise<JobView>) => {
      p.then(
        (job) => mine.current.add(job.id),
        () => undefined,
      );
      app.watchJob(p);
    },
    [app],
  );

  // When a job this page started ends, the setup is read again: what it made moves the steps on.
  useEffect(() => {
    for (const w of jobs) {
      if (!w.job.done || !mine.current.has(w.job.id)) continue;
      mine.current.delete(w.job.id);
      load();
    }
  }, [jobs, load]);

  const problem = meta?.project?.id && meta.project.problem ? meta.project : null;
  if (problem) return <ProjectProblem id={problem.id!} name={problem.name} problem={problem.problem!} />;

  const shows = setupPageShows({ meta, view, runs });
  // No setup to follow (a dashboard that serves one store): with runs, nothing to set up here; without, the steps and their commands.
  if (shows === 'nothing') return <NotFoundPage what="Nothing to set up here." />;
  if (shows === 'steps') {
    const name = projectOf(meta)?.name ?? 'this project';
    return (
      <Page>
        <PageHeader eyebrow={name} title="No runs yet" text={SETUP_INTRO} />
        <StepList steps={setupSteps()} />
      </Page>
    );
  }
  if (shows === 'wait' || !view)
    return (
      <Page>
        {failed ? (
          <div className="empty tall">
            {failed}{' '}
            <a className="more" href={href.overview()}>
              Back to the overview
            </a>
          </div>
        ) : null}
      </Page>
    );

  // #/setup on a project that is set up: nothing to do here, as the mock says.
  if (asked && view.shows === 'none') return <NotFoundPage what="Nothing to set up here." />;

  const id = view.project.id;
  const off = actionsOff;
  const inspect = (again: boolean) => guard(() => start(client.startJob(JOB_KINDS.inspect, { project: id, ...(again ? { again: true } : {}) })));
  const record = (value: string) =>
    guard(() => {
      setRecordError(null);
      client.projects.planRecording(id, value).then(
        (plan) => {
          if (plan.confirm) setAsking({ confirm: plan.confirm, command: value, project: id });
          else start(client.startJob(JOB_KINDS.record, { project: id, command: value }));
        },
        (err: unknown) => setRecordError(messageOf(err)),
      );
    });
  const calibrate = (runId: string, write: boolean) => guard(() => start(client.startJob(JOB_KINDS.calibrate, { runId, write })));
  // Pack as a golden: the path checked first, so a mistake shows under the field; then one job packs
  // it and runs its test, on the server, so leaving the page doesn't stop halfway.
  const pack = (value: string) =>
    guard(() => {
      setGoldenError(null);
      client.projects.checkGolden(id, value).then(
        ({ path, runId }) => {
          if (!runId) return setGoldenError('Record a first run before you keep it as a test.');
          setGolden(path);
          start(client.startJob(JOB_KINDS.keepGolden, { project: id, golden: path }));
        },
        (err: unknown) => setGoldenError(messageOf(err)),
      );
    });
  // Packed already: its test runs (again).
  const testGolden = () => guard(() => start(client.startJob(JOB_KINDS.keepGolden, { project: id })));
  const finish = () =>
    guard(() => {
      client.projects.finish(id).then(
        async () => {
          await app.reload();
          navigate(href.overview());
        },
        (err: unknown) => toast(errorText(err), 'error'),
      );
    });

  // A step's job still running here: its button waits for it, rather than starting a second.
  const running = (kind: string) => jobs.some((w) => !w.job.done && !w.lost && w.job.kind === kind);

  return (
    <Page>
      <SetupHeader view={view} onSkip={off ? null : finish} />
      <ol className="setup">
        <InspectBody step={view.inspect} off={off} canInspect={hasKind(JOB_KINDS.inspect)} onInspect={inspect} />
        <RecordBody step={view.record} off={off} tree={treeBusy} canRecord={hasKind(JOB_KINDS.record)} live={live} command={command} setCommand={setCommand} error={recordError} onRecord={record} />
        <CalibrateBody step={view.calibrate} off={off} tree={treeBusy} busy={running(JOB_KINDS.calibrate)} canCalibrate={hasKind(JOB_KINDS.calibrate)} runId={view.record.recorded?.runId ?? null} onCalibrate={calibrate} />
        <TestBody step={view.test} off={off} tree={testsWait} busy={running(JOB_KINDS.keepGolden)} canKeep={hasKind(JOB_KINDS.keepGolden)} golden={golden} setGolden={setGolden} error={goldenError} onPack={pack} onTest={testGolden} />
      </ol>
      {view.done ? (
        <div className="setupdone">
          <div>
            <b>{view.done.title}</b>
            <span>{view.done.text}</span>
          </div>
          <ActionButton className="btn lime" why={off} onClick={finish}>
            {view.done.button.label}
          </ActionButton>
        </div>
      ) : null}
      {asking ? <RecordRunDialog confirm={asking.confirm} onClose={() => setAsking(null)} onOk={() => guard(() => start(client.startJob(JOB_KINDS.record, confirmedRecording(asking))))} /> : null}
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

/** Why a step's button can't run here: the dashboard is read-only, or doesn't run that job kind yet. */
const notHere = (off: string | null, can: boolean, cli: readonly string[]) => off ?? (can ? null : `This dashboard doesn’t run this step yet: run ${cli.join(' && ') || 'its command'} in a terminal.`);

function InspectBody({ step, off, canInspect, onInspect }: { step: InspectStep; off: string | null; canInspect: boolean; onInspect: (again: boolean) => void }) {
  const { toast } = useApp();
  const why = notHere(off, canInspect, ['shadowlap init']);
  const unwrapped = step.findings?.tools.filter((t) => !t.wrapped).map((t) => t.name) ?? [];
  const found = step.findings ? (
    <>
      <dl className="found">
        {step.findings.rows.map((r) => (
          <FoundRow key={r.label} label={r.label} value={r.value} code={r.code} small={r.small} />
        ))}
      </dl>
      {step.findings.tools.length ? (
        <div className="tools">
          <span className="k">tools</span>
          {step.findings.tools.map((t) => (
            <div key={t.name} className={`trow${t.wrapped ? '' : ' warn'}`}>
              <code>{t.name}</code>
              <span className={`eff ${t.effect}`}>{t.effect}</span>
              <span>
                {t.text}
                {t.at ? <small>{t.at}</small> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  ) : null;
  const code = step.warning ? step.warning.code.map((w) => w.code).join('\n\n') : '';
  return (
    <SetupStep n={1} state={step.state} title={step.title} cli={step.cli}>
      {step.text ? <p>{step.text}</p> : null}
      {step.button ? (
        <div className="actions">
          <ActionButton className="btn lime" why={why} onClick={() => onInspect(false)}>
            {step.button.label}
          </ActionButton>
        </div>
      ) : null}
      {found && step.folded ? (
        <details className="foundsum">
          <summary>
            <span className="sumtext">
              <Coded text={step.summary ?? ''} names={[...(step.findings?.rows.filter((r) => r.code).map((r) => r.value) ?? []), ...(step.summaryCommand ? [step.summaryCommand] : [])]} />
            </span>
          </summary>
          {found}
        </details>
      ) : (
        found
      )}
      {step.warning ? (
        <div className="warnbox">
          <b>{step.warning.title}</b> <Coded text={step.warning.text} names={unwrapped} />
          {step.warning.code.map((w) => (
            <pre tabIndex={0} key={w.language + w.tools.join(',')} className="codebox">
              {w.code}
            </pre>
          ))}
          <div className="actions">
            {code ? (
              <button className="btn" type="button" onClick={() => void copyText(code).then((ok) => toast(ok ? 'Copied the code' : 'Copying was refused by the browser'))}>
                {step.warning.copy}
              </button>
            ) : null}
            <ActionButton className="btn" why={why} onClick={() => onInspect(true)}>
              {step.warning.recheck.label}
            </ActionButton>
          </div>
        </div>
      ) : null}
      {step.node ? (
        <div className="warnbox">
          <b>{step.node.title}</b> {step.node.text}
          <div className="actions">
            <ActionButton className="btn" why={why} onClick={() => onInspect(true)}>
              {step.node.recheck.label}
            </ActionButton>
          </div>
        </div>
      ) : null}
    </SetupStep>
  );
}

function FoundRow({ label, value, code, small }: { label: string; value: string; code: boolean; small: string | null }) {
  // "wrote an empty shadowlap.config.json": the file's name as code, as the mock has it.
  const file = /shadowlap\.config\.json/.exec(value)?.[0];
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {code ? <code>{value}</code> : file ? <Coded text={value} names={[file]} /> : value}
        {small ? <small>{small}</small> : null}
      </dd>
    </>
  );
}

function CommandField({ value, enabled, onChange, onEnter }: { value: string; enabled: boolean; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <label className="cmdin">
      <span className="sr">Command</span>
      <b>$</b>
      <input
        id="recCmd"
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={value}
        disabled={!enabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </label>
  );
}

function RecordBody({
  step,
  off,
  tree,
  canRecord,
  live,
  command,
  setCommand,
  error,
  onRecord,
}: {
  step: RecordStep;
  off: string | null;
  /** Why the working tree can't run the agent now (a repair holds it), or null. */
  tree: string | null;
  canRecord: boolean;
  live: ReturnType<typeof useApp>['live'];
  command: string | null;
  setCommand: (v: string) => void;
  error: string | null;
  onRecord: (value: string) => void;
}) {
  const field = step.command ?? step.again?.command ?? null;
  const value = command ?? field?.value ?? '';
  const why = notHere(off, canRecord, step.cli.length ? step.cli : (step.again?.cli ?? [])) ?? tree;
  const enabled = !!field?.enabled;
  const go = () => {
    if (enabled && !why && value.trim()) onRecord(value);
  };
  let body: ReactNode;
  if (step.live) {
    const line = recordingLine(step.live.runId, liveCalls(step.live.runId, step.live.calls, live));
    body = (
      <div className="recline">
        <span className="dotlive" />
        <span className="rtext">
          Recording <code>{line.id}</code>
          {line.rest}
        </span>
        <a className="btn" href={step.live.watch.href}>
          {step.live.watch.label}
        </a>
      </div>
    );
  } else if (step.recorded) {
    const at = aroundRunId(step.recorded.text, step.recorded.runId);
    body = (
      <>
        <div className="recline ok">
          <span className="ic" />
          <span className="rtext">
            {at.before}
            {at.id ? (
              <a className="more" href={step.recorded.href}>
                {at.id}
              </a>
            ) : null}
            {at.after}
          </span>
        </div>
        {step.warning ? <p className="fieldnote warn">{step.warning}</p> : null}
      </>
    );
  } else {
    body = (
      <>
        {step.text ? <p>{step.text}</p> : null}
        {step.command ? <CommandField value={value} enabled={enabled} onChange={setCommand} onEnter={go} /> : null}
        {step.button ? (
          <div className="actions">
            {/* The first recording in a folder asks on every setting, as no estimate prices what a command does. */}
            <ActionButton className="btn lime" disabled={!step.button.enabled || !value.trim()} why={why} tip={step.button.label} est={tipEst(null)} onClick={go}>
              {step.button.label}
            </ActionButton>
          </div>
        ) : null}
      </>
    );
  }
  return (
    <SetupStep n={2} state={step.state} title={step.title} cli={terminalLine(step.cli, field?.value ?? '', command)}>
      {body}
      {step.empty ? (
        <p className="fieldnote warn">
          <Coded text={step.empty.text} names={[step.empty.runId.slice(0, 10)]} />{' '}
          <a className="more" href={step.empty.href}>
            Open it
          </a>
        </p>
      ) : null}
      {step.again ? (
        <div className="again">
          <CommandField value={value} enabled={step.again.command.enabled} onChange={setCommand} onEnter={go} />
          <div className="actions">
            <ActionButton className="btn" disabled={!step.again.command.enabled || !value.trim()} why={why} tip={step.again.label} est={tipEst(null, true)} onClick={go}>
              {step.again.label}
            </ActionButton>
          </div>
        </div>
      ) : null}
      {error ? <p className="fieldnote err">{error}</p> : null}
    </SetupStep>
  );
}

function CalibrateBody({ step, off, tree, busy, canCalibrate, runId, onCalibrate }: { step: CalibrateStep; off: string | null; tree: string | null; busy: boolean; canCalibrate: boolean; runId: string | null; onCalibrate: (runId: string, write: boolean) => void }) {
  const why = notHere(off, canCalibrate, step.cli) ?? (busy ? 'Calibrating: the step moves on when it is done.' : tree);
  const names = [...step.proposed.map((p) => p.path), ...pathsIn(step.text)];
  const button = step.button;
  return (
    <SetupStep n={3} state={step.state} title={step.title} cli={step.cli}>
      <p>
        <Coded text={step.text} names={names} />
      </p>
      {button ? (
        <div className="actions">
          <ActionButton className="btn lime" disabled={!button.enabled || !runId} why={why} onClick={() => runId && onCalibrate(runId, button.action === 'calibratewrite')}>
            {button.label}
          </ActionButton>
        </div>
      ) : null}
    </SetupStep>
  );
}

function TestBody({
  step,
  off,
  tree,
  busy,
  canKeep,
  golden,
  setGolden,
  error,
  onPack,
  onTest,
}: {
  step: TestStep;
  off: string | null;
  tree: string | null;
  busy: boolean;
  canKeep: boolean;
  golden: string | null;
  setGolden: (v: string) => void;
  error: string | null;
  onPack: (value: string) => void;
  onTest: () => void;
}) {
  const value = golden ?? step.golden?.value ?? '';
  const enabled = !!step.golden?.enabled;
  const why = notHere(off, canKeep, step.cli) ?? (busy ? 'Packing and testing: the step moves on when it is done.' : tree);
  const testing = step.button?.action === 'testgolden';
  const go = () => {
    if (why) return;
    if (testing) onTest();
    else if (enabled && value.trim()) onPack(value.trim());
  };
  const settings = step.redaction ? aroundWord(step.redaction.text, 'Settings') : null;
  const goldenNames = step.result ? (step.result.text.match(/goldens\/[\w./-]*[\w-]/g) ?? []) : [];
  return (
    <SetupStep n={4} state={step.state} title={step.title} cli={step.cli}>
      {step.text || step.redaction ? (
        <p>
          {step.text}
          {step.redaction ? ' ' : null}
          {step.redaction && settings ? (
            <>
              {settings.before}
              <a className="more" href={step.redaction.href}>
                {settings.word}
              </a>
              {settings.after}
            </>
          ) : (
            step.redaction?.text
          )}
        </p>
      ) : null}
      {step.golden ? (
        <label className="cmdin">
          <span className="sr">Golden</span>
          <b>→</b>
          <input
            id="goldName"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={value}
            disabled={!enabled}
            onChange={(e) => setGolden(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                go();
              }
            }}
          />
        </label>
      ) : null}
      {step.packed ? (
        <p className={step.packed.failed ? 'fieldnote err' : undefined}>
          <Coded text={step.packed.text} names={[step.packed.golden]} />
          {step.packed.link ? (
            <>
              {' '}
              <a className="more" href={step.packed.link.href}>
                {step.packed.link.label}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {step.button ? (
        <div className="actions">
          <ActionButton className="btn lime" disabled={!step.button.enabled || (!testing && !value.trim())} why={why} onClick={go}>
            {step.button.label}
          </ActionButton>
        </div>
      ) : null}
      {step.result ? (
        <div className="recline ok">
          <span className="ic" />
          <span className="rtext">
            <Coded text={step.result.text} names={goldenNames} />
          </span>
          <a className="btn" href={step.result.link.href}>
            {step.result.link.label}
          </a>
        </div>
      ) : null}
      {error ? <p className="fieldnote err">{error}</p> : null}
    </SetupStep>
  );
}
