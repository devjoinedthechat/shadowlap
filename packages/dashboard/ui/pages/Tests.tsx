import { useEffect, useState, type ReactNode } from 'react';
import { JOB_KINDS, type BisectMiss, type BisectRevision, type DivergenceView, type FailureView, type FoundCommit, type GoldenRow, type InconclusiveView, type TestsView } from '../api.js';
import { Badge, CmdLine, EmptyState, PageHeader } from '../components/bits.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { rowOpen } from '../components/Table.js';
import { copyText } from '../dom.js';
import { treeBusy } from '../fixes/model.js';
import { useServerJobs } from '../fixes/tree.js';
import { asksUpdate, checkWords, commandText, divergenceButtons, failureHint, failureLines, findCommitButton, foundLine, historyTip, inconclusiveHint, inconclusiveLines, missedLine, reportLines, revLabel, sessionLine, sessionWait, sourceText, testsBusy, type ReportLine } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { addPaletteSource, paletteSourcesChanged } from '../palette-sources.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { keepTests, onTestsChanged, testsPaletteCommands } from '../tests-palette.js';
import { FindCommitDialog, NormalizeUpdateDialog, UpdateGoldensDialog } from './TestsDialogs.js';

/**
 * Tests (#/tests): every golden CI replays offline and how it did at each revision. The verdict for
 * the goldens' last results, the table (where each came from, its mode, checks, history and last
 * result), each failure as the CLI prints it with what fixes it, and how to run them in CI.
 */

/** The jobs that change what this page shows: while one of this tab's runs, the verdict's session reads as running. */
const TEST_KINDS = new Set<string>([JOB_KINDS.tests, JOB_KINDS.testUpdate, JOB_KINDS.normalizeAndTest]);

type Open =
  | { kind: 'update'; paths: string[] }
  | { kind: 'bisect'; name: string; golden: string; range: { good: string; bad: string | null } | null; live: boolean; revisions: BisectRevision[]; tried: string | null }
  | { kind: 'normalize-update'; name: string; golden: string; steps: string[][] };

// The palette's Tests group on every page (tests-palette.ts): an open palette reads it again once the goldens land.
addPaletteSource(({ app, go }) => testsPaletteCommands(app, go, { update: app.hasKind(JOB_KINDS.testUpdate) }));
onTestsChanged(paletteSourcesChanged);

export function TestsPage() {
  const app = useApp();
  const { client, tick, hasKind, actionsOff, guard, watchJob, jobs, toast, meta } = app;
  const loaded = useLoad(() => client.tests(), 'tests', tick);
  const view = loaded.data;
  const [open, setOpen] = useState<Open | null>(null);
  const running = jobs.some((w) => !w.job.done && !w.lost && TEST_KINDS.has(w.job.kind ?? ''));
  // What the server is running, from every tab and terminal dashboard: a test job (Find the commit
  // on a golden among them), a test session started in a terminal, or a repair holding the working
  // tree makes it refuse an action that replays or rewrites the goldens.
  const serverJobs = useServerJobs();
  const wait = (verb: string): string | null => actionsOff ?? testsBusy(serverJobs, verb, meta?.project?.id ?? null) ?? sessionWait(view, verb) ?? treeBusy(serverJobs, 'reads', verb, meta?.project?.path ?? null);

  useEffect(() => {
    if (view) keepTests(view);
  }, [view]);

  // Update goldens…, asked for by the palette or a link (#/tests?update), on arriving here or while
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
    // Asked once: `wait` reads the jobs as they are when it is.
  }, [asked, view, actionsOff, hasKind, toast]);

  const start = (kind: string, fields: Record<string, unknown>) => {
    setOpen(null);
    guard(() => watchJob(client.startJob(kind, fields)));
  };
  const header = (actions?: ReactNode) => <PageHeader eyebrow="goldens · shadowlap test" title="Tests" text="Every recording CI replays offline, and how it did at each revision." actions={actions} />;

  if (!view) {
    return (
      <Page>
        {header()}
        {loaded.error ? <EmptyState title="Tests could not be loaded" text={loaded.error.message} /> : <div className="empty">Loading the goldens…</div>}
      </Page>
    );
  }
  if (view.empty) {
    return (
      <Page>
        {header()}
        <EmptyState title="No goldens yet" text="Pack a run you consider correct into the repository, and CI replays it offline on every commit." command={view.commands.pack} />
      </Page>
    );
  }

  const runWait = wait('run the tests');
  const updateWait = wait('update them');
  const findWait = wait('find the commit');
  const actions = (
    <>
      <a className="btn" href={href.settings('alerts')}>
        <Icon name="bell" />
        CI settings
      </a>
      {view.diverged.length && hasKind(JOB_KINDS.testUpdate) ? (
        <button className="btn" type="button" disabled={!!updateWait} title={updateWait ?? undefined} onClick={() => guard(() => setOpen({ kind: 'update', paths: view.diverged }))}>
          Update goldens…
        </button>
      ) : null}
      <button className="btn" type="button" onClick={() => void copyText(view.commands.ci).then((ok) => toast(ok ? 'Copied the CI command' : 'Copying was refused by the browser'))}>
        Copy CI command
      </button>
      {hasKind(JOB_KINDS.tests) ? (
        <button className="btn lime" type="button" disabled={!!runWait} title={runWait ?? undefined} onClick={() => start(JOB_KINDS.tests, {})}>
          Run tests
        </button>
      ) : null}
    </>
  );

  const normalize = (d: DivergenceView) => {
    const run = divergenceButtons(d, hasKind).normalize?.run;
    if (run === 'rerun') start(JOB_KINDS.tests, { golden: d.golden });
    // The rules alone can't make it match: the golden is re-recorded after them, so it asks first.
    else if (run === 'normalize-update' && d.normalizeAndTest) setOpen({ kind: 'normalize-update', name: d.name, golden: d.golden, steps: d.normalizeAndTest });
    else if (run === 'normalize') start(JOB_KINDS.normalizeAndTest, { golden: d.golden });
  };
  const findCommit = (f: Pick<DivergenceView, 'name' | 'golden' | 'bisect' | 'missed' | 'revisions'>) => {
    // Once a search over the known range named no first bad commit, it asks for an older good one.
    const range = f.missed ? null : f.bisect;
    const live = range?.live ?? view.rows.find((r) => r.path === f.golden)?.mode === 'fork';
    // Free replays over a known range start at once; a search that needs a good commit, or costs tokens, asks first.
    if (range && !live) start(JOB_KINDS.bisect, { golden: f.golden, good: range.good, ...(range.bad ? { bad: range.bad } : {}) });
    else setOpen({ kind: 'bisect', name: f.name, golden: f.golden, range: range ? { good: range.good, bad: range.bad } : null, live, revisions: f.revisions, tried: f.missed?.good ?? null });
  };

  return (
    <Page>
      {header(actions)}
      <Verdict view={view} running={running} />
      <section className="panel tscroll">
        <table className="t gt">
          <thead>
            <tr>
              <th>Golden</th>
              <th className="hide-sm">Mode</th>
              <th className="hide-sm">Checks</th>
              {view.revisions.length ? (
                <th className="hist hide-sm">
                  {view.revisions.map((r, i) => (
                    <span key={`${r}:${i}`} data-tip={tipText(r ? `revision ${r}` : 'no revision: not in a git repository')}>
                      {revLabel(r)}
                    </span>
                  ))}
                </th>
              ) : null}
              <th>Last result</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <GoldenTr key={row.path} row={row} showHistory={view.revisions.length > 0} />
            ))}
          </tbody>
        </table>
      </section>
      {view.divergences.map((d) => {
        const b = divergenceButtons(d, hasKind);
        const normalizeWait = wait(b.normalize?.run === 'rerun' ? 'run it again' : 'add the normalizer');
        const goldenWait = wait('update it');
        return (
          <ReportPanel key={d.golden} name={d.name} runId={d.runId} lines={reportLines(d.text)} found={d.found} missed={d.missed}>
            {b.note === 'maybe-real' && d.volatile ? (
              <p className="hintx tnote">
                <code>{d.volatile.path}</code> changed, and it may be a real change, such as another customer or another order. If it is made anew on every run, add the normalizer; if the change was intended, update the golden.
              </p>
            ) : b.note ? (
              <p className="hintx tnote">
                The normalizer for <code>{d.volatile?.path ?? 'it'}</code> is in shadowlap.config.json now. {b.note === 'rules-added' ? 'Run the golden again to see it pass.' : 'It masks the value, but the request also carries what the recording never had: update the golden.'}
              </p>
            ) : null}
            <div className="actions">
              {b.normalize ? (
                <button className={`btn${b.normalize.lead ? ' lime' : ''}`} type="button" disabled={!!normalizeWait} title={normalizeWait ?? undefined} onClick={() => guard(() => normalize(d))}>
                  {b.normalize.label}
                </button>
              ) : null}
              {b.update ? (
                <button className="btn" type="button" disabled={!!goldenWait} title={goldenWait ?? undefined} onClick={() => guard(() => setOpen({ kind: 'update', paths: [d.golden] }))}>
                  Update golden
                </button>
              ) : null}
              {b.bisect ? (
                <button className="btn" type="button" disabled={!!findWait} title={findWait ?? undefined} onClick={() => guard(() => findCommit(d))}>
                  {b.bisect.range && !b.bisect.live ? 'Find the commit' : 'Find the commit…'}
                </button>
              ) : null}
            </div>
            <p className="hintx">Normalizers apply at match time, so older goldens keep working. Update a golden only when the change was intended.</p>
          </ReportPanel>
        );
      })}
      {view.failures.map((f) => (
        <FailurePanel key={f.golden} f={f} off={findWait ?? undefined} button={findCommitButton(f, hasKind)} onBisect={() => guard(() => findCommit(f))} />
      ))}
      {view.inconclusive.map((v) => (
        <InconclusivePanel key={v.golden} v={v} off={runWait ?? undefined} canRun={hasKind(JOB_KINDS.tests)} onMore={(job) => start(JOB_KINDS.tests, job)} />
      ))}
      <div className="grid2 gpanel">
        <section className="panel">
          <header>
            <h2>In CI</h2>
          </header>
          <div className="pbody">
            <p className="muted">Each golden is unpacked into a throwaway store and replayed with every provider offline. A divergence, a live call, a non-zero exit or a failed check fails it.</p>
            <CmdLine>{view.commands.inCi}</CmdLine>
          </div>
        </section>
        <section className="panel">
          <header>
            <h2>Add a golden</h2>
          </header>
          <div className="pbody">
            <p className="muted">Pack a run you consider correct into the repository. Redaction rules apply to the copy.</p>
            <CmdLine>{view.commands.pack}</CmdLine>
            <p className="muted after">
              A golden with outcome checks is also a task a model can be scored on.{' '}
              <a className="more" href={href.training('tasks')}>
                Training tasks
              </a>
            </p>
          </div>
        </section>
      </div>
      <p className="hintx tfoot">{view.note}</p>
      {/* The dialog already says what an update does, so what it offers instead starts at once: the
          rule and a re-run, the rule and the update it still needs, or a re-run alone. */}
      {open?.kind === 'update' ? (
        <UpdateGoldensDialog
          view={view}
          paths={open.paths}
          has={hasKind}
          onClose={() => setOpen(null)}
          onUpdate={() => start(JOB_KINDS.testUpdate, open.paths.length === 1 ? { golden: open.paths[0] } : { goldens: open.paths })}
          onInstead={(i) => start(i.run === 'rerun' ? JOB_KINDS.tests : JOB_KINDS.normalizeAndTest, { golden: i.golden })}
        />
      ) : null}
      {open?.kind === 'bisect' ? (
        <FindCommitDialog
          name={open.name}
          golden={open.golden}
          range={open.range}
          live={open.live}
          revisions={open.revisions}
          tried={open.tried}
          onClose={() => setOpen(null)}
          onRun={(good, bad) => start(JOB_KINDS.bisect, { golden: open.golden, good, ...(bad ? { bad } : {}) })}
        />
      ) : null}
      {open?.kind === 'normalize-update' ? <NormalizeUpdateDialog name={open.name} steps={open.steps} onClose={() => setOpen(null)} onRun={() => start(JOB_KINDS.normalizeAndTest, { golden: open.golden })} /> : null}
    </Page>
  );
}

function Verdict({ view, running }: { view: TestsView; running: boolean }) {
  const v = view.verdict;
  if (!v) {
    const command = commandText(view.commands.run);
    return (
      <div className="verdict tv n">
        <Badge tone="n">not run yet</Badge>
        <div>
          <h2>{view.goldens === 1 ? 'One golden, not tested yet' : `${view.goldens} goldens, none tested yet`}</h2>
          <p>
            Run tests replays each one offline: <SessionCommand text={command} />
          </p>
        </div>
      </div>
    );
  }
  const line = sessionLine(view, running)!;
  const failing = v.state === 'failing';
  // Inconclusive goldens, and none failing: amber, neither passing nor failing.
  const unsure = v.state === 'inconclusive';
  return (
    <div className={`verdict tv ${failing ? 'no' : unsure ? 'warn' : 'ok'}`}>
      <Badge tone={failing ? 'no' : unsure ? 'y' : 'ok'}>{failing ? `${v.failing} failing` : unsure ? `${v.inconclusive} inconclusive` : 'passing'}</Badge>
      <div>
        <h2>{v.title}</h2>
        <p>
          <SessionCommand text={line.command} /> · {line.rest}
          {line.since ? (
            <>
              {' · '}
              <span className="tsince" data-tip={line.sinceTip ? tipText(line.sinceTip) : undefined}>
                {line.since}
              </span>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/** The session's command on the verdict's line: on one line, cut short with its whole text on hover when it is longer than the line. */
function SessionCommand({ text }: { text: string }) {
  return (
    <code className="vcmd" data-tip={tipText(text)}>
      {text}
    </code>
  );
}

function GoldenTr({ row, showHistory }: { row: GoldenRow; showHistory: boolean }) {
  const source = sourceText(row);
  const last = row.last;
  return (
    <tr className={row.runId ? undefined : 'still'} onClick={row.runId ? rowOpen(() => navigate(href.run(row.runId!))) : undefined}>
      <td>
        <code>{row.name}</code>
        <span className="rsub gsrc">
          {'runId' in source ? (
            <>
              from{' '}
              <a className="more" href={href.run(source.runId)}>
                {source.runId.slice(0, 10)}
              </a>
            </>
          ) : (
            source.text
          )}
        </span>
      </td>
      <td className="hide-sm">
        <span className="chip" data-tip={tipText(row.modeHint)}>
          {row.modeLabel}
        </span>
      </td>
      <td className="chk hide-sm">
        {row.checks.length ? (
          row.checks.map((c, i) => <span key={`${c}:${i}`}>{checkWords(c)}</span>)
        ) : (
          <em className="nil" data-tip={tipText('No checks in shadowlap.config.json: it passes when it replays and the agent exits 0')}>
            exit status only
          </em>
        )}
      </td>
      {showHistory ? (
        <td className="hist hide-sm">
          {row.history.map((h, i) => {
            const t = historyTip(h, row.name);
            return (
              <i
                key={`${h.revision}:${i}`}
                className={`${h.verdict === 'inconclusive' ? 'inc' : (h.result ?? 'none')}${h.updated ? ' upd' : ''}${h.runId ? ' go' : ''}`}
                data-tip={tipCard(t.title, [{ label: t.label, value: t.value, color: t.color }])}
                onClick={
                  h.runId
                    ? (e) => {
                        e.stopPropagation();
                        navigate(href.run(h.runId!));
                      }
                    : undefined
                }
              />
            );
          })}
        </td>
      ) : null}
      <td>
        {last.verdict === 'inconclusive' ? (
          <span className="st warn">
            <i />
            inconclusive
          </span>
        ) : last.result === 'pass' ? (
          <span className="st ok">
            <i />
            passed
          </span>
        ) : last.result === 'fail' ? (
          <span className="st err">
            <i />
            failed
          </span>
        ) : row.error ? (
          <span className="st err">
            <i />
            can’t be read
          </span>
        ) : (
          <span className="st n">not run yet</span>
        )}
        {last.result !== null || row.error ? <span className="rsub">{last.line}</span> : null}
      </td>
    </tr>
  );
}

function ReportLines({ lines }: { lines: ReportLine[] }) {
  return (
    <pre className="report">
      {lines.map((l, i) => (
        <span key={i} className={l.tone || undefined}>
          {l.text}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}

/** What Find the commit found: the first bad commit, its message, who made it, when, and what it cost. */
function BisectCard({ found }: { found: FoundCommit }) {
  const f = foundLine(found);
  return (
    <div className="bisect" data-tip={found.why ? tipText(found.why) : undefined}>
      <span className="k">first bad commit</span>
      <code>{f.rev}</code>
      <b>{f.subject}</b>
      <span className="m">{f.meta}</span>
      {found.untested.length ? <span className="m">or one just before it that could not be tested: {found.untested.join(', ')}</span> : null}
    </div>
  );
}

/** Find the commit named no first bad commit between the commits it was given: where it looked, and why. */
function BisectMissLine({ missed }: { missed: BisectMiss }) {
  return (
    <div className="bisect miss">
      <span className="k">find the commit</span>
      <span className="m">{missedLine(missed)}</span>
    </div>
  );
}

/** A failed golden's report, as the CLI prints it, with what Find the commit found (or that it found none) above the buttons. */
function ReportPanel({ name, runId, lines, found, missed, children }: { name: string; runId: string | null; lines: ReportLine[]; found: FoundCommit | null; missed: BisectMiss | null; children: ReactNode }) {
  return (
    <section className="panel gpanel">
      <header>
        <h2>{name}</h2>
        <span className="sub">as the report prints it</span>
        <span className="sp" />
        {runId ? (
          <a className="more" href={href.run(runId)}>
            Open the run
          </a>
        ) : null}
      </header>
      <div className="pbody">
        <ReportLines lines={lines} />
        {found ? <BisectCard found={found} /> : missed ? <BisectMissLine missed={missed} /> : null}
        {children}
      </div>
    </section>
  );
}

/**
 * A golden neither passed nor failed: its gate ran out of attempts between its bounds, or a check
 * couldn't be judged. Its report, and for a gate, Run more attempts, which continues it to twice its
 * limit with the attempts it has.
 */
function InconclusivePanel({ v, off, canRun, onMore }: { v: InconclusiveView; off: string | undefined; canRun: boolean; onMore: (job: { golden: string; maxAttempts: number; continue: true }) => void }) {
  const more = v.gate?.more ?? null;
  return (
    <ReportPanel name={v.name} runId={v.runId} lines={inconclusiveLines(v)} found={null} missed={null}>
      {more && canRun ? (
        <div className="actions">
          <button className="btn lime" type="button" disabled={!!off} title={off ?? commandText(more.args)} onClick={() => onMore(more.job)}>
            Run more attempts
          </button>
        </div>
      ) : null}
      <p className="hintx">{inconclusiveHint(v)}</p>
    </ReportPanel>
  );
}

/** A failed check, a non-zero exit, no calls: as `test --markdown` prints it, with no normalizer to offer. */
function FailurePanel({ f, off, button, onBisect }: { f: FailureView; off: string | undefined; button: { range: boolean; live: boolean } | null; onBisect: () => void }) {
  return (
    <ReportPanel name={f.name} runId={f.runId} lines={failureLines(f)} found={f.found} missed={f.missed}>
      {button ? (
        <div className="actions">
          <button className="btn" type="button" disabled={!!off} title={off} onClick={onBisect}>
            {button.range && !button.live ? 'Find the commit' : 'Find the commit…'}
          </button>
        </div>
      ) : null}
      <p className="hintx">{failureHint(f)}</p>
    </ReportPanel>
  );
}
