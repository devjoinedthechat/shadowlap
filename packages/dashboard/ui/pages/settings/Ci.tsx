import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { CodeBlock } from '../../components/bits.js';
import { Tile } from '../../components/Icon.js';
import { Section } from '../../components/Section.js';
import { Switch } from '../../components/Switch.js';
import { shortFixId } from '../../fixes/model.js';
import { clock } from '../../format.js';
import { useLatest } from '../../hooks.js';
import { href } from '../../route.js';
import type { CiListRow, CiWorkflowOptions, CiWorkflowsView, PullRequestPreview } from '../../types.js';
import { useApp } from '../../state.js';
import { TeamStoreRow } from './CiTeamStore.js';
import { ConfigProblem, LoadProblem, Loading } from './common.js';
import { onSettingsChanged } from './events.js';
import { ciShown, typedSecret } from './logic.js';

/**
 * CI (`#/settings/ci`; `#/settings/alerts`, as Alerts had it, opens it too): your workflow first, one job in which the action runs
 * the goldens once and the parts you turn on follow it, built from its switches (fix pull requests,
 * Slack, the team store, which follows Push from CI, and what an inconclusive golden does), with
 * what it needs, what fails a golden, and the workflow file across the bottom with Copy. Then a
 * panel for each part, in the same layout: its settings on the left, what lands on the right,
 * dimmed while it is off. The panels come from `GET /api/ci/workflows` (src/ci-workflows.ts), asked
 * again as you pick, which fills in the project's goldens, its newest verified fix, its repository,
 * its default branch and its team store. While shadowlap.config.json can't be read, the tab says so
 * as the others do, and the workflow says what it leaves out. Nothing is stored: the steps go into
 * your own workflow file and run in your CI.
 */

/** What the panels were changed to, kept while the dashboard is open; what isn't changed is the server's default. */
const kept: Partial<CiWorkflowOptions> = {};

export function CiTab() {
  const { toast } = useApp();
  const [changed, setChanged] = useState<Partial<CiWorkflowOptions>>(() => ({ ...kept }));
  const set = (patch: Partial<CiWorkflowOptions>) => {
    Object.assign(kept, patch);
    setChanged({ ...kept });
  };
  const { view, error, reload } = useCiWorkflows(changed);
  if (!view) {
    if (error) return <LoadProblem error={error} retry={reload} />;
    return (
      <>
        <Loading title="Your workflow" />
        <Loading title="Fix on failure" />
        <Loading title="Alerts" />
      </>
    );
  }
  // What the controls show: what was changed here, else what the server answered with.
  const o = ciShown(changed, view);
  return (
    <>
      {/* The steps read the goldens' tests and the store from it: each says what it leaves out until it is fixed. */}
      {view.configError ? <ConfigProblem error={view.configError} /> : null}
      <Workflow
        o={o}
        view={view}
        set={set}
        onFix={(on) => {
          set({ fix: on });
          toast(on ? 'Fix pull requests are on · your workflow has the step' : 'Fix pull requests are off');
        }}
        onAlerts={(on) => {
          set({ alerts: on });
          toast(on ? 'Slack alerts are on · your workflow has the steps' : 'Slack alerts are off');
        }}
      />
      <FixOnFailure o={o} view={view} set={set} />
      <Alerts o={o} view={view} set={set} />
      {error ? <p className="fieldnote err">{error.message}</p> : null}
    </>
  );
}

/**
 * The panels for what was changed: the server's answer, kept while the next one is asked so nothing
 * empties as you type. Asked again when the window comes back (Push from CI may have been switched
 * in a terminal meanwhile), when Settings changed from elsewhere, in another project, and on Retry
 * (`reload`).
 */
function useCiWorkflows(o: Partial<CiWorkflowOptions>): { view: CiWorkflowsView | null; error: Error | null; reload: () => void } {
  const { client, meta } = useApp();
  const options = useLatest(o);
  const [seen, setSeen] = useState(0);
  const key = `${JSON.stringify(o)}:${meta?.project?.id ?? ''}:${seen}`;
  const [served, setServed] = useState<{ view: CiWorkflowsView | null; error: Error | null }>({ view: null, error: null });
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && setSeen((n) => n + 1);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    const off = onSettingsChanged(() => setSeen((n) => n + 1));
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
      off();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    client.ciWorkflows(options.current).then(
      (view) => alive && setServed({ view, error: null }),
      (err: unknown) => alive && setServed((s) => ({ view: s.view, error: err instanceof Error ? err : new Error(String(err)) })),
    );
    return () => {
      alive = false;
    };
  }, [client, key, options]);
  return { ...served, reload: () => setSeen((n) => n + 1) };
}

/**
 * A list of rows, each with its dot: the row's own tone (a failure red, one that can't be decided
 * amber), else the list's. A value that lists several (the providers' keys) breaks only after a
 * comma, each one whole.
 */
function CiList({ rows, tone = '' }: { rows: readonly CiListRow[]; tone?: '' | 'err' }) {
  return (
    <ul className="cilist">
      {rows.map((r) => (
        <li key={`${r.label}\u0000${r.value}`}>
          {/* A row's own tone first: an inconclusive golden is amber, never a failure's red. */}
          <i className={r.tone ?? (tone || undefined)} aria-hidden="true" />
          <span>{r.label}</span>
          {r.value ? (
            <code>
              {r.value.split(', ').map((v, i) => (
                <Fragment key={i}>
                  {i ? ', ' : null}
                  <span className="nw">{v}</span>
                </Fragment>
              ))}
            </code>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A row's select, named by the row's label and described by its line (`<id>-name`, `<id>-help`). */
function Select({ id, value, options, onChange }: { id: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <select className="sel" aria-labelledby={`${id}-name`} aria-describedby={`${id}-help`} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((x) => (
        <option key={x.value} value={x.value}>
          {x.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Your workflow: the switches it is built from, what it needs for what is on, what fails a golden in
 * it, and the one job's steps: one checkout, one Node, the action once (`id: goldens`), then a fix
 * pull request and Slack where they are on.
 */
function Workflow({ o, view, set, onFix, onAlerts }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void; onFix: (on: boolean) => void; onAlerts: (on: boolean) => void }) {
  const { toast } = useApp();
  const w = view.workflow;
  return (
    <Section className="set cip" id="workflow" title="Your workflow" sub="one job: the action runs your goldens once, then what you turn on">
      <div className="alertgrid">
        <div className="pbody cimain">
          <div className="setrow tight">
            <div>
              <b id="fix-name">Fix pull requests</b>
              <span id="fix-help">When an outcome check fails, CI runs blame, repair and verify, and opens a pull request with the fix verify accepted.</span>
            </div>
            <Switch on={o.fix} labelledBy="fix-name" describedBy="fix-help" onChange={onFix} />
          </div>
          <div className="setrow tight">
            <div>
              <b id="alerts-name">Tell Slack</b>
              <span id="alerts-help">The action counts the goldens that failed; Slack hears of them, then the job fails.</span>
            </div>
            <Switch on={o.alerts} labelledBy="alerts-name" describedBy="alerts-help" onChange={onAlerts} />
          </div>
          {view.fixOnFailure.teamStore ? <TeamStoreRow store={view.fixOnFailure.teamStore} /> : null}
          <div className="setrow tight">
            <div>
              <b id="inconclusive-name">An inconclusive golden</b>
              <span id="inconclusive-help">{INCONCLUSIVE_WORDS[o.inconclusive ?? 'fail']}</span>
            </div>
            <div className="seg" role="group" aria-labelledby="inconclusive-name" aria-describedby="inconclusive-help">
              {(['fail', 'warn'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={(o.inconclusive ?? 'fail') === k}
                  onClick={() => {
                    if ((o.inconclusive ?? 'fail') === k) return;
                    set({ inconclusive: k });
                    toast(INCONCLUSIVE_TOAST[k]);
                  }}
                >
                  {k === 'fail' ? 'Fails' : 'Warns'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="pbody teamside">
          <span className="k">a golden fails when</span>
          <CiList rows={view.alerts.failures} tone="err" />
          {view.fixOnFailure.teamStore?.lands.length ? (
            <>
              <span className="k">and in the team store</span>
              <CiList rows={view.fixOnFailure.teamStore.lands} />
            </>
          ) : null}
        </div>
      </div>
      <div className="pbody cicode">
        <CodeBlock file={view.file} code={w.text} copyLabel="the workflow" />
      </div>
    </Section>
  );
}

function FixOnFailure({ o, view, set }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void }) {
  const f = view.fixOnFailure;
  return (
    <Section className={`set cip${o.fix ? '' : ' off'}`} id="fix-on-failure" title="Fix on failure" sub="a fix pull request when a rule breaks in CI">
      <div className="alertgrid">
        <div className="pbody cimain">
          <p className="muted">
            <span className="ln">When an outcome check fails, CI runs blame, repair and verify.</span> <span className="ln">If verify accepts a fix, CI opens a pull request with its evidence.</span>
            {o.fix ? null : <b className="offnote">{f.offNote}</b>}
          </p>
          <div className="setrow tight">
            <div>
              <b id="cifixBudget-name">Budget per failing golden</b>
              <span id="cifixBudget-help">Repair stops once it’s spent.</span>
            </div>
            <Select id="cifixBudget" value={o.budget} options={f.budgets} onChange={(budget) => set({ budget })} />
          </div>
          <div className="setrow tight">
            <div>
              <b id="cifixRepairer-name">Repairer</b>
              <span id="cifixRepairer-help">Proposes fixes; verify decides.</span>
            </div>
            <Select id="cifixRepairer" value={o.repairer} options={f.repairers} onChange={(repairer) => set({ repairer })} />
          </div>
        </div>
        <div className="pbody teamside">
          <span className="k">{f.preview.example ? 'what lands in GitHub · example' : 'what lands in GitHub'}</span>
          <PullRequest pr={f.preview} />
          <span className="k">it never</span>
          <CiList rows={f.never} />
        </div>
      </div>
    </Section>
  );
}

/** The pull request Fix on failure opens, as GitHub shows it: the newest fix verified here, or the docs' example. */
function PullRequest({ pr }: { pr: PullRequestPreview }) {
  // The file the fix changes leads its line, then its lines and what it cost: `prompts/refund.md +1 −0 · ≈$0.84 of $2.00`.
  const change = pr.change ? /^(\S+)(.*)$/.exec(pr.change) : null;
  return (
    <div className="alertcard prcard">
      <div className="ah">
        <svg className="prico" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4" cy="3.5" r="1.7" />
          <circle cx="4" cy="12.5" r="1.7" />
          <circle cx="12" cy="12.5" r="1.7" />
          <path d="M4 5.2v5.6M12 10.8V6.5a2 2 0 0 0-2-2H7.4M9 3 7.4 4.5 9 6" />
        </svg>
        <b title={pr.title}>{pr.title}</b>
        {pr.fixId ? (
          <span>
            <a href={href.fixes(pr.fixId)} title={`The fix this pull request would carry: ${pr.fixId}`}>
              {shortFixId(pr.fixId)}
            </a>
          </span>
        ) : pr.example ? (
          <span>#142</span>
        ) : null}
      </div>
      <p className="msgtext">
        {pr.author} wants to merge 1 commit into <code>{pr.base}</code>{' '}
        <span className="nw">
          from <code>{pr.branch}</code>
        </span>
      </p>
      <ul className="prl">
        {pr.verify ? (
          <li>
            <i className="ok" />
            verify: {pr.verify}
          </li>
        ) : null}
        {pr.blame ? (
          <li>
            <i />
            blame: {pr.blame}
          </li>
        ) : null}
        <li>
          <i />
          {change ? (
            <>
              <code>{change[1]}</code>
              {`${(change[2] ?? '').trim()} · ${pr.spent}`}
            </>
          ) : (
            pr.spent
          )}
        </li>
      </ul>
    </div>
  );
}

/**
 * What each choice for an inconclusive golden (a gate, a judge or an injection test that can't
 * decide) does, in the design's words for its "in CI" row (the Gates panel's), as the action's
 * `inconclusive` input takes it. Fails writes no input, so the step does as `shadowlap test` does by
 * default: a gate against a history shorter than 30 sessions only warns, until the plan reads a
 * decline or a drop in it.
 */
const INCONCLUSIVE_WORDS: Record<'fail' | 'warn', ReactNode> = {
  fail: <>Fails the step, as a failed one does, but a gate against a history of fewer than 30 sessions only warns while the plan reads no decline or drop in them. Run more attempts can settle it.</>,
  warn: (
    <>
      Lets the step pass with a warning: <code>inconclusive: warn</code>. Every report still says inconclusive.
    </>
  ),
};

/** What the toast says when the choice changes. */
const INCONCLUSIVE_TOAST: Record<'fail' | 'warn', string> = {
  fail: 'An inconclusive golden fails the step, the default · a gate against fewer than 30 sessions only warns',
  warn: 'An inconclusive golden warns · the step says inconclusive: warn',
};

function Alerts({ o, view, set }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void }) {
  const a = view.alerts;
  return (
    <Section className={`set cip${o.alerts ? '' : ' off'}`} id="alerts" title="Alerts" sub="a message in Slack when a golden fails in CI">
      <div className="alertgrid">
        <div className="pbody cimain">
          <p className="muted">
            <span className="ln">The test step counts the goldens that failed.</span> <span className="ln">These steps post the count to Slack, then fail the job.</span>
            {o.alerts ? null : <b className="offnote">{a.offNote}</b>}
          </p>
          <div className="setrow tight">
            <div>
              <b id="onlyMain-name">Only for the {a.branch} branch</b>
              <span id="onlyMain-help">Pull requests stay quiet; their checks already show it.</span>
            </div>
            <Switch on={o.onlyMain} labelledBy="onlyMain-name" describedBy="onlyMain-help" onChange={(onlyMain) => set({ onlyMain })} />
          </div>
          <div className="setrow tight">
            <div>
              <b>Webhook secret</b>
              <span>The repository secret that holds the Slack webhook URL.</span>
            </div>
            <input className="inp" type="text" spellCheck={false} autoComplete="off" aria-label="Webhook secret" value={o.secret} onChange={(e) => set({ secret: typedSecret(e.target.value) })} />
          </div>
        </div>
        <div className="pbody teamside">
          <span className="k">what lands in Slack</span>
          <div className="slackmsg">
            <Tile />
            <div className="sm">
              <div className="sh">
                <b>{a.message.app}</b>
                <span className="sapp">APP</span>
                <span className="t">{clock(a.message.at ?? Date.now())}</span>
              </div>
              <p>{a.message.text}</p>
              <span className="sl">{a.message.link}</span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
