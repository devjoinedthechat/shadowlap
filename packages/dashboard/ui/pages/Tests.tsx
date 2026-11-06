import { useEffect, useState, type ReactNode } from 'react';
import { JOB_KINDS, type BisectMiss, type BisectRevision, type DivergenceView, type FailureView, type FoundCommit, type GoldenRow, type InconclusiveView, type TestsView } from '../api.js';
import { Badge, CmdLine, CommandLine, CopyButton, EmptyState, PageHeader } from '../components/bits.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { DotLine, IntervalBar, RuleText } from '../components/Verdict.js';
import { rowOpen } from '../components/Table.js';
import { treeBusy } from '../fixes/model.js';
import { useServerJobs } from '../fixes/tree.js';
import { glued } from '../format.js';
import { asksUpdate, checkMark, commandText, divergenceButtons, failureHint, failureLines, findCommitButton, foundLine, historyTip, inconclusiveHint, inconclusiveLines, missedLine, reportLines, revLabel, sessionLine, sessionWait, sourceText, testsBusy, type ReportLine } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { addPaletteSource, paletteSourcesChanged } from '../palette-sources.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { divergedAsk, moreAttemptsAsk, runTestsAsk, startTestsJob, type TestsAsk } from '../tests-ask.js';
import { goldenPrice, runPrice, updatesPrice, useTestsEstimates, type Price } from '../tests-estimates.js';
import type { TestsEstimates } from '../estimates-api.js';
import { JobButton } from '../components/JobButton.js';
import { sentEstimate } from '../spending.js';
import { moreCard, normalizeCard, runTestsCard, testsJob, updateCard, updatesCard } from './tests-cards.js';
import { keepTests, onTestsChanged, testsPaletteCommands } from '../tests-palette.js';
import { FindCommitDialog, NormalizeUpdateDialog, UpdateGoldensDialog } from './TestsDialogs.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';

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
  | { kind: 'bisect'; name: string; golden: string; range: { good: string; bad: string | null } | null; live: boolean; revisions: BisectRevision[]; tried: string | null }
  | { kind: 'normalize-update'; name: string; golden: string; steps: string[][]; estimate?: Price };

// The palette's Tests group on every page (tests-palette.ts): an open palette reads it again once the goldens land.
addPaletteSource(({ app, go }) => testsPaletteCommands(app, go, { update: app.hasKind(JOB_KINDS.testUpdate) }));
onTestsChanged(paletteSourcesChanged);

export function TestsPage() {
  const app = useApp();
  const { client, tick, feeds, hasKind, actionsOff, guard, jobs, toast, meta } = app;
  // Read again when runs or calls move, and when a session of error-path presets starts or ends:
  // that moves only their own count, and the actions wait for one on goldens (`chaosRunning`).
  const loaded = useLoad(() => client.tests(), 'tests', `${tick}:${feeds.chaos ?? 0}`);
  const view = loaded.data;
  const prices = useTestsEstimates(view ?? null);
  const [open, setOpen] = useState<Open | null>(null);
  const running = jobs.some((w) => !w.job.done && !w.lost && TEST_KINDS.has(w.job.kind ?? ''));
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
  const header = (actions?: ReactNode) => <PageHeader eyebrow="goldens · shadowlap test" title="Tests" text="Every golden CI runs, and how it did at each revision." actions={actions} />;

  if (!view) {
    return (
      <Page busy={!loaded.error}>
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

  const [runWait, updateWait, updateGoldenWait, findWait] = ['run the tests', 'update them', 'update it', 'find the breaking commit'].map((verb) => wait(verb));
  // A gate against history needs the store kept between CI's runs.
  const historyGate = view.rows.some((r) => r.gate?.gate.kind === 'baseline');
  // An injection test runs live from each payload it plants, as a fork does: CI needs the keys for it.
  const injection = view.rows.some((r) => r.injection);
  const actions = (
    <>
      <a className="btn" href={href.settings('alerts')}>
        <Icon name="bell" />
        CI settings
      </a>
      {view.diverged.length && hasKind(JOB_KINDS.testUpdate) ? (
        <JobButton className="btn" why={updateWait} {...testsJob(updatesCard(view.diverged), updatesPrice(prices, view.diverged), (e) => guard(() => setOpen({ kind: 'update', paths: view.diverged, estimate: e })))}>
          {ACTIONS.updateGoldens.label}
        </JobButton>
      ) : null}
      {hasKind(JOB_KINDS.tests) ? (
        <JobButton className="btn lime" why={runWait} {...testsJob(runTestsCard(view), runPrice(prices), (e) => start(JOB_KINDS.tests, {}, runTestsAsk(view), e))}>
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
      {/* The table fits its panel at every width, as the mock's .gtw container queries fit it: below
          1000px of room the oldest revisions give way, below 820px the checks go under the golden's
          name, and on a phone the revisions become a strip there too. Last result keeps its width. */}
      <section className="panel gtw">
        <div className="tscroll">
          <table className="t gt">
            <thead>
              <tr>
                <th className="gg">Golden</th>
                <th className="gck">Checks</th>
                {view.revisions.length ? (
                  <th className="hist">
                    <span className="hn">By revision</span>
                    {view.revisions.map((r, i) => (
                      <span key={`${String(r)}:${i}`} className={revClass(i, view.revisions.length)} data-tip={tipText(r ? `revision ${r}` : 'no revision: not in a git repository')}>
                        {revLabel(r)}
                      </span>
                    ))}
                  </th>
                ) : null}
                <th className="glast">Last result</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <GoldenTr key={row.path} row={row} showHistory={view.revisions.length > 0} />
              ))}
            </tbody>
          </table>
        </div>
        <GateRules rows={view.rows} />
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
                <JobButton className={`btn${b.normalize.lead ? ' lime' : ''}`} why={normalizeWait} {...testsJob(normalizeCard(d, b.normalize), goldenPrice(prices, d.golden, b.normalize.run === 'rerun' ? 'rerun' : 'normalize'), (e) => guard(() => normalize(d, e)))}>
                  {b.normalize.label}
                </JobButton>
              ) : null}
              {b.update ? (
                <JobButton className="btn" why={goldenWait} {...testsJob(updateCard(d.golden), goldenPrice(prices, d.golden, 'update'), (e) => guard(() => setOpen({ kind: 'update', paths: [d.golden], estimate: e })))}>
                  {ACTIONS.updateGolden.label}
                </JobButton>
              ) : null}
              {b.bisect ? (
                <ActionButton className="btn" why={findWait} onClick={() => guard(() => findCommit(d))}>
                  {b.bisect.range && !b.bisect.live ? confirmWords(ACTIONS.findBreakingCommit.label) : ACTIONS.findBreakingCommit.label}
                </ActionButton>
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
      <div className="grid2 gpanel">
        <section className="panel">
          <header>
            <h2>In CI</h2>
            <span className="sp" />
            <CopyButton text={view.commands.ci} label="the CI command" />
          </header>
          <div className="pbody">
            <p className="muted">
              Replay goldens run offline and need no key. {injection ? 'A golden marked fork runs live from where it forks, and an injection test from each payload it plants: both need the providers’ keys.' : 'A golden marked fork runs live from where it forks, and needs the providers’ keys.'} A divergence, a non-zero exit, no calls, or a check or gate that fails or can’t decide fails a golden.
            </p>
            <CommandLine command={view.commands.ci} />
            {historyGate ? (
              <p className="muted after">
                A gate against history needs the store kept between runs: the Action’s <code>keep-history</code> does it, or cache <code>.shadowlap/shadowlap.db</code>.
              </p>
            ) : null}
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
              A golden whose checks say what the agent must do is also a task a model can be scored on.{' '}
              <a className="more" href={href.training('tasks')}>
                Training tasks
              </a>
            </p>
          </div>
        </section>
      </div>
      <p className="hintx tfoot">{view.note}</p>
      {/* What it offers instead opens no dialog of its own, though a session that runs a golden live still asks first (tests-ask.ts). */}
      {open?.kind === 'update' ? (
        <UpdateGoldensDialog
          view={view}
          paths={open.paths}
          has={hasKind}
          estimate={open.estimate}
          onClose={() => setOpen(null)}
          onUpdate={() => start(JOB_KINDS.testUpdate, open.paths.length === 1 ? { golden: open.paths[0] } : { goldens: open.paths }, undefined, open.estimate)}
          onInstead={(i) => start(i.run === 'rerun' ? JOB_KINDS.tests : JOB_KINDS.normalizeAndTest, { golden: i.golden }, divergedAsk(view, i.golden, i.run))}
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
          onRun={(fields) => start(JOB_KINDS.bisect, { golden: open.golden, ...fields })}
        />
      ) : null}
      {open?.kind === 'normalize-update' ? <NormalizeUpdateDialog name={open.name} steps={open.steps} estimate={open.estimate} onClose={() => setOpen(null)} onRun={() => start(JOB_KINDS.normalizeAndTest, { golden: open.golden }, divergedAsk(view, open.golden, 'normalize-update'), open.estimate)} /> : null}
    </Page>
  );
}

function Verdict({ view, running }: { view: TestsView; running: boolean }) {
  const v = view.verdict;
  if (!v) {
    const command = commandText(view.commands.run);
    // No golden replayed yet, though its error-path presets may have run: then it has been tested, and says so.
    const presets = view.rows.filter((r) => r.presets).length;
    const one = view.goldens === 1;
    return (
      <div className="verdict tv n">
        <Badge tone="n">{presets ? 'not replayed yet' : 'not run yet'}</Badge>
        <div>
          <h2>{presets ? (one ? 'One golden, not replayed yet' : `${view.goldens} goldens, none replayed yet`) : one ? 'One golden, not tested yet' : `${view.goldens} goldens, none tested yet`}</h2>
          <p>
            {presets ? `Error-path presets ran on ${presets === view.goldens ? (one ? 'it' : 'every one') : `${presets} of them`}. ` : null}
            {view.rows.some((r) => r.mode === 'fork') ? 'Run tests replays each one, those marked fork live from where they fork' : 'Run tests replays each one offline'}: <SessionCommand text={command} />
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

/** A history column's class: `r0` the newest revision, `r1` the one before, and so on, by which the oldest give way on a narrow panel. */
const revClass = (i: number, n: number) => `r${n - 1 - i}`;

/** A history cell's class: how the golden came out at that revision, inconclusive told apart. */
const cellClass = (h: GoldenRow['history'][number]) => (h.verdict === 'inconclusive' ? 'inc' : (h.result ?? 'none'));

function GoldenTr({ row, showHistory }: { row: GoldenRow; showHistory: boolean }) {
  const source = sourceText(row);
  const last = row.last;
  const n = row.history.length;
  return (
    <tr className={row.runId ? undefined : 'still'} {...(row.runId ? rowOpen(() => navigate(href.run(row.runId!))) : {})}>
      <td className="gg">
        <code className="gn">{row.runId ? <a className="rowa" href={href.run(row.runId)}>{row.name}</a> : row.name}</code>
        <span className="gmeta">
          <span className="chip" data-tip={tipText(row.modeHint)}>
            {row.modeLabel}
          </span>
          {showHistory ? (
            <span className="gstrip" aria-hidden="true">
              {row.history.map((h, i) => (
                <i key={`${String(h.revision)}:${i}`} className={cellClass(h)} />
              ))}
            </span>
          ) : null}
          <span className="gsrc">
            {'runId' in source ? (
              <>
                from{' '}
                <a className="dlink" href={href.run(source.runId)}>
                  <code>{source.runId.slice(0, 10)}</code>
                </a>
              </>
            ) : (
              source.text
            )}
          </span>
        </span>
        <span className="chk gin">
          <Checks row={row} />
        </span>
      </td>
      <td className="chk gck">
        <Checks row={row} />
      </td>
      {showHistory ? (
        <td className="hist">
          {row.history.map((h, i) => {
            const t = historyTip(h, row.name);
            return (
              <i
                key={`${String(h.revision)}:${i}`}
                className={`${cellClass(h)} ${revClass(i, n)}${h.updated ? ' upd' : ''}${h.runId ? ' go' : ''}`}
                data-tip={tipCard(t.title, [{ label: t.label, value: t.value, color: t.color }])}
                data-acts={h.runId ? '' : undefined}
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
      <td className="glast">
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
        ) : row.presets ? (
          // Tested by its error-path presets, its replay not yet: never "not run yet".
          <span className={`st ${presetTone(row.presets)}`}>
            <i />
            presets {row.presets.verdict}
          </span>
        ) : (
          <span className="st n">not run yet</span>
        )}
        {last.result !== null || row.error ? <span className="rsub">{gated(last.gate) ? <DotLine text={last.line} max={18} soft={24} /> : last.line}</span> : null}
        {gated(last.gate) && last.gate.attempts ? <GateEvidence g={last.gate} verdict={last.verdict} /> : null}
        {row.presets ? <PresetsLine p={row.presets} only={last.result === null && !row.error} /> : null}
      </td>
    </tr>
  );
}

/**
 * A golden's checks, each marked by how its last result came out on it (✓ passed, ✗ failed, ? in
 * amber when it couldn't be decided, – when it didn't apply; no mark before a result), with what
 * failed, in how many attempts, or why, under it and on hover.
 */
function Checks({ row }: { row: GoldenRow }) {
  if (!row.checks.length) {
    return (
      <em className="nil" data-tip={tipText('No checks in shadowlap.config.json: it passes when it replays and the agent exits 0')}>
        exit status only
      </em>
    );
  }
  const ran = row.last.result !== null;
  return (
    <>
      {row.checkResults.map((c, i) => {
        const m = checkMark(c, ran);
        return (
          <span key={`${c.label}:${i}`} className={`ck${m.status ? ` ${m.status}` : ''}`} data-tip={tipCard(m.tip.title, [{ label: m.tip.label, value: m.tip.value, color: m.tip.color }])}>
            {m.mark ? (
              <b className="cm" role="img" aria-label={m.word}>
                {m.mark}
              </b>
            ) : null}
            <span className="cw">
              {m.text}
              {m.sub ? <small>{glued(m.sub)}</small> : null}
            </span>
          </span>
        );
      })}
    </>
  );
}

type Presets = NonNullable<GoldenRow['presets']>;

/** A golden's presets in the consequence colours: failed red, inconclusive amber, passed quiet. */
const presetTone = (p: Presets) => (p.verdict === 'failed' ? 'err' : p.verdict === 'inconclusive' ? 'warn' : 'ok');

/**
 * How a golden's error-path presets came out, under its last result, opening the attempt that failed
 * (or couldn't say): the whole line when they are all that ran, else in short with the line on hover.
 */
function PresetsLine({ p, only }: { p: Presets; only: boolean }) {
  const count = p.verdict === 'failed' ? p.failed : p.verdict === 'inconclusive' ? p.inconclusive : p.passed;
  const text = only ? `${p.line} · replay not tested yet` : `presets · ${count} of ${p.ran} ${p.verdict}`;
  return p.runId ? (
    <a className={`rsub gpre ${presetTone(p)}`} href={href.run(p.runId)} data-tip={only ? undefined : tipText(p.line)} onClick={(e) => e.stopPropagation()}>
      {text}
    </a>
  ) : (
    <span className={`rsub gpre ${presetTone(p)}`} data-tip={only ? undefined : tipText(p.line)}>
      {text}
    </span>
  );
}

type GateShown = NonNullable<GoldenRow['last']['gate']>;

/** A gate decided it from its attempts (not a clean replay's one, which is the same every time): its line is a tally and a bound. */
const gated = (g: GoldenRow['last']['gate']): g is GateShown => !!g && !g.clean;

/** Two places, as a rate reads beside a bar: `.70`. */
const rate2 = (x: number) => x.toFixed(2).replace(/^0(?=\.)/, '');

/**
 * Under a gated golden's line, what its attempts show (decision 9): the pass rate's interval, exact
 * under the gate's stopping, against the gate's two rates, or against the baseline and the drop that
 * fails it, in the verdict's colour; pass^k and the tally's sentence on hover. Its confidence reads
 * rounded down, as the verdict line's does, so it never says more than the gate worked out.
 */
function GateEvidence({ g, verdict }: { g: GateShown; verdict: GoldenRow['last']['verdict'] }) {
  const baseline = g.kind === 'baseline' && g.evidence.kind === 'baseline' ? { at: g.evidence.baseline, drop: g.drop } : null;
  const marks = g.kind === 'sprt' ? [g.bad, g.good] : baseline ? [baseline.at - baseline.drop, baseline.at] : [];
  const against = g.kind === 'sprt' ? `against ${rate2(g.bad)} and ${rate2(g.good)}` : 'against its baseline';
  const why = `The pass rate's ${+(Math.floor(+(g.interval.confidence * 1000).toPrecision(12)) / 10)}% interval, ${against}${baseline ? ` (${rate2(baseline.at)}, less a drop of ${Math.round(baseline.drop * 100)} points)` : ''}`;
  return (
    <span className="gev" data-tip={JSON.stringify({ t: g.tally, s: why })}>
      <IntervalBar lo={g.interval.lo} hi={g.interval.hi} marks={marks} tone={verdict === 'passed' ? 'ok' : verdict === 'inconclusive' ? 'y' : 'no'} />
      <small>{against}</small>
    </span>
  );
}

/**
 * Each gate's rule, stated once under the table for every golden it decided (decision 9), beside the
 * mode its goldens show: no row repeats it. Where two rules share a mode (two goldens' gates with
 * different limits), each names the goldens it decided, so "up to 12 attempts" says whose it is.
 */
function GateRules({ rows }: { rows: readonly GoldenRow[] }) {
  const rules = new Map<string, { mode: string; names: string[] }>();
  for (const r of rows) {
    const rule = r.last.gate?.rule;
    if (!rule) continue;
    const kept = rules.get(rule);
    if (kept) kept.names.push(r.name);
    else rules.set(rule, { mode: r.modeLabel, names: [r.name] });
  }
  if (!rules.size) return null;
  const modes = [...rules.values()].map((x) => x.mode);
  const shared = (mode: string) => modes.filter((m) => m === mode).length > 1;
  return (
    <div className="gfoot">
      {[...rules].map(([rule, { mode, names }]) => (
        <p key={rule}>
          <span className="chip">{mode}</span>
          <span>
            {shared(mode) ? <b className="gnames">{`${names.join(', ')}: `}</b> : null}
            <RuleText rule={rule} />
          </span>
        </p>
      ))}
    </div>
  );
}

function ReportLines({ lines }: { lines: ReportLine[] }) {
  return (
    <pre tabIndex={0} className="report">
      {lines.map((l, i) => (
        <span key={i} className={l.tone || undefined}>
          {l.text}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}

/** What Find breaking commit found: the first bad commit, its message, who made it, when, and what it cost. */
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

/** Find breaking commit named no first bad commit between the commits it was given: where it looked, and why. */
function BisectMissLine({ missed }: { missed: BisectMiss }) {
  return (
    <div className="bisect miss">
      <span className="k">{confirmWords(ACTIONS.findBreakingCommit.label).toLowerCase()}</span>
      <span className="m">{missedLine(missed)}</span>
    </div>
  );
}

/** A failed golden's report, as the CLI prints it, with what Find breaking commit found (or that it found none) above the buttons. */
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
 * couldn't be decided. Its report, and what settles it: for a gate, Run more attempts, which continues
 * it to twice its limit with the attempts it has; for a judge check a replay golden couldn't ask
 * offline, Update golden, which asks it once and keeps its verdict (it asks first); for one a golden
 * that forks had no key for, the key, in the hint. More attempts of a golden that forks run live, so
 * they ask first: `ask` is what that question says besides the server's words, the command among it.
 */
function InconclusivePanel({ v, off, canRun, onMore, prices, updateOff, canUpdate, onUpdate }: { v: InconclusiveView; off: string | undefined; canRun: boolean; onMore: (job: { golden: string; maxAttempts: number; continue: true }, ask: TestsAsk, e: Price) => void; prices: TestsEstimates | null | undefined; updateOff: string | undefined; canUpdate: boolean; onUpdate: (e: Price) => void }) {
  const more = v.gate?.more ?? null;
  const update = v.judge?.update ?? null;
  return (
    <ReportPanel name={v.name} runId={v.runId} lines={inconclusiveLines(v)} found={null} missed={null}>
      {more && canRun ? (
        <div className="actions">
          <JobButton className="btn lime" why={off} {...testsJob(moreCard(more), goldenPrice(prices, v.golden, 'more'), (e) => onMore(more.job, moreAttemptsAsk(v.name, more), e))}>
            Run more attempts
          </JobButton>
        </div>
      ) : update && canUpdate ? (
        <div className="actions">
          <JobButton className="btn" why={updateOff} {...testsJob(updateCard(v.golden, update), goldenPrice(prices, v.golden, 'update'), onUpdate)}>
            Update golden
          </JobButton>
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
          <ActionButton className="btn" why={off} onClick={onBisect}>
            {button.range && !button.live ? confirmWords(ACTIONS.findBreakingCommit.label) : ACTIONS.findBreakingCommit.label}
          </ActionButton>
        </div>
      ) : null}
      <p className="hintx">{failureHint(f)}</p>
    </ReportPanel>
  );
}
