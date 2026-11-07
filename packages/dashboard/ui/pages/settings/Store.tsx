import { JOB_KINDS } from '../../api.js';
import { CopyButton } from '../../components/CodeBox.js';
import { EmptyState } from '../../components/States.js';
import { num } from '../../format.js';
import { ACTIONS, PUSH_LOCAL } from '../../labels.js';
import { href } from '../../route.js';
import type { StoreSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import type { StoreSetupView } from '../../store-api.js';
import { CONFIG_FILE, ConfigProblem, LoadProblem, Loading, SAVING, useEditor, useFolderGone, useSettingsData } from './common.js';
import { stepWords } from '../../../src/store-steps.js';
import { shareLinksLine, syncText } from './logic.js';
import { storeLime } from './store-logic.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Section } from '../../components/Section.js';
import { Switch } from '../../components/Switch.js';

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
  const ci = ciStepOf(data, view);
  const share = shareLinksLine(data.redactRules);
  const underWay = view?.active && view.next ? view.next : null;
  // One lime: the next step, what is left of it.
  const lime = storeLime(s.onlyLocal, !!underWay);
  return (
    <>
      {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
      <Section className="set" title="Store" sub="your team’s runs, in a bucket you own" actions={<StoreActions status={s} lime={lime === 'push'} />}>
        <div className="pbody lead">
          <p className="muted">
            Each machine keeps its runs in <code>.shadowlap/</code>. Push copies yours to the store, so teammates and CI can open them; pull brings theirs to you. Nothing passes through Shadowlap.
          </p>
        </div>
        {underWay ? (
          <div className="setrow setupnext">
            <div>
              <b>Setup</b>
              <span>
                Step {underWay.step} of 4: {stepWords(underWay.title)}. The store works already; the rest brings CI and the team in.
              </span>
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
            <span>{share.text}</span>
            {share.warn ? (
              <span className="fieldnote warn">
                {share.warn}{' '}
                <a className="more" href={href.settings('redaction')}>
                  Redaction
                </a>
              </span>
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
        <code>{s.url}</code> {s.region ? <small>{s.region}</small> : null} <small>{s.providerName}</small>
      </dd>
      <dt>Who has access</dt>
      <dd>
        Whoever your cloud admin gives access to this bucket <small>people and CI, through your cloud’s own permissions; Shadowlap has no accounts</small>{' '}
        {policy ? (
          <CopyButton text={policy.text} label="the access policy" name="Copy access policy" sub="The access to ask your cloud admin for: list, read, write and delete in this bucket">
            Copy access policy
          </CopyButton>
        ) : null}
      </dd>
      <dt>Your access</dt>
      <dd>
        <AccessWords access={s.access} /> <small>your own credentials, used on this machine</small>{' '}
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
          {num(s.inStore)} {s.inStore === 1 ? 'run' : 'runs'} in the store · {num(s.onlyLocal)} only on this machine{s.queued ? ` · ${num(s.queued)} pushed when ${s.queued === 1 ? 'it ends' : 'they end'}` : ''}
        </small>
      </dd>
      {s.check ? (
        <>
          <dt>Last check</dt>
          <dd>
            {s.check.ok ? 'access works' : 'access failed'} <small>{checkWords(s.check)}</small>
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

/** Push from CI: its Switch, with Undo, and Copy CI step beside it for the CI the setup added. */
function CiPushRow({ ciPush, version, ci, editor, gone }: { ciPush: boolean; version: string; ci: CopiedStep | null; editor: ReturnType<typeof useEditor>; gone: string | null }) {
  const app = useApp();
  const { client } = app;
  const off = app.actionsOff ?? gone ?? (editor.busy ? SAVING : null);
  return (
    <div className="setrow">
      <div>
        <b id="ciPush-name">Push from CI</b>
        <span id="ciPush-help">CI pushes every test run, its report and each fix it opens, so history covers every pull request.</span>
      </div>
      {ci ? (
        <CopyButton text={ci.text} label={`the ${ci.name} step`} name="Copy CI step" sub={`${ci.name}, ${ci.file}${ci.oidc ? ' · short-lived credentials, no stored keys' : ''}`}>
          Copy CI step
        </CopyButton>
      ) : null}
      <Switch
        action
        why={off}
        on={ciPush}
        labelledBy="ciPush-name"
        describedBy="ciPush-help"
        title={`shadowlap store push-from-ci ${ciPush ? 'off' : 'on'}`}
        onChange={(on) =>
          void editor.run(
            () => client.settings.setCiPush(on, version),
            (r) => ciPushText(r.ciPush),
            // Back to what the file said, or to saying nothing, which is on.
            (r) => (r.changed ? { edit: () => client.settings.setCiPush(r.was, r.version), ok: ciPushText(r.was !== false) } : null),
          )
        }
      />
    </div>
  );
}

/** A Push from CI write's toast, for the value now in force. */
const ciPushText = (on: boolean) => `Push from CI ${on ? 'on' : 'off'} · written to ${CONFIG_FILE}; commit it for CI to see it`;

/** Why a store job's button can't run here, or null: actions off, or a dashboard that doesn't run it yet. */
function jobButton(app: ReturnType<typeof useApp>, kind: string, command: string): string | null {
  if (app.actionsOff) return app.actionsOff;
  if (!app.hasKind(kind)) return `This dashboard doesn’t run ${kind} yet: ${command} in a terminal`;
  return null;
}

/** The last `store check`, in words: when, encryption, versioning and object lock. */
function checkWords(c: NonNullable<NonNullable<StoreSettings['status']>['check']>): string {
  const when = new Date(c.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return [when, c.encryption ? `encrypted (${c.encryption})` : 'encryption unknown', `versioning ${c.versioning}`, `object lock ${c.objectLock}`].join(' · ');
}

interface CopiedStep {
  name: string;
  file: string;
  text: string;
  oidc: boolean;
}

/** Copy CI step: the step for the CI the setup added (or skipped) it for, else GitHub Actions'. */
function ciStepOf(data: StoreSettings, view: StoreSetupView | null): CopiedStep | null {
  const chosen = view?.ci?.find((x) => x.ci === (view.setup.ciProvider ?? 'github'));
  if (chosen) return chosen;
  return data.ciStep ? { name: 'GitHub Actions', ...data.ciStep } : null;
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
