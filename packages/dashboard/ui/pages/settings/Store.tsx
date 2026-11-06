import { JOB_KINDS } from '../../api.js';
import { copyText } from '../../dom.js';
import { num } from '../../format.js';
import { ACTIONS } from '../../labels.js';
import { href } from '../../route.js';
import type { StoreSettings } from '../../settings-api.js';
import { useApp } from '../../state.js';
import type { StoreSetupView } from '../../store-api.js';
import { CONFIG_FILE, ConfigProblem, LoadProblem, Loading, SAVING, useEditor, useFolderGone, useSettingsData } from './common.js';
import { stepWords } from '../../../src/store-steps.js';
import { shareLinksLine, syncText } from './logic.js';
import { ActionButton } from '../../components/ActionButton.js';

/**
 * Store: the team store, the project's runs in a bucket you own. Free, with nothing hosted: push
 * copies this machine's runs there, pull brings the team's back, and CI pushes its test runs. The
 * bucket, your access, the last sync with what is in the store and only here, and Push from CI. A
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
  if (error && !data) return <LoadProblem error={error} />;
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
  const version = data.config.version ?? 'absent';
  const off = app.actionsOff ?? gone ?? (editor.busy ? SAVING : null);
  const push = jobButton(app, JOB_KINDS.push, 'shadowlap push --all');
  const pull = jobButton(app, JOB_KINDS.pull, 'shadowlap pull');
  const ci = ciStepOf(data, view);
  const share = shareLinksLine(data.redactRules);
  return (
    <>
      {data.config.error ? <ConfigProblem error={data.config.error} /> : null}
      <section className="panel set">
        <header>
          <h2>Store</h2>
          <span className="sub">your team’s runs, in a bucket you own</span>
          <span className="sp" />
          <ActionButton className="btn sm" why={pull} title={`Bring the team’s runs from ${s.name}`} onClick={() => app.guard(() => app.watchJob(client.startJob(JOB_KINDS.pull, {})))}>
            Pull
          </ActionButton>
          <ActionButton
            className="btn sm lime"
            why={push}
            title={s.onlyLocal ? `Copy ${num(s.onlyLocal)} ${s.onlyLocal === 1 ? 'run' : 'runs'} to ${s.name}` : 'Every finished run is in the store'}
            onClick={() => app.guard(() => (s.onlyLocal ? app.watchJob(client.startJob(JOB_KINDS.push, { all: true })) : app.toast('Every finished run is in the store.')))}
          >
            Push local runs
          </ActionButton>
        </header>
        <div className="pbody lead">
          <p className="muted">
            Each machine keeps its runs in <code>.shadowlap/</code>. Push copies yours to the store, so teammates and CI can open them; pull brings theirs to you. Nothing passes through Shadowlap.
          </p>
        </div>
        {view?.active && view.next ? (
          <div className="setrow setupnext">
            <div>
              <b>Setup</b>
              <span>
                Step {view.next.step} of 4: {stepWords(view.next.title)}. The store works already; the rest brings CI and the team in.
              </span>
            </div>
            <a className="btn sm" href={href.storeSetup()}>
              Continue the setup
            </a>
          </div>
        ) : null}
        <dl className="kvs">
          <dt>Bucket</dt>
          <dd>
            {s.url} {s.region ? <small>{s.region}</small> : null} <small>{s.providerName}</small>
          </dd>
          <dt>Who has access</dt>
          <dd className="prose">
            Whoever your cloud admin gives access to this bucket <small>people and CI, through your cloud’s own permissions; Shadowlap has no accounts</small>
          </dd>
          <dt>Your access</dt>
          <dd className={s.access.length > 60 ? 'prose' : undefined}>
            {s.access} <small>your own credentials, used on this machine</small>
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
        <div className="setrow">
          <div>
            <b>Push from CI</b>
            <span>CI pushes every test run, its report and each fix it opens, so history covers every pull request.</span>
          </div>
          {ci ? <CiStepButton step={ci} /> : null}
          <div className="seg" role="group" aria-label="Push from CI">
            {[true, false].map((on) => (
              <ActionButton
                key={String(on)}
                aria-pressed={s.ciPush === on}
                why={off}
                title={`shadowlap store push-from-ci ${on ? 'on' : 'off'}`}
                onClick={() => {
                  if (s.ciPush === on) return;
                  void editor.run(() => client.settings.setCiPush(on, version), () => `Push from CI ${on ? 'on' : 'off'} · written to ${CONFIG_FILE}; commit it for CI to see it`);
                }}
              >
                {on ? 'On' : 'Off'}
              </ActionButton>
            ))}
          </div>
        </div>
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
      </section>
    </>
  );
}

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

function CiStepButton({ step }: { step: CopiedStep }) {
  const { toast } = useApp();
  return (
    <button
      className="linkbtn"
      type="button"
      title={`${step.name}, ${step.file}${step.oidc ? ' · short-lived credentials, no stored keys' : ''}`}
      onClick={() => void copyText(step.text).then((ok) => toast(ok ? `Copied the ${step.name} step` : 'Copying was refused by the browser'))}
    >
      Copy CI step
    </button>
  );
}

/**
 * A project with no store: what one is, and Set up team store, which opens the setup's page as the
 * design's Set up Team does; its command where the dashboard has no setup. Read-only, it says why
 * not. While shadowlap.config.json can't be read, whether it names a store is unknown, and the setup
 * would write into the file every command refuses: no setup is offered, only what to do first. With
 * the project's folder gone, the file went with it, and there is nowhere to set one up.
 */
function NoStore({ setup, unreadable, gone }: { setup: boolean; unreadable: boolean; gone: boolean }) {
  if (unreadable || gone)
    return (
      <section className="panel stepempty nostore">
        <h3>The store can’t be read</h3>
        <p>{gone ? `Settings reads the team store from ${CONFIG_FILE}, in the project’s folder, which is gone.` : `Settings reads the team store from ${CONFIG_FILE}, which can’t be read until it is fixed.`}</p>
      </section>
    );
  return (
    <section className="panel stepempty nostore">
      <h3>No store yet</h3>
      <p>Connect a bucket you own, push your runs and add CI. About fifteen minutes, with nothing to install or host.</p>
      {!setup ? (
        <div className="cli">
          <span>in a terminal</span>
          <code>{'$ shadowlap store set s3://<bucket>/<project> --check'}</code>
        </div>
      ) : (
        <ActionButton className="btn lime" href={href.storeSetup()}>
          {ACTIONS.setUpTeamStore.label}
        </ActionButton>
      )}
    </section>
  );
}
