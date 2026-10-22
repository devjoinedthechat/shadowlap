import { useEffect, useState } from 'react';
import { CodeBlock } from '../../components/bits.js';
import { Tile } from '../../components/Icon.js';
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
 * CI (`#/settings/alerts`, as Alerts had it): two panels with one layout. Settings on the left as
 * rows ending in what the step needs; on the right, what lands and a short list; the workflow file
 * across the bottom with Copy. The panels come from `GET /api/ci/workflows` (src/ci-workflows.ts),
 * asked again as you pick, which fills in the project's goldens, its newest verified fix, its
 * repository, its default branch and its team store: Fix on failure follows Push from CI, which
 * Settings → Store sets, and with it on the step pushes each fix there too. While
 * shadowlap.config.json can't be read, the tab says so as the others do, and each step says what it
 * leaves out. Nothing is stored: the steps go into your own workflow file and run in your CI.
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
  const { view, error } = useCiWorkflows(changed);
  if (!view) {
    if (error) return <LoadProblem error={error} />;
    return (
      <>
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
      <FixOnFailure
        o={o}
        view={view}
        set={set}
        onToggle={(on) => {
          set({ fix: on });
          toast(on ? 'Fix on failure is on · add the step to your workflow' : 'Fix on failure is off');
        }}
      />
      <Alerts o={o} view={view} set={set} />
      {error ? <p className="fieldnote err">{error.message}</p> : null}
    </>
  );
}

/**
 * The panels for what was changed: the server's answer, kept while the next one is asked so nothing
 * empties as you type. Asked again when the window comes back (Push from CI may have been switched
 * in a terminal meanwhile), when Settings changed from elsewhere, and in another project.
 */
function useCiWorkflows(o: Partial<CiWorkflowOptions>): { view: CiWorkflowsView | null; error: Error | null } {
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
  return served;
}

/** A list of rows, each with its dot: the row's own tone (a failure red, one that can't be decided amber), else the list's. */
function CiList({ rows, tone = '' }: { rows: readonly CiListRow[]; tone?: '' | 'err' }) {
  return (
    <ul className="cilist">
      {rows.map((r) => (
        <li key={`${r.label}\u0000${r.value}`}>
          <i className={(r.tone ?? tone) || undefined} aria-hidden="true" />
          <span>{r.label}</span>
          {r.value ? <code>{r.value}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <select className="sel" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((x) => (
        <option key={x.value} value={x.value}>
          {x.label}
        </option>
      ))}
    </select>
  );
}

function FixOnFailure({ o, view, set, onToggle }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void; onToggle: (on: boolean) => void }) {
  const f = view.fixOnFailure;
  return (
    <section className={`panel set cip${o.fix ? '' : ' off'}`}>
      <header>
        <h2>Fix on failure</h2>
        <span className="sub">a fix pull request when a rule breaks in CI</span>
        <span className="sp" />
        <div className="seg" role="group" aria-label="Fix on failure">
          <button type="button" aria-pressed={o.fix} onClick={() => !o.fix && onToggle(true)}>
            On
          </button>
          <button type="button" aria-pressed={!o.fix} onClick={() => o.fix && onToggle(false)}>
            Off
          </button>
        </div>
      </header>
      <div className="alertgrid">
        <div className="pbody cimain">
          <p className="muted">
            <span className="ln">When an outcome check fails, CI runs blame, repair and verify.</span> <span className="ln">If verify accepts a fix, CI opens a pull request with its evidence.</span>
            {o.fix ? null : <b className="offnote">{f.offNote}</b>}
          </p>
          <div className="setrow tight">
            <div>
              <b>Budget per failing golden</b>
              <span>Repair stops once it’s spent.</span>
            </div>
            <Select label="Budget per failing golden" value={o.budget} options={f.budgets} onChange={(budget) => set({ budget })} />
          </div>
          <div className="setrow tight">
            <div>
              <b>Repairer</b>
              <span>Proposes fixes; verify decides.</span>
            </div>
            <Select label="Repairer" value={o.repairer} options={f.repairers} onChange={(repairer) => set({ repairer })} />
          </div>
          {f.teamStore ? <TeamStoreRow store={f.teamStore} /> : null}
          <span className="k cineeds">it needs</span>
          <CiList rows={f.needs} />
        </div>
        <div className="pbody teamside">
          <span className="k">{f.preview.example ? 'what lands in GitHub · example' : 'what lands in GitHub'}</span>
          <PullRequest pr={f.preview} />
          {f.teamStore?.lands.length ? (
            <>
              <span className="k">and in the team store</span>
              <CiList rows={f.teamStore.lands} />
            </>
          ) : null}
          <span className="k">it never</span>
          <CiList rows={f.never} />
        </div>
      </div>
      <div className="pbody cicode">
        <CodeBlock file={view.file} code={f.yaml} copyLabel="the workflow step" />
      </div>
    </section>
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
 * decide) does to the steps, both panels' as the action's `inconclusive` input takes it.
 */
const INCONCLUSIVE_WORDS: Record<'fail' | 'warn', string> = {
  fail: 'A gate, judge or injection test that can’t decide counts as failed: Slack hears of it, and the job fails.',
  warn: 'A gate, judge or injection test that can’t decide warns instead: Slack doesn’t hear of it, and the job goes on. Fix on failure’s step lets it through too.',
};

function Alerts({ o, view, set }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void }) {
  const a = view.alerts;
  const toggle = () => set({ onlyMain: !o.onlyMain });
  return (
    <section className="panel set cip" id="alerts">
      <header>
        <h2>Alerts</h2>
        <span className="sub">a message in Slack when a golden fails in CI</span>
      </header>
      <div className="alertgrid">
        <div className="pbody cimain">
          <p className="muted">
            <span className="ln">The test step counts the goldens that failed.</span> <span className="ln">These steps post the count to Slack, then fail the job.</span>
          </p>
          <div className="setrow tight">
            <div>
              <b>Only for the {a.branch} branch</b>
              <span>Pull requests stay quiet; their checks already show it.</span>
            </div>
            <span
              className="switch"
              role="switch"
              tabIndex={0}
              aria-checked={o.onlyMain}
              aria-label={`Only for the ${a.branch} branch`}
              onClick={toggle}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  toggle();
                }
              }}
            >
              <i />
            </span>
          </div>
          <div className="setrow tight">
            <div>
              <b>Webhook secret</b>
              <span>The repository secret that holds the Slack webhook URL.</span>
            </div>
            <input className="inp" type="text" spellCheck={false} autoComplete="off" aria-label="Webhook secret" value={o.secret} onChange={(e) => set({ secret: typedSecret(e.target.value) })} />
          </div>
          <div className="setrow tight">
            <div>
              <b>Inconclusive goldens</b>
              <span>{INCONCLUSIVE_WORDS[o.inconclusive ?? 'fail']}</span>
            </div>
            <div className="seg" role="group" aria-label="Inconclusive goldens">
              {(['fail', 'warn'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={(o.inconclusive ?? 'fail') === k} onClick={() => set({ inconclusive: k })}>
                  {k === 'fail' ? 'Fail' : 'Warn'}
                </button>
              ))}
            </div>
          </div>
          <span className="k cineeds">it needs</span>
          <CiList rows={a.needs} />
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
          <span className="k">a golden fails when</span>
          <CiList rows={a.failures} tone="err" />
        </div>
      </div>
      <div className="pbody cicode">
        <CodeBlock file={view.file} code={a.yaml} copyLabel={`the workflow steps (secret ${a.secret})`} />
      </div>
    </section>
  );
}
