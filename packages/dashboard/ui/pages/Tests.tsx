import { useEffect, useState, type ReactNode } from 'react';
import { JOB_KINDS, type DivergenceView, type FailureView, type FoundCommit, type GoldenRow, type TestsView } from '../api.js';
import { Badge, CmdLine, EmptyState, PageHeader } from '../components/bits.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { rowOpen } from '../components/Table.js';
import { copyText } from '../dom.js';
import { commandText, divergenceButtons, failureHint, failureLines, foundLine, historyTip, reportLines, revLabel, sessionLine, sourceText, type ReportLine } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { addPaletteSource } from '../palette-sources.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp, type PaletteCommand } from '../state.js';
import { FindCommitDialog, NormalizeUpdateDialog, UpdateGoldensDialog } from './TestsDialogs.js';

/**
 * Tests (#/tests): every golden CI replays offline and how it did at each revision. The verdict for
 * the goldens' last results, the table (where each came from, its mode, checks, history and last
 * result), each failure as the CLI prints it with what fixes it, and how to run them in CI.
 */

/** The jobs that change what this page shows: while one runs, Run tests waits. */
const TEST_KINDS = new Set<string>([JOB_KINDS.tests, JOB_KINDS.testUpdate, JOB_KINDS.normalizeAndTest]);

type Open =
  | { kind: 'update'; paths: string[] }
  | { kind: 'bisect'; name: string; golden: string; range: { good: string; bad: string | null } | null; live: boolean }
  | { kind: 'normalize-update'; name: string; golden: string; steps: string[][] };

/** The last answer this page had, for the palette's Tests group; and an Update goldens… the palette asked for. */
let latest: TestsView | null = null;
let pendingUpdate = false;

addPaletteSource(({ app, go }) => {
  const view = latest;
  if (!view || app.exported) return [];
  const out: PaletteCommand[] = view.rows.map((r) => ({ group: 'Tests', label: r.name, mono: true, hint: r.last.result === 'fail' ? 'failing' : r.last.result === 'pass' ? 'passing' : 'not run yet', run: () => go(href.tests()) }));
  if (view.diverged.length && !app.actionsOff && app.hasKind(JOB_KINDS.testUpdate))
    out.unshift({
      group: 'Actions',
      label: 'Update goldens…',
      hint: 'shadowlap test --update',
      run: () => {
        pendingUpdate = true;
        go(href.tests());
      },
    });
  return out;
});

export function TestsPage() {
  const app = useApp();
  const { client, tick, hasKind, actionsOff, guard, watchJob, jobs, toast } = app;
  const loaded = useLoad(() => client.tests(), 'tests', tick);
  const view = loaded.data;
  const [open, setOpen] = useState<Open | null>(null);
  const running = jobs.some((w) => !w.job.done && !w.lost && TEST_KINDS.has(w.job.kind ?? ''));

  useEffect(() => {
    if (!view) return;
    latest = view;
    if (pendingUpdate) {
      pendingUpdate = false;
      if (view.diverged.length) setOpen({ kind: 'update', paths: view.diverged });
    }
  }, [view]);

  const start = (kind: string, fields: Record<string, unknown>) => {
    setOpen(null);
    guard(() => watchJob(client.startJob(kind, fields)));
  };
  const off = actionsOff ?? undefined;
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

  const actions = (
    <>
      <a className="btn" href={href.settings('alerts')}>
        <Icon name="bell" />
        CI settings
      </a>
      {view.diverged.length && hasKind(JOB_KINDS.testUpdate) ? (
        <button className="btn" type="button" disabled={!!off} title={off} onClick={() => guard(() => setOpen({ kind: 'update', paths: view.diverged }))}>
          Update goldens…
        </button>
      ) : null}
      <button className="btn" type="button" onClick={() => void copyText(view.commands.ci).then((ok) => toast(ok ? 'Copied the CI command' : 'Copying was refused by the browser'))}>
        Copy CI command
      </button>
      {hasKind(JOB_KINDS.tests) ? (
        <button className="btn lime" type="button" disabled={!!off || running} title={off ?? (running ? 'The tests are running' : undefined)} onClick={() => start(JOB_KINDS.tests, {})}>
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
  const findCommit = (name: string, golden: string, range: { good: string; bad: string | null; live: boolean } | null) => {
    const live = range?.live ?? view.rows.find((r) => r.path === golden)?.mode === 'fork';
    // Free replays over a known range start at once; a search that needs a good commit, or costs tokens, asks first.
    if (range && !live) start(JOB_KINDS.bisect, { golden, good: range.good, ...(range.bad ? { bad: range.bad } : {}) });
    else setOpen({ kind: 'bisect', name, golden, range: range ? { good: range.good, bad: range.bad } : null, live });
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
        return (
          <ReportPanel key={d.golden} name={d.name} runId={d.runId} lines={reportLines(d.text)} found={d.found}>
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
                <button className={`btn${b.normalize.lead ? ' lime' : ''}`} type="button" disabled={!!off} title={off} onClick={() => guard(() => normalize(d))}>
                  {b.normalize.label}
                </button>
              ) : null}
              {b.update ? (
                <button className="btn" type="button" disabled={!!off} title={off} onClick={() => guard(() => setOpen({ kind: 'update', paths: [d.golden] }))}>
                  Update golden
                </button>
              ) : null}
              {b.bisect ? (
                <button className="btn" type="button" disabled={!!off} title={off} onClick={() => guard(() => findCommit(d.name, d.golden, d.bisect))}>
                  {b.bisect.range && !b.bisect.live ? 'Find the commit' : 'Find the commit…'}
                </button>
              ) : null}
            </div>
            <p className="hintx">Normalizers apply at match time, so older goldens keep working. Update a golden only when the change was intended.</p>
          </ReportPanel>
        );
      })}
      {view.failures.map((f) => (
        <FailurePanel key={f.golden} f={f} off={off} canBisect={hasKind(JOB_KINDS.bisect)} onBisect={() => guard(() => findCommit(f.name, f.golden, f.bisect))} />
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
      {open?.kind === 'update' ? (
        <UpdateGoldensDialog
          view={view}
          paths={open.paths}
          onClose={() => setOpen(null)}
          onUpdate={() => start(JOB_KINDS.testUpdate, open.paths.length === 1 ? { golden: open.paths[0] } : { goldens: open.paths })}
          onNormalize={
            hasKind(JOB_KINDS.normalizeAndTest)
              ? (golden) => {
                  const d = view.divergences.find((x) => x.golden === golden);
                  setOpen(null);
                  if (d) normalize(d);
                }
              : null
          }
        />
      ) : null}
      {open?.kind === 'bisect' ? (
        <FindCommitDialog name={open.name} golden={open.golden} range={open.range} live={open.live} onClose={() => setOpen(null)} onRun={(good, bad) => start(JOB_KINDS.bisect, { golden: open.golden, good, ...(bad ? { bad } : {}) })} />
      ) : null}
      {open?.kind === 'normalize-update' ? <NormalizeUpdateDialog name={open.name} steps={open.steps} onClose={() => setOpen(null)} onRun={() => start(JOB_KINDS.normalizeAndTest, { golden: open.golden })} /> : null}
    </Page>
  );
}

function Verdict({ view, running }: { view: TestsView; running: boolean }) {
  const v = view.verdict;
  if (!v) {
    return (
      <div className="verdict n">
        <Badge tone="n">not run yet</Badge>
        <div>
          <h2>{view.goldens === 1 ? 'One golden, not tested yet' : `${view.goldens} goldens, none tested yet`}</h2>
          <p>
            Run tests replays each one offline: <code>{commandText(view.commands.run)}</code>
          </p>
        </div>
      </div>
    );
  }
  const line = sessionLine(view, running)!;
  const failing = v.state === 'failing';
  return (
    <div className={`verdict ${failing ? 'no' : 'ok'}`}>
      <Badge tone={failing ? 'no' : 'ok'}>{failing ? `${v.failing} failing` : 'passing'}</Badge>
      <div>
        <h2>{v.title}</h2>
        <p>
          <code>{line.command}</code> · {line.rest}
        </p>
      </div>
    </div>
  );
}

function GoldenTr({ row, showHistory }: { row: GoldenRow; showHistory: boolean }) {
  const source = sourceText(row);
  const last = row.last;
  return (
    <tr className={row.runId ? undefined : 'still'} onClick={row.runId ? rowOpen(() => navigate(href.run(row.runId!))) : undefined}>
      <td>
        <code>{row.name}</code>
        <span className="rsub">
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
          row.checks.map((c) => <span key={c}>{c}</span>)
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
                className={`${h.result ?? 'none'}${h.updated ? ' upd' : ''}${h.runId ? ' go' : ''}`}
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
        {last.result === 'pass' ? (
          <span className="st ok">
            <i />
            {last.updated ? 'updated' : 'passed'}
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
        <span className="rsub">{last.line}</span>
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

/** A failed golden's report, as the CLI prints it, with what Find the commit found above the buttons. */
function ReportPanel({ name, runId, lines, found, children }: { name: string; runId: string | null; lines: ReportLine[]; found: FoundCommit | null; children: ReactNode }) {
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
        {found ? <BisectCard found={found} /> : null}
        {children}
      </div>
    </section>
  );
}

/** A failed check, a non-zero exit, no calls: as `test --markdown` prints it, with no normalizer to offer. */
function FailurePanel({ f, off, canBisect, onBisect }: { f: FailureView; off: string | undefined; canBisect: boolean; onBisect: () => void }) {
  const bisect = canBisect && !f.found;
  return (
    <ReportPanel name={f.name} runId={f.runId} lines={failureLines(f)} found={f.found}>
      {bisect ? (
        <div className="actions">
          <button className="btn" type="button" disabled={!!off} title={off} onClick={onBisect}>
            {f.bisect && !f.bisect.live ? 'Find the commit' : 'Find the commit…'}
          </button>
        </div>
      ) : null}
      <p className="hintx">{failureHint(f)}</p>
    </ReportPanel>
  );
}
