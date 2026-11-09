import type { ReactNode } from 'react';
import { JOB_KINDS } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { copyText } from '../dom.js';
import type { CalibrateStep, InspectStep, RecordStep, SetupView, TestStep } from '../projects-api.js';
import { aroundRunId, aroundWord, codeParts, liveCalls, recordingLine, stepClass, terminalLine } from '../projects.js';
import { tipEst } from '../spending.js';
import { useApp } from '../state.js';
import type { SetupJobs } from './setup-jobs.js';

/**
 * The setup's four steps (Setup.tsx draws them under its header): each with what the read model
 * says it shows, its button, and the command beside it for a terminal. A step whose job kind this
 * dashboard doesn't run says so and keeps its command.
 */
export function SetupSteps({ view, jobs, off, treeBusy, testsWait }: { view: SetupView; jobs: SetupJobs; off: string | null; treeBusy: string | null; testsWait: string | null }) {
  const { hasKind, live } = useApp();
  return (
    <ol className="setup">
      <InspectBody step={view.inspect} off={off} canInspect={hasKind(JOB_KINDS.inspect)} onInspect={jobs.inspect} />
      <RecordBody step={view.record} off={off} tree={treeBusy} canRecord={hasKind(JOB_KINDS.record)} live={live} command={jobs.command} setCommand={jobs.setCommand} error={jobs.recordError} onRecord={jobs.record} />
      <CalibrateBody step={view.calibrate} off={off} tree={treeBusy} busy={jobs.running(JOB_KINDS.calibrate)} canCalibrate={hasKind(JOB_KINDS.calibrate)} runId={view.record.recorded?.runId ?? null} onCalibrate={jobs.calibrate} />
      <TestBody step={view.test} off={off} tree={testsWait} busy={jobs.running(JOB_KINDS.keepGolden)} canKeep={hasKind(JOB_KINDS.keepGolden)} golden={jobs.golden} setGolden={jobs.setGolden} error={jobs.goldenError} onPack={jobs.pack} onTest={jobs.testGolden} />
    </ol>
  );
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

/**
 * One step, a section beside its number on the rail (a tick once done): its title, what it shows,
 * and the command beside it. `data-step` names it, for the page's follow (setup-jobs.ts).
 */
function SetupStep({ step, cli, children }: { step: SetupView['steps'][number]; cli: readonly string[]; children: ReactNode }) {
  const cls = stepClass(step.state);
  return (
    <li className={cls} data-step={step.key}>
      <span className="sn">{cls === 'done' ? '✓' : step.n}</span>
      <div className="sb">
        <h2>{step.title}</h2>
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
    <SetupStep step={step} cli={step.cli}>
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
              <Coded text={[...(step.summaryFacts ?? []), ...(step.summaryCommand ? [step.summaryCommand] : [])].join(' · ')} names={[...(step.findings?.rows.filter((r) => r.code).map((r) => r.value) ?? []), ...(step.summaryCommand ? [step.summaryCommand] : [])]} />
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
                Copy wrappers
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
    <SetupStep step={step} cli={terminalLine(step.cli, field?.value ?? '', command)}>
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
    <SetupStep step={step} cli={step.cli}>
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
    <SetupStep step={step} cli={step.cli}>
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
