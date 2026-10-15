import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { JOB_KINDS, type JobView } from '../api.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { Eyebrow, PageHeader, StepList, type Step } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { copyText } from '../dom.js';
import type { CalibrateStep, InspectStep, RecordConfirmation, RecordStep, SetupView, TestStep } from '../projects-api.js';
import { aroundRunId, aroundWord, codeParts, liveCalls, recordingLine, stepClass } from '../projects.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { isAttempt } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/**
 * Setting a project up (#/setup, and in place of the pages of a project with no runs, or of the
 * Overview mid-setup): four steps, each with the CLI command it runs. Inspect runs `init` and shows
 * what it found, flagging tools that aren't wrapped with the code to wrap them; Record runs the
 * editable command after asking the first time, then streams the run in; Make the replay clean runs
 * calibrate and adds what it proposes; Keep it as a test packs the run as a golden and tests it. The
 * server's read model (`setupView`) says what each step shows; this page runs the jobs and follows
 * them. A step whose job kind this dashboard doesn't run says so and keeps its command.
 */

/** The four steps with their commands, for a dashboard that serves one store and has no setup to follow. */
export function setupSteps(recorded: boolean): Step[] {
  return [
    {
      title: 'Inspect the folder',
      text: 'Finds the model SDKs, the command that starts the agent, and every tool with the effect it declares. It runs nothing.',
      command: 'shadowlap init',
      state: recorded ? 'done' : 'cur',
    },
    {
      title: 'Record a first run',
      text: 'Runs your command once with a local sidecar in front of the model API. Model calls go to the real API with your keys, which are never stored.',
      command: 'shadowlap run -- python agent.py',
      state: recorded ? 'done' : 'todo',
    },
    {
      title: 'Make the replay clean',
      text: 'Replays the run offline until it is clean, and proposes a normalizer for every value the agent makes anew.',
      command: 'shadowlap calibrate <run> --write',
      state: recorded ? 'cur' : 'todo',
    },
    {
      title: 'Keep it as a test',
      text: 'Packs the run into the repository, and CI replays it offline on every commit.',
      command: 'shadowlap pack <run> goldens/first-run',
      state: 'todo',
    },
  ];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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

/** What to do when a job this page started ends. */
type After = { then: 'reload' } | { then: 'test'; golden: string };

export function SetupPage() {
  const app = useApp();
  const { client, meta, runs, tick, live, jobs, hasKind, actionsOff, guard, toast } = app;
  const [view, setView] = useState<SetupView | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [golden, setGolden] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [goldenError, setGoldenError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ confirm: RecordConfirmation; command: string } | null>(null);
  const after = useRef(new Map<string, After>());
  const projectId = meta?.project?.id ?? null;

  const load = useCallback(() => {
    client.projects.setup().then(
      (v) => {
        setView(v);
        setFailed(null);
      },
      (err: unknown) => setFailed(message(err)),
    );
  }, [client]);

  // Read again as runs move (a recording streaming in), when the project changes, and every few
  // seconds while the page shows: what a terminal does (init, a pack) moves the setup on too.
  useEffect(() => load(), [load, tick, projectId]);
  const polling = !!view && view.shows !== 'none';
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 4000);
    return () => clearInterval(t);
  }, [load, polling]);
  // A new project starts from its own command and golden.
  useEffect(() => {
    setCommand(null);
    setGolden(null);
    setRecordError(null);
    setGoldenError(null);
  }, [projectId]);

  const start = useCallback(
    (p: Promise<JobView>, next: After) => {
      p.then(
        (job) => after.current.set(job.id, next),
        () => undefined,
      );
      app.watchJob(p);
    },
    [app],
  );

  // The jobs this page started: when one ends, the setup is read again (and a packed golden is tested).
  useEffect(() => {
    for (const w of jobs) {
      const next = after.current.get(w.job.id);
      if (!next || !w.job.done) continue;
      after.current.delete(w.job.id);
      load();
      if (next.then === 'test' && w.job.code === 0 && hasKind(JOB_KINDS.tests)) start(client.startJob(JOB_KINDS.tests, { golden: next.golden }), { then: 'reload' });
    }
  }, [jobs, load, start, client, hasKind]);

  if (view === null) {
    // A dashboard that serves one store: the steps and their commands.
    const name = projectOf(meta)?.name ?? 'this project';
    const recorded = (runs ?? []).some((r) => !isAttempt(r));
    return (
      <Page>
        <PageHeader eyebrow={name} title={`Set up ${name}`} text="Record the agent once. Every lap after that replays for free." />
        <StepList steps={setupSteps(recorded)} />
      </Page>
    );
  }
  if (view === undefined)
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

  const id = view.project.id;
  const off = actionsOff;
  const inspect = (again: boolean) => guard(() => start(client.startJob(JOB_KINDS.inspect, { project: id, ...(again ? { again: true } : {}) }), { then: 'reload' }));
  const record = (value: string) =>
    guard(() => {
      setRecordError(null);
      client.projects.planRecording(id, value).then(
        (plan) => {
          if (plan.confirm) setAsking({ confirm: plan.confirm, command: value });
          else start(client.startJob(JOB_KINDS.record, { project: id, command: value }), { then: 'reload' });
        },
        (err: unknown) => setRecordError(message(err)),
      );
    });
  const calibrate = (runId: string, write: boolean) => guard(() => start(client.startJob(JOB_KINDS.calibrate, { runId, write }), { then: 'reload' }));
  const pack = (value: string) =>
    guard(() => {
      setGoldenError(null);
      client.projects.checkGolden(id, value).then(
        ({ path, runId }) => {
          if (!runId) return setGoldenError('Record a first run before you keep it as a test.');
          setGolden(path);
          // The run page's Pack where this dashboard has it, else the run action that packs.
          const job = hasKind(JOB_KINDS.pack) ? client.startJob(JOB_KINDS.pack, { runId, dir: path }) : client.action(runId, 'p', null, path);
          start(job, { then: 'test', golden: path });
        },
        (err: unknown) => setGoldenError(message(err)),
      );
    });
  const finish = () =>
    guard(() => {
      client.projects.finish(id).then(
        async () => {
          await app.reload();
          navigate(href.overview());
        },
        (err: unknown) => toast(message(err)),
      );
    });

  return (
    <Page>
      <SetupHeader view={view} onSkip={off ? null : finish} />
      <ol className="setup">
        <InspectBody step={view.inspect} off={off} canInspect={hasKind(JOB_KINDS.inspect)} onInspect={inspect} />
        <RecordBody step={view.record} off={off} canRecord={hasKind(JOB_KINDS.record)} live={live} command={command} setCommand={setCommand} error={recordError} onRecord={record} />
        <CalibrateBody step={view.calibrate} off={off} canCalibrate={hasKind(JOB_KINDS.calibrate)} runId={view.record.recorded?.runId ?? null} onCalibrate={calibrate} />
        <TestBody step={view.test} off={off} golden={golden} setGolden={setGolden} error={goldenError} onPack={pack} />
      </ol>
      {view.done ? (
        <div className="setupdone">
          <div>
            <b>{view.done.title}</b>
            <span>{view.done.text}</span>
          </div>
          <button className="btn lime" type="button" disabled={!!off} title={off ?? undefined} onClick={finish}>
            {view.done.button.label}
          </button>
        </div>
      ) : null}
      {asking ? (
        <ConfirmDialog
          title={asking.confirm.title}
          text={asking.confirm.text}
          ok={asking.confirm.button}
          command={asking.confirm.command}
          onClose={() => setAsking(null)}
          onOk={() => {
            const value = asking.command;
            setAsking(null);
            guard(() => start(client.startJob(JOB_KINDS.record, { project: id, command: value, confirmed: true }), { then: 'reload' }));
          }}
        />
      ) : null}
    </Page>
  );
}

function SetupHeader({ view, onSkip }: { view: SetupView; onSkip: (() => void) | null }) {
  return (
    <div className="ph">
      <div>
        <Eyebrow>
          {view.project.name} · <code>{view.project.path}</code>
        </Eyebrow>
        <h1>{view.title}</h1>
        <p>{view.intro}</p>
      </div>
      {view.skip ? (
        <div className="actions">
          <button className="btn quiet" type="button" disabled={!onSkip} onClick={() => onSkip?.()}>
            {view.skip.label}
          </button>
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
          <button className="btn lime" type="button" disabled={!!why} title={why ?? undefined} onClick={() => onInspect(false)}>
            {step.button.label}
          </button>
        </div>
      ) : null}
      {found && step.folded ? (
        <details className="foundsum">
          <summary>{step.summary}</summary>
          {found}
        </details>
      ) : (
        found
      )}
      {step.warning ? (
        <div className="warnbox">
          <b>{step.warning.title}</b> <Coded text={step.warning.text} names={unwrapped} />
          {step.warning.code.map((w) => (
            <pre key={w.language + w.tools.join(',')} className="codebox">
              {w.code}
            </pre>
          ))}
          <div className="actions">
            {code ? (
              <button className="btn" type="button" onClick={() => void copyText(code).then((ok) => toast(ok ? 'Copied the code' : 'Copying was refused by the browser'))}>
                {step.warning.copy}
              </button>
            ) : null}
            <button className="btn" type="button" disabled={!!why} title={why ?? undefined} onClick={() => onInspect(true)}>
              {step.warning.recheck.label}
            </button>
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
  canRecord,
  live,
  command,
  setCommand,
  error,
  onRecord,
}: {
  step: RecordStep;
  off: string | null;
  canRecord: boolean;
  live: ReturnType<typeof useApp>['live'];
  command: string | null;
  setCommand: (v: string) => void;
  error: string | null;
  onRecord: (value: string) => void;
}) {
  const field = step.command ?? step.again?.command ?? null;
  const value = command ?? field?.value ?? '';
  const why = notHere(off, canRecord, step.cli.length ? step.cli : (step.again?.cli ?? []));
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
        <span>
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
          <span>
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
            <button className="btn lime" type="button" disabled={!step.button.enabled || !!why || !value.trim()} title={why ?? undefined} onClick={go}>
              {step.button.label}
            </button>
          </div>
        ) : null}
      </>
    );
  }
  return (
    <SetupStep n={2} state={step.state} title={step.title} cli={step.cli}>
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
            <button className="btn" type="button" disabled={!step.again.command.enabled || !!why || !value.trim()} title={why ?? undefined} onClick={go}>
              {step.again.label}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="fieldnote err">{error}</p> : null}
    </SetupStep>
  );
}

function CalibrateBody({ step, off, canCalibrate, runId, onCalibrate }: { step: CalibrateStep; off: string | null; canCalibrate: boolean; runId: string | null; onCalibrate: (runId: string, write: boolean) => void }) {
  const why = notHere(off, canCalibrate, step.cli);
  const names = [...step.proposed.map((p) => p.path), ...pathsIn(step.text)];
  const button = step.button;
  return (
    <SetupStep n={3} state={step.state} title={step.title} cli={step.cli}>
      <p>
        <Coded text={step.text} names={names} />
      </p>
      {button ? (
        <div className="actions">
          <button className="btn lime" type="button" disabled={!button.enabled || !runId || !!why} title={why ?? undefined} onClick={() => runId && onCalibrate(runId, button.action === 'calibratewrite')}>
            {button.label}
          </button>
        </div>
      ) : null}
    </SetupStep>
  );
}

function TestBody({ step, off, golden, setGolden, error, onPack }: { step: TestStep; off: string | null; golden: string | null; setGolden: (v: string) => void; error: string | null; onPack: (value: string) => void }) {
  const value = golden ?? step.golden?.value ?? '';
  const enabled = !!step.golden?.enabled;
  const go = () => {
    if (enabled && !off && value.trim()) onPack(value.trim());
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
      {step.button ? (
        <div className="actions">
          <button className="btn lime" type="button" disabled={!step.button.enabled || !!off || !value.trim()} title={off ?? undefined} onClick={go}>
            {step.button.label}
          </button>
        </div>
      ) : null}
      {step.result ? (
        <div className="recline ok">
          <span className="ic" />
          <span>
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
