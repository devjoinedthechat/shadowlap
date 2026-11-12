import { useEffect, useRef, useState } from 'react';
import { JOB_KINDS, type ModelsView, type PipView, type TaskUpdate, type TrainingView } from '../api.js';
import { EmptyState, PageHeader } from '../components/bits.js';
import { Code, Copy } from '../components/Copy.js';
import { Dialog } from '../components/Dialog.js';
import { tipText } from '../components/HoverCard.js';
import { Page } from '../components/Page.js';
import { Section } from '../components/Section.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { useTreeBusy } from '../fixes/tree.js';
import { plural } from '../format.js';
import { commandText } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { redactsFact } from '../run/share-steps.js';
import { useApp } from '../state.js';
import { ENDPOINT, exportCommand, firstPick, leftOutLine, noteTrainingCounts, notesLine, onTrainingDialog, pickNote, pickReplaces, pipClass, pipTip, scoreCard, scoreCommand, scoreCost, scoreEstimate, scoreFields, sendTaskUpdate, takeTrainingDialog, whenDone, type LiveAsked, type TrainingDialog } from '../training.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';
import { JobButton } from '../components/JobButton.js';
import { sentEstimate } from '../spending.js';
import { liveFacts } from '../tests-ask.js';
import type { CostLineProps } from '../components/CostLine.js';
import { goldenPrice, useTestsEstimates, type Price } from '../tests-estimates.js';
import { testsJob } from './tests-cards.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useNoRunsYet } from './set-up-step.js';
import { trainingFacts } from './training/facts.js';
import { PairsTab } from './training/Pairs.js';
import { TabEmpty } from './training/TabEmpty.js';
import { OneSided, TaskNotes, TaskTable } from './training/Tasks.js';

/**
 * Training (#/training, #/training/tasks): preference pairs read from the attempts blame, verify and
 * --repeat left in the store, and goldens as tasks a model is scored on. Its facts under the header
 * (none in a project with no runs yet, and no counts on the tabs then) and the tabs show on both;
 * Export pairs and Score a model run the CLI as jobs. It reads `/api/training`, and `/api/models`
 * for the picker; words and layout follow the mock: sections, never cards.
 */


export function TrainingPage({ tab }: { tab: 'pairs' | 'tasks' }) {
  const { client, tick, exported, actionsOff, hasKind, guard, meta } = useApp();
  const loaded = useLoad(() => (exported ? null : client.training()), 'training', tick);
  const view = loaded.data;
  const [dialog, setDialog] = useState<TrainingDialog | null>(null);
  const [wanted, setWanted] = useState<TrainingDialog | null>(() => takeTrainingDialog());

  // What the palette offers follows the page's counts; a reload that hasn't landed yet forgets nothing.
  useEffect(() => {
    if (view) noteTrainingCounts(view);
  }, [view]);
  // The palette asks for a dialog: it opens once the page knows there is something to export or score.
  useEffect(() => onTrainingDialog((kind) => setWanted(takeTrainingDialog() ?? kind)), []);
  useEffect(() => {
    if (!wanted || !view) return;
    if (wanted === 'export' ? view.actions.exportPairs : view.actions.scoreModel) setDialog(wanted);
    setWanted(null);
  }, [wanted, view]);

  const canExport = !!view?.actions.exportPairs && hasKind(JOB_KINDS.pairs);
  const canScore = !!view?.actions.scoreModel && hasKind(JOB_KINDS.score);
  // Scoring runs the agent from the project's working tree: not while a repair or an apply changes it.
  const busy = useTreeBusy('reads', 'score');
  // A project with no runs yet (attempts alone are none) has nothing to count: no facts, and the tabs say what each will hold.
  const none = useNoRunsYet();
  const counted = !!view && !none;
  const action = tab === 'pairs' ? (canExport ? { label: ACTIONS.exportPairs.label, kind: 'export' as const, off: actionsOff } : null) : canScore ? { label: ACTIONS.scoreModel.label, kind: 'score' as const, off: actionsOff ?? busy } : null;
  return (
    <Page busy={!view && !loaded.error && !exported}>
      <PageHeader
        eyebrow={[projectOf(meta)?.name, 'training data'].filter(Boolean).join(' · ')}
        title="Training"
        text={
          <>
            <span className="ln">Answers to prefer, from attempts already in the store,</span> <span className="ln">and your goldens as tasks to score.</span>
          </>
        }
        actions={
          action?.kind === 'score' ? (
            <ScoreModelButton why={action.off} onOpen={() => guard(() => setDialog('score'))} />
          ) : action ? (
            <ActionButton className="btn lime" why={action.off} tip={confirmWords(ACTIONS.exportPairs.label)} sub="Asks the format and the confidence first" command={`$ ${commandText(['export', 'pairs'])}`} onClick={() => guard(() => setDialog(action.kind))}>
              {action.label}
            </ActionButton>
          ) : null
        }
        facts={counted ? trainingFacts(view) : undefined}
        factsLabel="Training"
      />
      {view ? (
        <>
          <nav className="stabs" aria-label="Training">
            <a href={href.training('pairs')} aria-current={tab === 'pairs' ? 'page' : undefined}>
              Pairs{counted ? <b>{view.tabs.pairs.toLocaleString('en-US')}</b> : null}
            </a>
            <a href={href.training('tasks')} aria-current={tab === 'tasks' ? 'page' : undefined}>
              Tasks{counted ? <b>{view.tabs.tasks.toLocaleString('en-US')}</b> : null}
            </a>
          </nav>
          {tab === 'tasks' ? <TasksTab view={view} /> : <PairsTab view={view} />}
        </>
      ) : loaded.error ? (
        <ErrorState retry={loaded.reload}>Training can’t be read: {loaded.error.message}</ErrorState>
      ) : exported ? (
        <EmptyState title="Not in an exported copy" text="An exported copy holds runs and Compare between them. Training reads the store: open it from shadowlap dashboard." />
      ) : (
        <Skeleton what="pairs and tasks" lines={4} />
      )}
      {dialog === 'export' && view ? <ExportPairsDialog view={view} onClose={() => setDialog(null)} /> : null}
      {dialog === 'score' && view ? <ScoreDialog view={view} busy={busy} onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------- tasks

function TasksTab({ view }: { view: TrainingView }) {
  const { actionsOff, hasKind, guard } = useApp();
  const [updating, setUpdating] = useState<{ update: TaskUpdate; name: string; estimate: Price } | null>(null);
  // Updating a golden runs the agent from the working tree: not while a repair or an apply changes it.
  const busy = useTreeBusy('reads', 'update the golden');
  const t = view.tasks;
  // a message the server wrote, kept as written
  if (t.error) return <EmptyState title="The tasks can’t be read" text={t.error} copy={false} command="shadowlap tasks" />;
  if (t.empty) return <TabEmpty empty={t.empty} />;
  // A task its test's early fork blocks: Update golden, off with the reason when nothing can run.
  const updateOff = actionsOff ?? busy;
  const update = hasKind(JOB_KINDS.taskUpdate) ? (u: TaskUpdate, name: string) => <TaskUpdateButton className="btn sm" why={updateOff} update={u} name={name} onOpen={(estimate) => guard(() => setUpdating({ update: u, name, estimate }))} /> : null;
  return (
    <>
      {t.warning ? <OneSided w={t.warning} ready={view.tabs.tasks} update={update} /> : null}
      <TaskTable rows={t.rows} update={update} />
      {updating ? <TaskUpdateDialog name={updating.name} update={updating.update} estimate={updating.estimate} busy={updateOff} onClose={() => setUpdating(null)} /> : null}
      <Scores view={view} />
      <TaskNotes view={view} />
    </>
  );
}

function Scores({ view }: { view: TrainingView }) {
  const s = view.scores;
  return (
    <Section title="Scores" sub={s.sub}>
      {s.empty ? (
        <div className="pbody">
          <Copy className="muted flat">{s.empty}</Copy>
        </div>
      ) : (
        <>
          <div className="mcards">
            {s.cards.map((c) => (
              <div className="mcard" key={`${c.model}\n${c.baseUrl ?? ''}`}>
                <b className="mn">{c.model}</b>
                <span className="rsub">
                  {c.via}
                  {c.where ? ` · ${c.where}` : ''}
                </span>
                <div className="ovbig">
                  <b>{c.mean === null ? '—' : c.mean.toFixed(2)}</b>
                  {/* Scored on fewer than every ready task (one became ready since): its mean is over those, and it says so. */}
                  {c.coverage ? <span title="Score it again to include every ready task">{c.coverage}</span> : null}
                </div>
                <span className="sbar">
                  <i style={{ width: `${Math.round(Math.max(0, Math.min(1, c.bar)) * 1000) / 10}%` }} />
                </span>
                <span className="rsub">
                  {c.cost} · {whenDone(c.at)}
                </span>
              </div>
            ))}
          </div>
          <div className="tscroll">
            <table className="t score">
              <thead>
                <tr>
                  <th>Per task</th>
                  {s.cards.map((c) => (
                    <th key={`${c.model}\n${c.baseUrl ?? ''}`} className="mh" title={c.baseUrl ?? c.via}>
                      {c.model}
                      {c.where ? <small>{c.where}</small> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((row) => (
                  <tr key={row.golden} className="static">
                    <td>
                      <code>{row.name}</code>
                    </td>
                    {row.cells.map((cell, i) => (
                      <td key={i}>
                        {cell ? (
                          <span className="scell">
                            <ScorePips pips={cell.pips} />
                            <em>{cell.mean.toFixed(2)}</em>
                          </span>
                        ) : (
                          <span className="muted">not scored</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Copy className="pfootnote">{s.footnote}</Copy>
    </Section>
  );
}

/** One pip per attempt: every check passed, some, or none. Each opens its attempt's run. */
function ScorePips({ pips }: { pips: PipView[] }) {
  const all = pips.filter((p) => p.kind === 'all').length;
  return (
    <span className="pips" aria-label={`${all} of ${plural(pips.length, 'attempt')} passed every check`}>
      {pips.map((p) => {
        const cls = pipClass(p) || undefined;
        return p.href ? (
          <a key={p.attempt} href={p.href} data-tip={tipText(pipTip(p))} aria-label={pipTip(p)}>
            <i className={cls} />
          </a>
        ) : (
          <i key={p.attempt} className={cls} data-tip={tipText(pipTip(p))} />
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------- the dialogs

/** Export pairs: a format and a confidence, then `shadowlap export pairs` as a job. */
export function ExportPairsDialog({ view, onClose }: { view: TrainingView; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const d = view.exportDialog;
  const [format, setFormat] = useState<string>(d.formats[0]?.value ?? 'openai-preference');
  const [min, setMin] = useState<'high' | 'medium'>(d.high ? 'high' : 'medium');
  return (
    <Dialog
      title={d.title}
      lead={d.lead}
      doc="pairs"
      facts={[redactsFact(d.rules), { label: 'Writes', value: <code>{d.out}</code>, quiet: 'the job’s drawer offers it for download', wide: true }]}
      command={exportCommand(format, min, d.out)}
      ok={confirmWords(ACTIONS.exportPairs.label)}
      onOk={() => guard(() => watchJob(client.startJob(JOB_KINDS.pairs, { format, minConfidence: min })))}
      onClose={onClose}
    >
      <div className="form one">
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {d.formats.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Pairs
          <select value={min} onChange={(e) => setMin(e.target.value === 'medium' ? 'medium' : 'high')}>
            {d.levels.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Dialog>
  );
}

/**
 * Score model…: a form, as it asks which model first. Its card says what an attempt costs on the model
 * its dialog starts on. It asks providers for their models as the tab shows it, so the dialog opens on a list.
 */
function ScoreModelButton({ why, onOpen }: { why: string | null; onOpen: () => void }) {
  const { client, actionsOff } = useApp();
  const models = useLoad<ModelsView>(() => (actionsOff ? null : client.models()), 'models');
  const { estimate, ...card } = scoreCard(models.data);
  return (
    <JobButton className="btn lime" why={why} form estimate={estimate} {...card} start={onOpen} ask={onOpen}>
      {ACTIONS.scoreModel.label}
    </JobButton>
  );
}

/**
 * A blocked task's Update golden: its card says what it runs and what that bills, from Tests' estimates
 * for its golden (`GET /api/tests/estimates`). Re-recording the golden asks first whatever Spending
 * says, since it replaces the golden. Testing it again bills only where its tests entry runs it live
 * (marked fork, an injection gate): then the card says the amount, as a form's does. A press opens its
 * dialog either way, with the estimate the card showed.
 */
export function TaskUpdateButton({ update, name, onOpen, ...rest }: { className: string; why: string | null; update: TaskUpdate; name: string; onOpen: (e: Price) => void }) {
  const prices = useTestsEstimates(update.golden);
  const rules = update.normalizers.length === 1 ? 'normalizer' : 'normalizers';
  const card = { tip: ACTIONS.updateGolden.label, sub: update.rerecords ? `Re-records ${name} as your agent runs now, so its test replays up to the takeover` : `Adds the ${rules} and tests ${name} again, so it replays up to the takeover`, command: update.steps.map((step) => commandText(step)).join(' && ') };
  const price = goldenPrice(prices, update.golden, update.rerecords ? 'update' : 'rerun');
  const priced = update.rerecords ? testsJob(card, price, onOpen) : price?.usd ? { ...testsJob(card, price, onOpen), form: true } : { ...card, bills: false, start: () => onOpen(price), ask: () => onOpen(price) };
  return (
    <JobButton {...rest} {...priced}>
      {ACTIONS.updateGolden.label}
    </JobButton>
  );
}

/** What a task's Update bills, on its dialog's Cost line: a re-record as its recording cost; a re-test as the card said, live once the server says so. */
function taskUpdateCost(update: TaskUpdate, estimate: Price, asked: boolean): CostLineProps | null {
  if (update.rerecords) return { price: 'Billed by your provider', parts: ['as its recording cost'], estimate };
  if (asked || estimate?.usd) return { price: 'Billed by your provider', estimate: estimate?.usd ? estimate : null };
  return estimate ? { price: 'Free', estimate } : null;
}

/**
 * Update the golden of a task whose test forks before its takeover: what it runs and why, then the
 * job. The server builds the commands again from the store and the config; these are shown so the
 * change to the config and the working tree is plain before it is made. Its Cost line is the estimate
 * its button showed, once there is one, and the job keeps it. Where testing the golden again runs it
 * live and the dialog hadn't said so, the server's question shows here, and its button sends the yes:
 * one ask, never one over another.
 */
export function TaskUpdateDialog({ name, update, estimate, busy, onClose }: { name: string; update: TaskUpdate; estimate?: Price; /** Why nothing can run now, or null. */ busy: string | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const [asked, setAsked] = useState<LiveAsked | null>(null);
  const rules = update.normalizers.length;
  const values = update.normalizers.join(', ');
  const fork = `Its test forks at #${update.forkedAt}, before the takeover at #${update.takeover}, so no model can take over there`;
  // A re-test priced live has said here what it bills, so its button is the yes; one that replays keeps no estimate.
  const said = !update.rerecords && !!estimate?.usd;
  const kept = update.rerecords || said ? estimate : null;
  return (
    <Dialog
      title={update.rerecords ? `Update ${name}?` : `Add ${rules === 1 ? 'normalizer' : 'normalizers'} for ${name}`}
      lead={update.rerecords ? `Re-records ${name}, for a change you meant.` : `Adds the ${rules === 1 ? 'normalizer' : 'normalizers'}, the whole fix, and tests the golden again.`}
      doc={update.rerecords ? 'goldenUpdates' : 'tasks'}
      warn={{ text: busy ? busy.replace(/\.$/, '') : fork }}
      facts={asked ? (asked.live?.length ? liveFacts(asked.live) : [{ label: 'Runs live', value: asked.why }]) : []}
      command={{ command: update.steps.map((step) => commandText(step)) }}
      cost={taskUpdateCost(update, estimate, !!asked)}
      ok={update.rerecords ? (rules ? ACTIONS.addNormalizerAndUpdate.label : confirmWords(ACTIONS.updateGolden.label)) : ACTIONS.addNormalizerAndRerun.label}
      okDisabled={!!busy}
      onOk={() => (busy ? false : sendTaskUpdate({ client, watchJob, guard }, JOB_KINDS.taskUpdate, { golden: update.golden, ...sentEstimate(kept) }, asked?.confirm, said, setAsked))}
      onClose={onClose}
    >
      {rules && update.rerecords ? (
        <Copy className="muted trnote">
          First {rules === 1 ? 'a normalizer for' : 'normalizers for'} <Code>{values}</Code>, which {rules === 1 ? 'changes' : 'change'} on every run: without {rules === 1 ? 'it' : 'them'}, the next test forks there again.
        </Copy>
      ) : null}
    </Dialog>
  );
}

/** Score a model: a model the server listed, or your own endpoint, and the attempts; then `shadowlap tasks score` as a job. */
export function ScoreDialog({ view, busy, onClose }: { view: TrainingView; /** Why scoring can't start now (a repair holds the working tree), or null. */ busy: string | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const models = useLoad<ModelsView>(() => client.models(), 'models');
  const d = models.data?.dialog ?? null;
  const listed = !!models.data || !!models.error;
  const [pick, setPick] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(5);
  const [endpoint, setEndpoint] = useState({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune' });
  const nameRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const attemptsRef = useRef<HTMLSelectElement>(null);
  // The first model not scored yet, once the list is in; your own endpoint when it can't be listed.
  // The picker opens disabled while the list comes in, so the dialog starts on the next field: it
  // takes the focus once it can, unless the focus was moved on from there meanwhile.
  useEffect(() => {
    if (pick !== null || !listed) return;
    setPick(firstPick(d));
    const select = modelRef.current;
    if (select && (document.activeElement === attemptsRef.current || !select.closest('.dialog')?.contains(document.activeElement))) select.focus();
  }, [pick, listed, d]);
  useEffect(() => {
    if (pick === ENDPOINT) nameRef.current?.focus();
  }, [pick]);
  const current = pick ?? '';
  const fields = pick === null ? null : scoreFields(d, current, endpoint, attempts);
  // What the job runs: the tasks the picked model can answer, else every ready one.
  const ready = view.tasks.rows.filter((r) => r.status.key === 'ready').map((r) => r.golden);
  const command = scoreCommand(fields, ready);
  const notes = models.data ? notesLine(models.data.notes) : null;
  const leftOut = d ? leftOutLine(d.leftOut) : null;
  const note = models.error ? `The models couldn’t be listed (${models.error.message}). Your own endpoint still works.` : !listed ? 'Asking each provider for its models…' : pickNote(d, current);
  const replaces = pickReplaces(d, current, endpoint);
  return (
    <Dialog
      title={d?.title ?? `${confirmWords(ACTIONS.scoreModel.label)} on ${plural(view.tabs.tasks, 'task')}`}
      lead="Runs the model you pick from each task’s takeover, and the task’s checks score it."
      doc="scoring"
      warn={busy ? { text: busy.replace(/\.$/, '') } : null}
      factsUnder={replaces !== null ? [{ label: 'Replaces', value: `its score of ${replaces.toFixed(2)}` }] : []}
      command={command}
      cost={scoreCost(d, current, attempts, ready.length)}
      ok={confirmWords(ACTIONS.scoreModel.label)}
      okDisabled={!fields || !!busy}
      onOk={() => (!fields || busy ? false : guard(() => watchJob(client.startJob(JOB_KINDS.score, { model: fields.model, baseUrl: fields.baseUrl, attempts: fields.attempts, ...(fields.goldens ? { goldens: fields.goldens } : {}), ...sentEstimate(scoreEstimate(d, current, attempts, ready.length)) }))))}
      onClose={onClose}
    >
      <div className="form">
        <label>
          Model
          <select ref={modelRef} value={current} onChange={(e) => setPick(e.target.value)} disabled={!listed}>
            {!listed ? <option value="">Listing models…</option> : null}
            {d?.groups.map((g) => (
              <optgroup key={g} label={g}>
                {d.options.map((o, i) =>
                  o.group === g ? (
                    <option key={o.key} value={String(i)}>
                      {o.label}
                    </option>
                  ) : null,
                )}
              </optgroup>
            ))}
            {listed ? (
              <optgroup label={d?.endpoint.group ?? 'Other'}>
                <option value={ENDPOINT}>{d?.endpoint.label ?? 'Your own endpoint…'}</option>
              </optgroup>
            ) : null}
          </select>
        </label>
        <label>
          Attempts per task
          <select ref={attemptsRef} value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
            {(d?.attempts ?? [5, 10]).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pick === ENDPOINT ? (
        <div className="form trep">
          <label>
            Base URL
            <input type="text" value={endpoint.baseUrl} spellCheck={false} onChange={(e) => setEndpoint({ ...endpoint, baseUrl: e.target.value })} />
          </label>
          <label>
            Model name
            <input ref={nameRef} type="text" value={endpoint.model} spellCheck={false} onChange={(e) => setEndpoint({ ...endpoint, model: e.target.value })} />
          </label>
        </div>
      ) : null}
      {note ? <p className="muted trnote">{note}</p> : null}
      {/* Why a provider's models aren't in the list: beside the list, not beside your own endpoint, unless the endpoint is all there is. */}
      {notes && (pick !== ENDPOINT || !d?.options.length) ? <p className="trnotes">{notes}</p> : null}
      {/* Models that can't answer any ready task, and why: what `tasks score` would refuse. */}
      {leftOut && (pick !== ENDPOINT || !d?.options.length) ? <p className="trnotes">{leftOut}</p> : null}
    </Dialog>
  );
}
