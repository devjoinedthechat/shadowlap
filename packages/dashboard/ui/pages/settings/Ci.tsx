import { useEffect, useId, useState } from 'react';
import { previewSub, PREVIEW_WAIT } from '../../ci/words.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Icon, Tile } from '../../components/Icon.js';
import { Section } from '../../components/Section.js';
import { Switch } from '../../components/Switch.js';
import { shortFixId } from '../../fixes/model.js';
import { clock } from '../../format.js';
import { useLoad } from '../../hooks.js';
import { ACTIONS } from '../../labels.js';
import { PR_COMMENT_ASK } from '../../page-ask.js';
import { href } from '../../route.js';
import { useServedParts } from '../../served-parts.js';
import type { CiWorkflowOptions, CiWorkflowsView, PullRequestPreview } from '../../types.js';
import { useApp } from '../../state.js';
import { ListFold, Needs, Select } from './CiList.js';
import { YourWorkflow } from './CiWorkflow.js';
import { AGAIN, CHANGES, keptFor } from './ci-kept.js';
import { useCiWorkflows } from './ci-read.js';
import { ConfigProblem, LoadProblem, Loading } from './common.js';
import { ciShown, typedSecret } from './logic.js';
import { Copy, Words } from '../../components/Copy.js';
import { ruleWords } from '../../components/Verdict.js';

/**
 * CI (`#/settings/ci`; `#/settings/alerts`, as Alerts had it, opens it too): Your workflow first,
 * where the repository's workflow stands against the one the switches below build, with Write file
 * and what an inconclusive golden does in CI; then a panel for each part the one job runs after the
 * action, each with its switch in its header: Pull request comment, Fix on failure and Alerts, their
 * settings on the left and what lands on the right. A part that is off is its header and one line,
 * what happens without it, with Show settings; each list (what it needs, what it never does, what
 * fails a golden) opens from its name and count, what a part needs open already while a row of it
 * is amber. A gate's figures to try are a tab of their own,
 * Gates (Gates.tsx). The panels come from `GET /api/ci/workflows` (src/ci-workflows.ts), asked
 * again as you pick: the switches start as the repository's workflow sets them, and the file is the
 * repository's with only what they own changed. While shadowlap.config.json can't be read, the tab
 * says so as the others do, and Write file waits. A switch changes only what Write file would write.
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
        {['Your workflow', 'Pull request comment', 'Fix on failure', 'Alerts'].map((t) => (
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
        inconclusive={o.inconclusive ?? 'fail'}
        set={set}
        reload={reload}
        onWritten={() => {
          // Written: the switches follow the file again.
          for (const k of Object.keys(kept) as Array<keyof CiWorkflowOptions>) delete kept[k];
          setChanged({});
        }}
      />
      <PullRequestComment o={o} view={view} toggle={toggle} />
      <FixOnFailure o={o} view={view} set={set} onSwitch={(on) => toggle({ fix: on }, `Fix on failure is ${on ? 'on' : 'off'}`)} />
      <Alerts o={o} view={view} set={set} toggle={toggle} />
      {error ? <p className="fieldnote err">{error.message}</p> : null}
    </>
  );
}

/**
 * A part's fold. Off, the panel is its header and `line`: what the part leaves undone, and Show
 * settings, which opens the panel under it for a look. `body` goes on what that opens, and what
 * switching the part on does: its settings, what it needs and what lands, drawn either way and
 * hidden while folded.
 */
function usePartFold(on: boolean, offNote: string) {
  const [peek, setPeek] = useState(false);
  const id = useId();
  const line = on ? null : (
    <div className="pbody cioff">
      <b className="offnote">
        <Words>{offNote}</Words>
      </b>
      <button className="linkbtn" type="button" aria-expanded={peek} aria-controls={id} onClick={() => setPeek(!peek)}>
        {peek ? 'Hide' : 'Show'} settings
        <Icon name="caret" />
      </button>
    </div>
  );
  return { line, body: { id, hidden: !(on || peek) } };
}

/**
 * The action's comment on each pull request: its switch, what it carries, the decisions' switch, its
 * preview and what posting it needs. The preview is the newest session's that ran every golden, read
 * as the panel shows and again as the tests feed moves; before one, Preview pull request comment
 * waits, saying why. The palette's row asks for it here (`PR_COMMENT_ASK`). Its dialog comes from
 * the served parts (pages/served.tsx), so a press whose script didn't come says so in the error toast.
 */
function PullRequestComment({ o, view, toggle }: { o: CiWorkflowOptions; view: CiWorkflowsView; toggle: (patch: Partial<CiWorkflowOptions>, what: string) => void }) {
  const { client, feeds } = useApp();
  const { PrCommentDialog } = useServedParts();
  const preview = useLoad(() => client.settings.prComment(), 'pr-comment', feeds.tests ?? 0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (PR_COMMENT_ASK.take()) setOpen(true);
    return PR_COMMENT_ASK.on(() => setOpen(true));
  }, []);
  const s = preview.data?.session ?? null;
  const waits = !!preview.data && !s;
  const fold = usePartFold(o.comment, view.comment.offNote);
  return (
    <Section
      className={`set cip prpanel${o.comment ? '' : ' off'}`}
      id="pr-comment"
      title="Pull request comment"
      sub="the verdict on every pull request"
      actions={<Switch on={o.comment} label="Pull request comment" onChange={(on) => toggle({ comment: on }, `The pull request comment is ${on ? 'on' : 'off'}`)} />}
    >
      {fold.line}
      <div className="pbody cimain" {...fold.body}>
        <Copy className="muted">{`One comment on each pull request, kept current on every push: each golden’s verdict by its gate, beside the base branch’s last session, ${o.decisions ? 'the decisions the branch changes, ' : ''}a run’s cost before and after, and what planted instructions did.`}</Copy>
        <div className="setrow tight">
          <div>
            <b id="cidecisions-name">The decisions the branch changes</b>
            <Copy as="span" id="cidecisions-help">
              Asks the goldens’ models on every push, so the step needs their keys.
            </Copy>
          </div>
          <Switch on={o.decisions} labelledBy="cidecisions-name" describedBy="cidecisions-help" onChange={(decisions) => toggle({ decisions }, `The decisions are ${decisions ? 'on' : 'off'}`)} />
        </div>
        <div className="actions">
          <ActionButton className="btn" reads tip={ACTIONS.previewPrComment.label} sub={s ? previewSub(s) : null} why={waits ? PREVIEW_WAIT.why : null} whyTip={waits ? PREVIEW_WAIT.whyTip : undefined} onClick={() => setOpen(true)}>
            {ACTIONS.previewPrComment.label}
          </ActionButton>
        </div>
        <Needs rows={view.comment.needs} />
      </div>
      {open && PrCommentDialog ? <PrCommentDialog preview={preview.data} onClose={() => setOpen(false)} /> : null}
    </Section>
  );
}

function FixOnFailure({ o, view, set, onSwitch }: { o: CiWorkflowOptions; view: CiWorkflowsView; set: (patch: Partial<CiWorkflowOptions>) => void; onSwitch: (on: boolean) => void }) {
  const f = view.fixOnFailure;
  const fold = usePartFold(o.fix, f.offNote);
  return (
    <Section className={`set cip${o.fix ? '' : ' off'}`} id="fix-on-failure" title="Fix on failure" sub="a fix pull request when a rule breaks in CI" actions={<Switch on={o.fix} label="Fix on failure" onChange={onSwitch} />}>
      {fold.line}
      <div className="alertgrid" {...fold.body}>
        <div className="pbody cimain">
          <Copy className="muted">When an outcome check fails, CI runs blame, repair and verify. If verify accepts a fix, CI opens a pull request with its evidence.</Copy>
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
          <Needs rows={f.needs} />
        </div>
        <div className="pbody teamside">
          <span className="k">{f.preview.example ? 'what lands in GitHub · example' : 'what lands in GitHub'}</span>
          <PullRequest pr={f.preview} />
          <ListFold name="it never" rows={f.never} />
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
  const fold = usePartFold(o.alerts, a.offNote);
  return (
    <Section className={`set cip${o.alerts ? '' : ' off'}`} id="alerts" title="Alerts" sub="a message in Slack when a golden fails in CI" actions={<Switch on={o.alerts} label="Alerts" onChange={(on) => toggle({ alerts: on }, `Alerts are ${on ? 'on' : 'off'}`)} />}>
      {fold.line}
      <div className="alertgrid" {...fold.body}>
        <div className="pbody cimain">
          <Copy className="muted">The test step counts the goldens that failed. These steps post the count to Slack, then fail the job.</Copy>
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
          <Needs rows={a.needs} />
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
          <ListFold name="a golden fails when" rows={a.failures} tone="err" />
        </div>
      </div>
    </Section>
  );
}
