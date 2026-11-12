import { useEffect, useState } from 'react';
import { Tile } from '../../components/Icon.js';
import { Section } from '../../components/Section.js';
import { Switch } from '../../components/Switch.js';
import { shortFixId } from '../../fixes/model.js';
import { clock } from '../../format.js';
import { useLatest } from '../../hooks.js';
import { href } from '../../route.js';
import type { CiWorkflowOptions, CiWorkflowsView, PullRequestPreview } from '../../types.js';
import { useApp } from '../../state.js';
import { CiList, Select } from './CiList.js';
import { Gates } from './CiGates.js';
import { YourWorkflow } from './CiWorkflow.js';
import { AGAIN, CHANGES, keptFor } from './ci-kept.js';
import { ConfigProblem, LoadProblem, Loading } from './common.js';
import { onSettingsChanged } from './events.js';
import { ciShown, typedSecret } from './logic.js';
import { Copy, Words } from '../../components/Copy.js';
import { ruleWords } from '../../components/Verdict.js';

/**
 * CI (`#/settings/ci`; `#/settings/alerts`, as Alerts had it, opens it too): Your workflow first,
 * where the repository's workflow stands against the one the switches below build, with Write file;
 * then a panel for each part the one job runs after the action, each with its switch in its header:
 * Pull request comment, Fix on failure and Alerts, their settings on the left and what lands on the
 * right; then Gates, which previews a gate's figures and what an inconclusive golden does in CI. The
 * panels come from `GET /api/ci/workflows` (src/ci-workflows.ts), asked again as you pick: the
 * switches start as the repository's workflow sets them, and the file is the repository's with only
 * what they own changed. While shadowlap.config.json can't be read, the tab says so as the others
 * do, and Write file waits. A switch changes only what Write file would write.
 */

export function CiTab() {
  const project = useApp().meta?.project?.id ?? null;
  // Another project's switches start from its own workflow: the tab starts again, with what was changed there.
  return <CiPanels key={project ?? ''} project={project} />;
}

/** The tab for one project. */
function CiPanels({ project }: { project: string | null }) {
  const { toast } = useApp();
  // What its switches were changed to (ci-kept.ts).
  const kept = keptFor(project);
  const [changed, setChanged] = useState<Partial<CiWorkflowOptions>>(() => ({ ...kept }));
  const [pending, setPending] = useState<{ what: string; for: string } | null>(null);
  const set = (patch: Partial<CiWorkflowOptions>) => {
    Object.assign(kept, patch);
    setChanged({ ...kept });
  };
  const toggle = (patch: Partial<CiWorkflowOptions>, what: string) => {
    set(patch);
    setPending({ what, for: JSON.stringify(kept) });
  };
  const { view, error, reload, servedFor } = useCiWorkflows(changed);
  useEffect(() => {
    if (!pending || !view || servedFor !== pending.for) return;
    toast(`${pending.what} · ${view.workflow.same ? AGAIN : CHANGES}`);
    setPending(null);
  }, [pending, view, servedFor, toast]);
  if (!view) {
    if (error) return <LoadProblem error={error} retry={reload} />;
    return (
      <>
        {['Your workflow', 'Pull request comment', 'Fix on failure', 'Alerts', 'Gates'].map((t) => (
          <Loading key={t} title={t} />
        ))}
      </>
    );
  }
  // What the controls show: what was changed here, else what the repository's workflow sets.
  const o = ciShown(changed, view);
  return (
    <>
      {view.configError ? <ConfigProblem error={view.configError} /> : null}
      <YourWorkflow
        view={view}
        changed={changed}
        reload={reload}
        onWritten={() => {
          // Written: the switches follow the file again.
          for (const k of Object.keys(kept) as Array<keyof CiWorkflowOptions>) delete kept[k];
          setChanged({});
        }}
      />
      <PullRequestComment o={o} view={view} onSwitch={(on) => toggle({ comment: on }, `The pull request comment is ${on ? 'on' : 'off'}`)} />
      <FixOnFailure o={o} view={view} set={set} onSwitch={(on) => toggle({ fix: on }, `Fix on failure is ${on ? 'on' : 'off'}`)} />
      <Alerts o={o} view={view} set={set} toggle={toggle} />
      <Gates o={o} view={view} set={set} />
      {error ? <p className="fieldnote err">{error.message}</p> : null}
    </>
  );
}

/**
 * The panels for what was changed: the server's answer, kept while the next one is asked so nothing
 * empties as you type, with the options it answered for (`servedFor`). Asked again when the window
 * comes back (the file or Push from CI may have changed meanwhile), when Settings changed from
 * elsewhere, in another project, and on Retry (`reload`).
 */
function useCiWorkflows(o: Partial<CiWorkflowOptions>): { view: CiWorkflowsView | null; error: Error | null; reload: () => void; servedFor: string | null } {
  const { client, meta } = useApp();
  const options = useLatest(o);
  const [seen, setSeen] = useState(0);
  const key = `${JSON.stringify(o)}:${meta?.project?.id ?? ''}:${seen}`;
  const [served, setServed] = useState<{ view: CiWorkflowsView | null; error: Error | null; servedFor: string | null }>({ view: null, error: null, servedFor: null });
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
    const asked = options.current;
    client.ciWorkflows(asked).then(
      (view) => alive && setServed({ view, error: null, servedFor: JSON.stringify(asked) }),
      (err: unknown) => alive && setServed((s) => ({ ...s, error: err instanceof Error ? err : new Error(String(err)) })),
    );
    return () => {
      alive = false;
    };
  }, [client, key, options]);
  return { ...served, reload: () => setSeen((n) => n + 1) };
}

/** The action's comment on each pull request: its switch, what it carries, and what it needs. Its preview is port/pr-comment's. */
/** What a CI feature that is off leaves undone, a line of its own under the panel's lead. */
const OffNote = ({ children }: { children: string }) => (
  <b className="offnote">
    <Words>{children}</Words>
  </b>
);

function PullRequestComment({ o, view, onSwitch }: { o: CiWorkflowOptions; view: CiWorkflowsView; onSwitch: (on: boolean) => void }) {
  return (
    <Section className={`set cip prpanel${o.comment ? '' : ' off'}`} id="pr-comment" title="Pull request comment" sub="the verdict on every pull request" actions={<Switch on={o.comment} label="Pull request comment" onChange={onSwitch} />}>
      <div className="pbody cimain">
        <Copy className="muted">One comment on each pull request, kept current on every push: each golden’s verdict by its gate, beside the base branch’s last session.</Copy>
        {o.comment ? null : <OffNote>{view.comment.offNote}</OffNote>}
        <span className="k cineeds">it needs</span>
        <CiList rows={view.comment.needs} />
      </div>
    </Section>
  );
}

function FixOnFailure({ o, view, set, onSwitch }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void; onSwitch: (on: boolean) => void }) {
  const f = view.fixOnFailure;
  return (
    <Section className={`set cip${o.fix ? '' : ' off'}`} id="fix-on-failure" title="Fix on failure" sub="a fix pull request when a rule breaks in CI" actions={<Switch on={o.fix} label="Fix on failure" onChange={onSwitch} />}>
      <div className="alertgrid">
        <div className="pbody cimain">
          <Copy className="muted">When an outcome check fails, CI runs blame, repair and verify. If verify accepts a fix, CI opens a pull request with its evidence.</Copy>
          {o.fix ? null : <OffNote>{f.offNote}</OffNote>}
          <div className="setrow tight">
            <div>
              <b id="cifixBudget-name">Budget per failing golden</b>
              <Copy as="span" id="cifixBudget-help">
                Repair stops once it’s spent.
              </Copy>
            </div>
            <Select id="cifixBudget" value={o.budget} options={f.budgets} onChange={(budget) => set({ budget })} />
          </div>
          <div className="setrow tight">
            <div>
              <b id="cifixRepairer-name">Repairer</b>
              <Copy as="span" id="cifixRepairer-help">
                Proposes fixes; verify decides.
              </Copy>
            </div>
            <Select id="cifixRepairer" value={o.repairer} options={f.repairers} onChange={(repairer) => set({ repairer })} />
          </div>
          <span className="k cineeds">it needs</span>
          <CiList rows={f.needs} />
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
          <span className="nw">
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
            {/* one flex item, so its words wrap as a line does rather than standing apart */}
            <span>
              verify: <Words>{ruleWords(pr.verify)}</Words>
            </span>
          </li>
        ) : null}
        {pr.blame ? (
          <li>
            <i />
            <span>
              blame: <Words>{pr.blame}</Words>
            </span>
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

function Alerts({ o, view, set, toggle }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void; toggle: (patch: Partial<CiWorkflowOptions>, what: string) => void }) {
  const a = view.alerts;
  return (
    <Section className={`set cip${o.alerts ? '' : ' off'}`} id="alerts" title="Alerts" sub="a message in Slack when a golden fails in CI" actions={<Switch on={o.alerts} label="Alerts" onChange={(on) => toggle({ alerts: on }, `Alerts are ${on ? 'on' : 'off'}`)} />}>
      <div className="alertgrid">
        <div className="pbody cimain">
          <Copy className="muted">The test step counts the goldens that failed. These steps post the count to Slack, then fail the job.</Copy>
          {o.alerts ? null : <OffNote>{a.offNote}</OffNote>}
          <div className="setrow tight">
            <div>
              <b id="onlyMain-name">Only for the {a.branch} branch</b>
              <Copy as="span" id="onlyMain-help">
                Pull requests stay quiet; their checks already show it.
              </Copy>
            </div>
            <Switch on={o.onlyMain} labelledBy="onlyMain-name" describedBy="onlyMain-help" onChange={(onlyMain) => toggle({ onlyMain }, onlyMain ? `Alerts are for the ${a.branch} branch only` : 'Alerts are for every branch')} />
          </div>
          <div className="setrow tight">
            <div>
              <b id="alertSecret-name">Webhook secret</b>
              <Copy as="span" id="alertSecret-help">
                The repository secret that holds the Slack webhook URL.
              </Copy>
            </div>
            <input id="alertSecret" className="inp" type="text" spellCheck={false} autoComplete="off" aria-labelledby="alertSecret-name" aria-describedby="alertSecret-help" value={o.secret} onChange={(e) => set({ secret: typedSecret(e.target.value) })} />
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
    </Section>
  );
}
