import { useEffect, useRef, useState } from 'react';
import { JOB_KINDS, type ModelsView, type PairGroupView, type PipView, type TaskUpdate, type TrainingView } from '../api.js';
import { Badge, CmdLine, CommandLine, EmptyState, Kpi, PageHeader, Seg } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { tipText } from '../components/HoverCard.js';
import { Page } from '../components/Page.js';
import { rowOpen } from '../components/Table.js';
import { useTreeBusy } from '../fixes/tree.js';
import { plural, shortId } from '../format.js';
import { commandText } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { addPaletteSource, paletteSourcesChanged } from '../palette-sources.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { ENDPOINT, exportCommand, filterGroups, firstPick, leftNote, leftOutLine, noteTrainingCounts, notesLine, onTrainingCountsChange, onTrainingDialog, pickNote, pipClass, pipTip, scoreCommand, scoreFields, takeTrainingDialog, trainingPalette, whenDone, type PairChip, type TrainingDialog } from '../training.js';

/**
 * Training (#/training, #/training/tasks): preference pairs read from the attempts blame, verify and
 * --repeat left in the store, and goldens as tasks a model is scored on. The strip and the tabs show
 * on both; Export pairs and Score a model run the CLI as jobs. It reads `/api/training`, and
 * `/api/models` for the picker; words and layout follow the mock.
 */

addPaletteSource((ctx) => trainingPalette(ctx, JOB_KINDS));
// New counts that change what the palette offers rebuild it while it is open.
onTrainingCountsChange(paletteSourcesChanged);

export function TrainingPage({ tab }: { tab: 'pairs' | 'tasks' }) {
  const { client, tick, exported, actionsOff, hasKind, guard } = useApp();
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
  // The picker asks providers for their models: asked while the tab is open, the dialog opens on a list.
  useEffect(() => {
    if (tab === 'tasks' && canScore && !actionsOff) void client.models().catch(() => undefined);
  }, [tab, canScore, actionsOff, client]);

  // Scoring runs the agent from the project's working tree: not while a repair or an apply changes it.
  const busy = useTreeBusy('reads', 'score');
  const action = tab === 'pairs' ? (canExport ? { label: 'Export pairs', kind: 'export' as const, off: actionsOff } : null) : canScore ? { label: 'Score a model', kind: 'score' as const, off: actionsOff ?? busy } : null;
  return (
    <Page>
      <PageHeader
        eyebrow="pairs · tasks · on this machine"
        title="Training"
        text={
          <>
            <span className="ln">Answers to prefer, from attempts already in the store,</span> <span className="ln">and your goldens as tasks to score.</span>
          </>
        }
        actions={
          action ? (
            <button className="btn lime" type="button" disabled={!!action.off} title={action.off ?? undefined} onClick={() => guard(() => setDialog(action.kind))}>
              {action.label}
            </button>
          ) : null
        }
      />
      {view ? (
        <>
          <TrainingStrip view={view} />
          <nav className="stabs" aria-label="Training">
            <a href={href.training('pairs')} aria-current={tab === 'pairs' ? 'page' : undefined}>
              Pairs<b>{view.tabs.pairs.toLocaleString('en-US')}</b>
            </a>
            <a href={href.training('tasks')} aria-current={tab === 'tasks' ? 'page' : undefined}>
              Tasks<b>{view.tabs.tasks.toLocaleString('en-US')}</b>
            </a>
          </nav>
          {tab === 'tasks' ? <TasksTab view={view} /> : <PairsTab view={view} />}
        </>
      ) : loaded.error ? (
        <EmptyState title="Training can’t be read" text={loaded.error.message} />
      ) : exported ? (
        <EmptyState title="Not in an exported copy" text="An exported copy holds runs and Compare between them. Training reads the store: open it from shadowlap dashboard." />
      ) : (
        <div className="empty">Reading pairs and tasks…</div>
      )}
      {dialog === 'export' && view ? <ExportPairsDialog view={view} onClose={() => setDialog(null)} /> : null}
      {dialog === 'score' && view ? <ScoreDialog view={view} busy={busy} onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------- the strip

/** The same four numbers on both tabs: what there is, what's usable, how models did, and what the last export wrote. */
function TrainingStrip({ view }: { view: TrainingView }) {
  const { pairs, tasks, best, left } = view.strip;
  const count = (v: string) => (/^\d+$/.test(v) ? Number(v).toLocaleString('en-US') : v);
  return (
    <div className="panel kstrip">
      <Kpi k="Pairs" value={count(pairs.value)} note={pairs.sub} tone="lime" href={href.training('pairs')} />
      <Kpi k="Tasks ready" value={tasks.value} note={tasks.sub} href={href.training('tasks')} />
      <Kpi k="Best mean score" value={best.value} note={best.sub} href={href.training('tasks')} />
      <Kpi k="Exported" value={count(left.value)} note={left.file ? <span title={left.file === '-' ? 'Written to standard output' : `Written to ${left.file}`}>{leftNote(left)}</span> : left.sub} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- pairs

function PairsTab({ view }: { view: TrainingView }) {
  const [chip, setChip] = useState<PairChip>('all');
  const p = view.pairs;
  if (p.empty) return <EmptyState title={p.empty.title} text={p.empty.text} command={p.empty.command} />;
  const groups = filterGroups(p.groups, chip);
  return (
    <>
      <section className="panel">
        <header>
          <h2>Pairs</h2>
          <span className="sub">one answer that lost the run, one that went on to pass</span>
          <span className="sp" />
          <Seg
            label="Confidence"
            value={chip}
            onChange={setChip}
            items={[
              { key: 'all', label: `All ${p.counts.all}` },
              { key: 'high', label: `High ${p.counts.high}` },
              { key: 'medium', label: `Medium ${p.counts.medium}` },
            ]}
          />
        </header>
        <div className="pgroups">
          {groups.map((g) => (
            <PairGroup key={g.key} g={g} />
          ))}
          {groups.length ? null : <div className="empty">No pairs here.</div>}
        </div>
      </section>
      <div className="grid2 trgap">
        <section className="panel">
          <header>
            <h2>Where they come from</h2>
            <span className="sub">attempts already in the store</span>
          </header>
          <div className="srcs">
            {p.sources.map((s) => (
              <a key={s.key} href={s.href}>
                <span className={`sn${s.made ? '' : ' zero'}`}>{s.made}</span>
                <span>
                  <b>{s.label}</b>
                  <span className="rsub">{s.why}</span>
                </span>
                {s.made && s.confidence ? <Badge tone={s.confidence === 'high' ? 'ok' : 'y'}>{s.confidence}</Badge> : null}
              </a>
            ))}
          </div>
        </section>
        <section className="panel fcol">
          <header>
            <h2>Confidence</h2>
            <span className="sub">how sure a pair is</span>
          </header>
          <div className="lrows">
            {p.confidence.map((c) => (
              <div key={c.level}>
                <Badge tone={c.level === 'high' ? 'ok' : 'y'}>{c.level}</Badge>
                <span>
                  <b>{c.title}</b>
                  <span className="rsub">{c.sub}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="pfootnote">{p.footnote}</p>
        </section>
      </div>
    </>
  );
}

/**
 * Pairs from the same call share their conversation and rejected answer, so they show as one group,
 * headed by the run they are about at that call. A verify or `--repeat` answer came from an attempt
 * at that run: each answer links its own attempt. When the run never made that call (the change
 * verified added a step before it), the attempt heads the group, and says which run it replayed.
 */
function PairGroup({ g }: { g: PairGroupView }) {
  const ownAttempt = g.rejected.runId !== g.runId;
  return (
    <div className="pgroup">
      <div className="pg1">
        <Badge tone={g.confidence === 'high' ? 'ok' : 'y'}>{g.confidence}</Badge>
        <a className="more" href={g.href} title={g.attemptOf ? 'Open the attempt at this call' : 'Open the run at this call'}>
          <code>{shortId(g.runId)}</code> #{g.callNo}
        </a>
        {g.attemptOf ? (
          <span className="pgof" title="The run it replayed never got here: the attempt took another path before this call">
            attempt of{' '}
            <a href={g.attemptOf.href}>
              <code>{shortId(g.attemptOf.runId)}</code>
            </a>
          </span>
        ) : null}
        {g.fix ? (
          <a className="chip" href={g.fix.href} title={`Open the fix: ${g.fix.label}`}>
            {g.fix.label}
          </a>
        ) : null}
        <span className="pgsrc">{g.from}</span>
        <span className="sp" />
        <span className="pgn">{plural(g.count, 'pair')}</span>
      </div>
      {g.context ? <p className="pctx">{g.context}</p> : null}
      <div className="ans">
        <div>
          <span className="k">rejected · {g.rejected.what}</span>
          <code>{g.rejected.text}</code>
          {ownAttempt ? (
            <small className="rj">
              <a href={g.rejected.href} title="Open the attempt at this call">
                {shortId(g.rejected.runId)}
              </a>
            </small>
          ) : null}
        </div>
        <div className="good">
          <span className="k">{g.chosenLabel}</span>
          <ul className="alts">
            {g.chosen.map((c) => (
              <li key={`${c.runId}:${c.callNo}`}>
                <code>{c.text}</code>
                <small>
                  <a href={c.href} title="Open the attempt at this call">
                    {shortId(c.runId)}
                  </a>
                </small>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- tasks

function TasksTab({ view }: { view: TrainingView }) {
  const { actionsOff, hasKind, guard } = useApp();
  const [updating, setUpdating] = useState<{ update: TaskUpdate; name: string } | null>(null);
  // Updating a golden runs the agent from the working tree: not while a repair or an apply changes it.
  const busy = useTreeBusy('reads', 'update the golden');
  const t = view.tasks;
  if (t.error) return <EmptyState title="The tasks can’t be read" text={t.error} command="shadowlap tasks" />;
  if (t.empty) return <EmptyState title={t.empty.title} text={t.empty.text} command={t.empty.command} />;
  const w = t.warning;
  // A task its test's early fork blocks: Update the golden, off with the reason when nothing can run.
  const canUpdate = hasKind(JOB_KINDS.taskUpdate);
  const updateOff = actionsOff ?? busy;
  const updateButton = (u: TaskUpdate, name: string, cls: string) => (
    <button className={cls} type="button" disabled={!!updateOff} title={updateOff ?? `Re-record ${name} as your agent runs now, so its test replays up to the takeover`} onClick={() => guard(() => setUpdating({ update: u, name }))}>
      Update the golden…
    </button>
  );
  return (
    <>
      {w ? (
        <div className="verdict warn">
          <Badge tone="y">one-sided</Badge>
          <div>
            <h2>Every ready task rewards the same thing</h2>
            <p>
              All of them reward “{w.rewards}”, so a model that learned only that would score full marks.
              {w.name ? (
                <>
                  {' '}
                  <code>{w.name}</code> rewards the opposite once {w.once}.
                </>
              ) : null}
            </p>
          </div>
          {w.fix?.update ? (
            canUpdate ? <div className="actions">{updateButton(w.fix.update, w.name ?? w.fix.update.golden, 'btn sm')}</div> : null
          ) : w.fix?.href ? (
            <div className="actions">
              <a className="btn sm" href={w.fix.href}>
                {w.fix.label}
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
      <section className="panel">
        <header>
          <h2>Tasks</h2>
          <span className="sub">a model takes over at one call, and the checks score what it did</span>
        </header>
        <div className="tscroll">
          <table className="t gt tasks">
            <thead>
              <tr>
                <th>Task</th>
                <th className="hide-sm">Scored by</th>
                <th className="hide-md">After the takeover</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.golden} className={r.href ? undefined : 'static'} onClick={r.href ? rowOpen(() => navigate(r.href!)) : undefined}>
                  <td>
                    {r.href ? (
                      <a className="rlink" href={r.href} title={r.opens ?? undefined}>
                        <code>{r.name}</code>
                      </a>
                    ) : (
                      <code>{r.name}</code>
                    )}
                    <span className="rsub">{r.sub}</span>
                  </td>
                  <td className="chk hide-sm">
                    {r.checks.map((c) => (
                      <span key={c}>{c}</span>
                    ))}
                  </td>
                  <td className="hide-md">
                    {r.after && (r.after.live.length || r.after.stubbed.length) ? (
                      <div className="tchips">
                        {r.after.live.map((n) => (
                          <span key={`l:${n}`} className="tchip">
                            <code>{n}</code>
                            <em>live</em>
                          </span>
                        ))}
                        {r.after.stubbed.map((n) => (
                          <span key={`s:${n}`} className="tchip s">
                            <code>{n}</code>
                            <em>stubbed</em>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <Badge tone={r.status.badge}>{r.status.label}</Badge>
                    {r.status.short ? <span className="rsub">{r.status.short}</span> : null}
                    {r.update && canUpdate ? <div className="trupd">{updateButton(r.update, r.name, 'btn sm')}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {updating ? <UpdateGoldenDialog name={updating.name} update={updating.update} busy={updateOff} onClose={() => setUpdating(null)} /> : null}
      <Scores view={view} />
      <div className="grid2 trgap">
        <section className="panel">
          <header>
            <h2>From a training loop</h2>
            <span className="sub">one HTTP call per attempt</span>
          </header>
          <div className="pbody">
            <p className="muted">Serve the model you’re training on an OpenAI-compatible endpoint. Each attempt returns its score, to use as the reward.</p>
            <CmdLine>{view.serve?.command ?? 'shadowlap tasks serve goldens/ --port 4779'}</CmdLine>
            {view.serve ? (
              <>
                {/* Nothing was asked: an example, with a placeholder run and one check missed, so a score reads as the share passed. */}
                <p className="muted trafter">For example, one attempt and the score it answers with:</p>
                <pre tabIndex={0} className="report trserve">{`${view.serve.request}\n\n${view.serve.response}`}</pre>
              </>
            ) : (
              <p className="muted trafter">Once a task is ready, each request scores one attempt at it.</p>
            )}
          </div>
        </section>
        <section className="panel">
          <header>
            <h2>What a score can’t tell you</h2>
          </header>
          <div className="lrows">
            <div>
              <span>
                <b>Reads run live.</b>
                <span className="rsub">
                  After the takeover, read tools call the real services, so those must be up. <code>--reads replay</code> serves matching calls from the recording instead.
                </span>
              </span>
            </div>
            <div>
              <span>
                <b>Writes are stubbed.</b>
                <span className="rsub">A task can’t score what a write would have caused.</span>
              </span>
            </div>
            <div>
              <span>
                <b>A model learns what the checks reward.</b>
                <span className="rsub">
                  Weak checks teach the wrong thing
                  {t.weak ? (
                    <>
                      . That’s why <code>{t.weak}</code> isn’t a task.
                    </>
                  ) : (
                    '.'
                  )}
                </span>
              </span>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/** A card per model, then a pip per attempt on each ready task, each opening its run. */
function Scores({ view }: { view: TrainingView }) {
  const s = view.scores;
  return (
    <section className="panel trgap">
      <header>
        <h2>Scores</h2>
        <span className="sub">{s.sub}</span>
      </header>
      {s.empty ? (
        <div className="pbody">
          <p className="muted flat">{s.empty}</p>
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
      <p className="pfootnote">{s.footnote}</p>
    </section>
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
function ExportPairsDialog({ view, onClose }: { view: TrainingView; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const d = view.exportDialog;
  const [format, setFormat] = useState<string>(d.formats[0]?.value ?? 'openai-preference');
  const [min, setMin] = useState<'high' | 'medium'>(d.high ? 'high' : 'medium');
  return (
    <Dialog
      title={d.title}
      text={d.text}
      ok="Export"
      onOk={() =>
        guard(() => {
          watchJob(client.startJob(JOB_KINDS.pairs, { format, minConfidence: min }));
          onClose();
        })
      }
      onClose={onClose}
    >
      <div className="form">
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
      <p className="muted trnote">
        It writes <code>{d.out}</code> in the project folder, and the job’s drawer offers it for download.
      </p>
      <CommandLine command={exportCommand(format, min, d.out)} />
    </Dialog>
  );
}

/**
 * Update the golden of a task whose test forks before its takeover: what it runs and why, then the
 * job. The server builds the commands again from the store and the config; these are shown so the
 * change to the config and the working tree is plain before it is made.
 */
function UpdateGoldenDialog({ name, update, busy, onClose }: { name: string; update: TaskUpdate; /** Why nothing can run now, or null. */ busy: string | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const rules = update.normalizers.length;
  const values = update.normalizers.join(', ');
  const fork = `Its test forks at #${update.forkedAt}, before the takeover at #${update.takeover}, so no model can take over there.`;
  const text = update.rerecords
    ? `${fork} Updating re-records it live from its first call, with every write tool stubbed, and replaces it in your working tree only if its checks pass. It calls your providers.`
    : `${fork} Only ${rules === 1 ? 'a value that changes' : 'values that change'} every run differ there: the ${rules === 1 ? 'normalizer is' : 'normalizers are'} the whole fix, and the golden is tested again.`;
  return (
    <Dialog
      title={update.rerecords ? `Update ${name}?` : `Add the ${rules === 1 ? 'normalizer' : 'normalizers'} for ${name}?`}
      text={text}
      ok={update.rerecords ? (rules ? 'Add and update' : 'Update') : 'Add and test'}
      okDisabled={!!busy}
      onOk={() => {
        if (busy) return;
        guard(() => {
          watchJob(client.startJob(JOB_KINDS.taskUpdate, { golden: update.golden }));
          onClose();
        });
      }}
      onClose={onClose}
    >
      {rules && update.rerecords ? (
        <p className="muted trnote">
          First {rules === 1 ? 'a normalizer for' : 'normalizers for'} <code>{values}</code>, which {rules === 1 ? 'changes' : 'change'} on every run: without {rules === 1 ? 'it' : 'them'}, the next test forks there again.
        </p>
      ) : null}
      <div className="trsteps">
        {update.steps.map((step) => (
          <CmdLine key={step.join(' ')}>{commandText(step)}</CmdLine>
        ))}
      </div>
      {busy ? <p className="trbusy">{busy}</p> : null}
    </Dialog>
  );
}

/** Score a model: a model the server listed, or your own endpoint, and the attempts; then `shadowlap tasks score` as a job. */
function ScoreDialog({ view, busy, onClose }: { view: TrainingView; /** Why scoring can't start now (a repair holds the working tree), or null. */ busy: string | null; onClose: () => void }) {
  const { client, watchJob, guard } = useApp();
  const models = useLoad<ModelsView>(() => client.models(), 'models');
  const d = models.data?.dialog ?? null;
  const listed = !!models.data || !!models.error;
  const [pick, setPick] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(5);
  const [endpoint, setEndpoint] = useState({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune' });
  const nameRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  // The first model not scored yet, once the list is in; your own endpoint when it can't be listed.
  // The picker opens disabled while the list comes in, so the dialog couldn't focus it: it takes the
  // focus once it can, unless it was moved to another field of the dialog meanwhile.
  useEffect(() => {
    if (pick !== null || !listed) return;
    setPick(firstPick(d));
    const select = modelRef.current;
    if (select && !select.closest('.dialog')?.contains(document.activeElement)) select.focus();
  }, [pick, listed, d]);
  useEffect(() => {
    if (pick === ENDPOINT) nameRef.current?.focus();
  }, [pick]);
  const current = pick ?? '';
  const fields = pick === null ? null : scoreFields(d, current, endpoint, attempts);
  // What the job runs: the tasks the picked model can answer, else every ready one.
  const command = scoreCommand(fields, view.tasks.rows.filter((r) => r.status.key === 'ready').map((r) => r.golden));
  const notes = models.data ? notesLine(models.data.notes) : null;
  const leftOut = d ? leftOutLine(d.leftOut) : null;
  const note = models.error ? `The models couldn’t be listed (${models.error.message}). Your own endpoint still works.` : !listed ? 'Asking each provider for its models…' : pickNote(d, current, endpoint);
  return (
    <Dialog
      title={d?.title ?? `Score a model on ${plural(view.tabs.tasks, 'task')}`}
      text="Each attempt replays the calls before the takeover from the recording, then runs the rest against this model with writes stubbed. The checks score it."
      ok="Score"
      okDisabled={!fields || !!busy}
      onOk={() => {
        if (!fields || busy) return;
        guard(() => {
          watchJob(client.startJob(JOB_KINDS.score, { model: fields.model, baseUrl: fields.baseUrl, attempts: fields.attempts, ...(fields.goldens ? { goldens: fields.goldens } : {}) }));
          onClose();
        });
      }}
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
          <select value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
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
      {command ? <CommandLine command={command} /> : null}
      {busy ? <p className="trbusy">{busy}</p> : null}
      {/* Why a provider's models aren't in the list: beside the list, not beside your own endpoint, unless the endpoint is all there is. */}
      {notes && (pick !== ENDPOINT || !d?.options.length) ? <p className="trnotes">{notes}</p> : null}
      {/* Models that can't answer any ready task, and why: what `tasks score` would refuse. */}
      {leftOut && (pick !== ENDPOINT || !d?.options.length) ? <p className="trnotes">{leftOut}</p> : null}
    </Dialog>
  );
}
