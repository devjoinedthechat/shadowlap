import { JOB_KINDS } from '../../api.js';
import { CopyButton } from '../../components/CodeBox.js';
import { EmptyState } from '../../components/States.js';
import { num } from '../../format.js';
import { commandText } from '../../goldens.js';
import { ACTIONS, PUSH_LOCAL } from '../../labels.js';
import { href } from '../../route.js';
import type { StoreSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import type { StoreSetupView } from '../../store-api.js';
import { AGAIN, CHANGES, keptFor } from './ci-kept.js';
import { CONFIG_FILE, ConfigProblem, LoadProblem, Loading, SAVING, useEditor, useFolderGone, useSettingsData } from './common.js';
import { stepWords } from '../../../src/store-steps.js';
import { shareLinksLine, syncText } from './logic.js';
import { storeLime } from './store-logic.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Section } from '../../components/Section.js';
import { Switch } from '../../components/Switch.js';
import { Code, Copy, Words } from '../../components/Copy.js';
import { DotParts } from '../../components/DotParts.js';

/**
 * Store: the team store, the project's runs in a bucket you own. Free, with nothing hosted: push
 * copies this machine's runs there, pull brings the team's back, and CI pushes its test runs. The
 * bucket, who has access with the policy to ask for, your access with Check again, the last sync
 * with what is in the store and only here, and Push from CI. One lime button, the next step: Push
 * local runs while finished runs are only here, else Continue setup while a setup is under way. A
 * project with none says so, and Set up team store opens the setup's page (`#/setup/store`, in
 * StoreSetup.tsx), as the design's Set up Team does; a setup under way leads back there from here.
 */
export function StoreTab() {
  const app = useApp();
  const { client } = app;
  const { data, error, reload } = useSettingsData(() => client.settings.store(), 'settings:store');
  // A server without the setup routes still shows the store: the setup is left out.
  const setup = useSettingsData<StoreSetupView | null>(() => client.storeSetup.view().catch(() => null), 'store:setup');
  const editor = useEditor(data?.config.version ?? null, reload);
  const gone = useFolderGone();
  if (error && !data) return <LoadProblem error={error} retry={reload} />;
  if (!data || (setup.loading && !setup.data)) return <Loading title="Store" />;
  const view = setup.data;
  if (!data.configured || !data.status) {
    return (
      <>
        {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
        {data.configured && data.error ? <p className="fieldnote err storeerr">{data.error}</p> : null}
        <NoStore setup={!!view} unreadable={!!data.config.error} gone={!!gone} />
      </>
    );
  }
  const s = data.status;
  const ci = ciStepOf(view);
  const share = shareLinksLine(data.redactRules);
  const underWay = view?.active && view.next ? view.next : null;
  // One lime: the next step, what is left of it.
  const lime = storeLime(s.onlyLocal, !!underWay);
  return (
    <>
      {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
      <Section className="set" title="Store" sub="your team’s runs, in a bucket you own" actions={<StoreActions status={s} lime={lime === 'push'} />}>
        <div className="pbody lead">
          <Copy className="muted">
            Each machine keeps its runs in <code>.shadowlap/</code>. Push copies yours to the store, so teammates and CI can open them; pull brings theirs to you. Nothing passes through Shadowlap.
          </Copy>
        </div>
        {underWay ? (
          <div className="setrow setupnext">
            <div>
              <b>Setup</b>
              <Copy as="span">
                Step {underWay.step} of 4: {stepWords(underWay.title)}. The store works already; the rest brings CI and the team in.
              </Copy>
            </div>
            <a className={lime === 'setup' ? 'btn sm lime' : 'btn sm'} href={href.storeSetup()}>
              Continue setup
            </a>
          </div>
        ) : null}
        <StoreFacts status={s} policy={data.policy} />
        <CiPushRow ciPush={s.ciPush} version={data.config.version ?? 'absent'} ci={ci} editor={editor} gone={gone} />
        <div className="setrow">
          <div>
            <b>Share links</b>
            <Copy as="span">{share.text}</Copy>
            {share.warn ? (
              <Copy as="span" className="fieldnote warn">
                {share.warn}{' '}
                <a className="more" href={href.settings('redaction')}>
                  Redaction
                </a>
              </Copy>
            ) : null}
          </div>
        </div>
      </Section>
    </>
  );
}

type Status = NonNullable<StoreSettings['status']>;

/** Pull and Push local runs, each card saying what it brings or copies and its command (Push's in the Runs page's words); Push in lime while it is the next step. */
function StoreActions({ status: s, lime }: { status: Status; lime: boolean }) {
  const app = useApp();
  const { client } = app;
  return (
    <>
      <ActionButton className="btn sm" why={jobButton(app, JOB_KINDS.pull, 'shadowlap pull')} tip="Pull" sub="Teammates’ runs from the store" command="$ shadowlap pull" onClick={() => app.guard(() => app.watchJob(client.startJob(JOB_KINDS.pull, {})))}>
        Pull
      </ActionButton>
      <ActionButton
        className={lime ? 'btn sm lime' : 'btn sm'}
        why={jobButton(app, JOB_KINDS.push, PUSH_LOCAL.command)}
        tip={PUSH_LOCAL.label}
        sub={PUSH_LOCAL.sub}
        command={`$ ${PUSH_LOCAL.command}`}
        onClick={() => app.guard(() => (s.onlyLocal ? app.watchJob(client.startJob(JOB_KINDS.push, { all: true })) : app.toast('Every finished run is in the store.')))}
      >
        {PUSH_LOCAL.label}
      </ActionButton>
    </>
  );
}

/**
 * The bucket, who has access with the policy to ask for, your access with Check again, the last sync,
 * and the last check, which Check again's job brings up to date.
 */
function StoreFacts({ status: s, policy }: { status: Status; policy: StoreSettings['policy'] }) {
  const app = useApp();
  return (
    <dl className="kvs">
      <dt>Bucket</dt>
      <dd>
        <Code>{s.url}</Code> {s.region ? <small>{s.region}</small> : null} <small>{s.providerName}</small>
      </dd>
      <dt>Who has access</dt>
      <dd>
        <Words>Whoever your cloud admin gives access to this bucket</Words>{' '}
        <small>
          <Words>people and CI, through your cloud’s own permissions; Shadowlap has no accounts</Words>
        </small>{' '}
        {policy ? (
          <CopyButton text={policy.text} label="the access policy" name="Copy access policy" sub="The access to ask your cloud admin for: list, read, write and delete in this bucket">
            Copy access policy
          </CopyButton>
        ) : null}
      </dd>
      <dt>Your access</dt>
      <dd>
        <AccessWords access={s.access} />{' '}
        <small>
          <Words>your own credentials, used on this machine</Words>
        </small>{' '}
        <ActionButton
          className="btn sm"
          why={jobButton(app, JOB_KINDS.storeCheck, 'shadowlap store check')}
          tip="Check again"
          sub="Lists, writes, reads and deletes a test object with the credentials on this machine"
          command="$ shadowlap store check"
          onClick={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.storeCheck, {})))}
        >
          Check again
        </ActionButton>
      </dd>
      <dt>Last sync</dt>
      <dd>
        {syncText(s.syncedAt)}{' '}
        <small>
          <DotParts parts={[`${num(s.inStore)} ${s.inStore === 1 ? 'run' : 'runs'} in the store`, `${num(s.onlyLocal)} only on this machine`, ...(s.queued ? [`${num(s.queued)} pushed when ${s.queued === 1 ? 'it ends' : 'they end'}`] : [])]} />
        </small>
      </dd>
      {s.check ? (
        <>
          <dt>Last check</dt>
          <dd>
            {s.check.ok ? 'access works' : 'access failed'} <small>
              <DotParts parts={checkWords(s.check)} />
            </small>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** Your access in words, an AWS profile's name as code: `AWS profile <name>`. */
function AccessWords({ access }: { access: string }) {
  const m = /^(.*?profile )(\S+)(.*)$/s.exec(access);
  if (!m) return <>{access}</>;
  return (
    <>
      {m[1]}
      <code className="nw">{m[2]}</code>
      {m[3]}
    </>
  );
}

/**
 * Push from CI: its Switch, with Undo, and Open Your workflow beside it (`.wflink`), the design's
 * link to Settings → CI, which builds the one workflow, this step with it. For GitLab CI or other CI
 * the setup added, Copy CI step takes the link's place. On a phone either comes after the Switch,
 * which sits right under what it turns on.
 */
function CiPushRow({ ciPush, version, ci, editor, gone }: { ciPush: boolean; version: string; ci: CopiedStep | null; editor: ReturnType<typeof useEditor>; gone: string | null }) {
  const app = useApp();
  const { client } = app;
  const off = app.actionsOff ?? gone ?? (editor.busy ? SAVING : null);
  // Whether Your workflow, as Settings → CI's switches build it, equals the repository's file now: its toast says so.
  const same = async () => {
    try {
      return (await client.ciWorkflows(keptFor(app.meta?.project?.id))).workflow.same;
    } catch {
      return false;
    }
  };
  const write = async (on: boolean | null, at: string) => {
    const r = await client.settings.setCiPush(on, at);
    return { ...r, same: await same() };
  };
  return (
    <div className="setrow">
      <div>
        <b id="ciPush-name">Push from CI</b>
        <Copy as="span" id="ciPush-help">
          CI pushes every test run, its report and each fix it opens, so history covers every pull request.
        </Copy>
      </div>
      {ci ? (
        <CopyButton className="linkbtn wflink" text={ci.text} label={`the ${ci.name} step`} name="Copy CI step" sub={`${ci.name}, ${ci.file}${ci.oidc ? ' · short-lived credentials, no stored keys' : ''}`}>
          Copy CI step
        </CopyButton>
      ) : (
        <a className="more wflink" href={href.settings('ci')} title="Settings → CI builds the one workflow, this step with it">
          Open Your workflow
        </a>
      )}
      <Switch
        action
        why={off}
        on={ciPush}
        labelledBy="ciPush-name"
        describedBy="ciPush-help"
        title={commandText(['store', 'push-from-ci', ciPush ? 'off' : 'on'])}
        onChange={(on) =>
          void editor.run(
            () => write(on, version),
            (r) => ciPushText(r.ciPush, r.same),
            // Back to what the file said, or to saying nothing, which is on.
            (r) => {
              if (!r.changed) return null;
              let back: { ciPush: boolean; same: boolean; version?: string } = { ciPush: r.was !== false, same: false };
              return {
                edit: async () => {
                  back = await write(r.was, r.version);
                  return back;
                },
                // Worded once it has answered: whether the file is the repository's again.
                ok: () => ciPushText(back.ciPush, back.same),
              };
            },
          )
        }
      />
    </div>
  );
}

/**
 * A Push from CI write's toast, for the value now in force, as Settings → CI's switches word theirs:
 * Your workflow's step follows it, and `same` once the file the switches build equals the repository's.
 */
const ciPushText = (on: boolean, same: boolean) => `Push from CI is ${on ? 'on' : 'off'} · ${same ? AGAIN : CHANGES}`;

/** Why a store job's button can't run here, or null: actions off, or a dashboard that doesn't run it yet. */
function jobButton(app: ReturnType<typeof useApp>, kind: string, command: string): string | null {
  if (app.actionsOff) return app.actionsOff;
  if (!app.hasKind(kind)) return `This dashboard doesn’t run ${kind} yet: ${command} in a terminal`;
  return null;
}

/** The last `store check`, in words: when, encryption, versioning and object lock, each a part of its line. */
function checkWords(c: NonNullable<NonNullable<StoreSettings['status']>['check']>): string[] {
  const when = new Date(c.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return [when, c.encryption ? `encrypted (${c.encryption})` : 'encryption unknown', `versioning ${c.versioning}`, `object lock ${c.objectLock}`];
}

interface CopiedStep {
  name: string;
  file: string;
  text: string;
  oidc: boolean;
}

/** Copy CI step: the step for GitLab CI or other CI, when the setup added (or skipped) it for one; null for GitHub Actions, whose step is Your workflow's. */
function ciStepOf(view: StoreSetupView | null): CopiedStep | null {
  const provider = view?.setup.ciProvider ?? 'github';
  return provider === 'github' ? null : (view?.ci?.find((x) => x.ci === provider) ?? null);
}

/**
 * A project with no store: what one is, and Set up team store, which opens the setup's page as the
 * design's Set up Team does; its command where the dashboard has no setup. Read-only, it says why
 * not. While shadowlap.config.json can't be read, whether it names a store is unknown, and the setup
 * would write into the file every command refuses: no setup is offered, only what to do first. With
 * the project's folder gone, the file went with it, and there is nowhere to set one up.
 */
function NoStore({ setup, unreadable, gone }: { setup: boolean; unreadable: boolean; gone: boolean }) {
  if (unreadable || gone) return <EmptyState title="The store can’t be read" text={gone ? `Settings reads the team store from ${CONFIG_FILE}, in the project’s folder, which is gone.` : `Settings reads the team store from ${CONFIG_FILE}, which can’t be read until it is fixed.`} />;
  return (
    <EmptyState
      title="No store yet"
      text="Connect a bucket you own, push your runs and add CI. About fifteen minutes, with nothing to install or host."
      step={
        setup ? (
          <ActionButton className="btn lime" href={href.storeSetup()}>
            {ACTIONS.setUpTeamStore.label}
          </ActionButton>
        ) : undefined
      }
      command={setup ? undefined : 'shadowlap store set s3://<bucket>/<project> --check'}
    />
  );
}
