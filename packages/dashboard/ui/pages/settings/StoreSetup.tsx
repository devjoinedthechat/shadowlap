import { useEffect, useRef, useState, type ReactNode } from 'react';
import { JOB_KINDS } from '../../api.js';
import { PageHeader } from '../../components/bits.js';
import { Page } from '../../components/Page.js';
import { copyText } from '../../dom.js';
import { num } from '../../format.js';
import { useLoad } from '../../hooks.js';
import { href } from '../../route.js';
import { projectOf } from '../../shell/ProjectBlock.js';
import { useApp } from '../../state.js';
import type { CiName, SetupProvider, SetupUrlCheck, StoreSetupView } from '../../store-api.js';
import { errorText } from '../../toast.js';
import type { JobView } from '../../types.js';
import { LoadProblem, Loading } from './common.js';
import { setupStates, type SetupStepState } from './store-logic.js';
import { ACTIONS } from '../../labels.js';
import { ActionButton } from '../../components/ActionButton.js';
import { PushFromCiStep } from './StoreSetupCi.js';

/**
 * The team store's setup, free like the rest of Shadowlap, on a page of its own (`#/setup/store`)
 * as the design's setup is: four steps, each unlocking the next, with the command beside it.
 * Connect your bucket (the provider, the bucket and folder checked against its scheme, the
 * credentials this machine would use, the access to ask the cloud admin for, then `store set
 * --check`, which writes the store only once the check passes); push your runs (`push --all`); push
 * from CI (on GitHub Actions, Turn on Push from CI or Skip for now; GitLab CI's or other CI's
 * step, then I added it or Skip for now); bring your team (the config change to commit, then Finish). Settings → Store's Set up team store
 * leads here, and so does the palette, and Needs a look while a setup is under way. `view` is the
 * server's (`GET /api/store/setup`); the steps' jobs and records go through it.
 */

type Provider = SetupProvider['provider'];

function Step({ n, state, title, cli, children }: { n: number; state: SetupStepState; title: string; cli?: string | null; children: ReactNode }) {
  return (
    <li className={state}>
      <span className="sn">{state === 'done' ? '✓' : n}</span>
      <div className="sb">
        <h3>{title}</h3>
        {children}
        {cli && state === 'cur' ? (
          <div className="cli">
            <span>or in a terminal</span>
            <code>$ {cli}</code>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The four steps. `onChange` reads the setup again: after a step is recorded, and when a job one
 * started (connecting, pushing) ends.
 */
export function StoreSetup({ view, finishedNow, onFinish, onChange }: { view: StoreSetupView; finishedNow: boolean; onFinish: () => void; onChange: (job?: Promise<JobView>) => void }) {
  const app = useApp();
  const { client, guard, hasKind, actionsOff, toast } = app;
  const states = setupStates(view, finishedNow);
  const off = actionsOff;
  const [provider, setProvider] = useState<Provider>(view.store?.provider ?? 's3');
  const [url, setUrl] = useState('');
  const [tried, setTried] = useState(false);
  const [checked, setChecked] = useState<SetupUrlCheck | null>(null);
  const [ci, setCi] = useState<CiName>(view.setup.ciProvider ?? 'github');
  const [saving, setSaving] = useState(false);
  const typed = url.trim();
  const p = view.providers.find((x) => x.provider === provider) ?? view.providers[0]!;

  // The URL as typed, checked against the provider picked: the access to ask for follows the bucket and folder.
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    const t = setTimeout(
      () =>
        void client.storeSetup.check(provider, typed).then(
          (r) => n === asked.current && setChecked(r),
          () => undefined,
        ),
      typed ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [client, provider, typed]);
  const current = checked && checked.provider === provider ? checked : null;
  const urlError = tried && current && !current.ok && typed ? current.error : tried && !typed ? `Type the bucket and folder, such as ${p.example}.` : null;

  // Checked again as it is now, so a URL typed a moment before the click is the one that runs.
  const connect = () => {
    setTried(true);
    if (!typed) return;
    guard(() => {
      void client.storeSetup.check(provider, typed).then(
        (r) => {
          asked.current++;
          setChecked(r);
          if (r.ok) onChange(client.startJob(JOB_KINDS.storeSet, { url: typed, provider }));
        },
        (err: unknown) => toast(errorText(err), 'error'),
      );
    });
  };
  const save = (step: Parameters<typeof client.storeSetup.save>[0], ok: string) =>
    guard(() => {
      setSaving(true);
      void client.storeSetup
        .save(step)
        .then(
          () => {
            toast(ok);
            onChange();
          },
          (err: unknown) => toast(errorText(err), 'error'),
        )
        .finally(() => setSaving(false));
    });
  const copy = (text: string, what: string) => void copyText(text).then((done) => toast(done ? `Copied ${what}` : 'Copying was refused by the browser'));
  const credentials = (current?.ok ? current.credentials : null) ?? p.credentials;
  const step = view.ci?.find((x) => x.ci === ci) ?? null;
  const store = view.store;
  const runs = view.runs.onlyLocal;
  const pushOff = off ?? (hasKind(JOB_KINDS.push) ? null : 'This dashboard doesn’t run push yet: shadowlap push --all in a terminal');
  const connectOff = off ?? (hasKind(JOB_KINDS.storeSet) ? null : 'This dashboard doesn’t connect stores yet: shadowlap store set <url> --check in a terminal');

  return (
    <>
      <ol className="setup storesetup">
        <Step n={1} state={states.connect} title="Connect your bucket" cli={current?.ok ? current.command : `shadowlap store set ${typed || p.example} --check`}>
          {states.connect === 'done' && store ? (
            <>
              <div className="recline ok">
                <span className="ic" />
                <span>
                  Connected <code>{store.url}</code> · list, write, read and delete work
                </span>
              </div>
              {view.check && (view.check.versioning === 'off' || view.check.versioning === 'suspended') ? (
                <p className="fieldnote warn">Versioning is off, so a run deleted or overwritten in the bucket can’t be recovered. Turn it on in the bucket’s settings; shadowlap store check says how.</p>
              ) : null}
            </>
          ) : (
            <p>Runs go to object storage you own. The CLI uses the credentials already on this machine, so Shadowlap never sees the bucket, the runs or the keys.</p>
          )}
          {states.connect === 'cur' ? (
            <>
              <div className="seg provseg" role="group" aria-label="Where the bucket is">
                {view.providers.map((x) => (
                  <button key={x.provider} type="button" aria-pressed={provider === x.provider} onClick={() => setProvider(x.provider)}>
                    {x.name}
                  </button>
                ))}
              </div>
              <label className="cmdin">
                <span className="sr">Bucket and folder</span>
                <b>→</b>
                <input
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  value={url}
                  placeholder={p.example}
                  aria-invalid={!!urlError}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') connect();
                  }}
                />
              </label>
              {urlError ? <p className="fieldnote err">{urlError}</p> : null}
              <dl className="kvs onbkv">
                <dt>Credentials</dt>
                <dd className={credentials ? undefined : 'prose'}>
                  {credentials ? credentials.uses : <span className="warnt">none found on this machine</span>} <small>{credentials ? credentials.from : `${p.hint.uses}: ${p.hint.from}`}</small>
                </dd>
              </dl>
              {current ? (
                <details className="foundsum">
                  <summary>The access to ask your cloud admin for</summary>
                  {[current.policy.writer, current.policy.pullRequest].map((part) => (
                    <div key={part.for} className="policypart">
                      <p className="muted">
                        For {part.for}: {part.kind}
                      </p>
                      <pre tabIndex={0} className="codebox">{part.text}</pre>
                      <button className="btn sm" type="button" onClick={() => copy(part.text, `the access for ${part.for}`)}>
                        Copy
                      </button>
                    </div>
                  ))}
                </details>
              ) : null}
              <div className="actions">
                <ActionButton className="btn lime" why={connectOff} onClick={connect}>
                  Check access and connect
                </ActionButton>
              </div>
            </>
          ) : null}
        </Step>

        <Step n={2} state={states.push} title="Push your runs" cli="shadowlap push --all">
          {states.push === 'done' ? (
            <div className="recline ok">
              <span className="ic" />
              <span>{view.runs.pushedHere ? `Pushed ${num(view.runs.pushedHere)} ${view.runs.pushedHere === 1 ? 'run' : 'runs'} · blobs shared between runs went up once` : 'Nothing to push yet · runs recorded from now on go with the next push'}</span>
              {view.runs.pushedHere ? (
                <a className="btn" href={href.runs()}>
                  Open Runs
                </a>
              ) : null}
            </div>
          ) : (
            <p>
              {num(runs)} {runs === 1 ? 'run' : 'runs'} on this machine. Push copies them to the bucket so teammates can open them. A run still recording goes when it ends.
            </p>
          )}
          {states.push === 'cur' ? (
            <div className="actions">
              <ActionButton className="btn lime" why={pushOff} onClick={() => guard(() => onChange(client.startJob(JOB_KINDS.push, { all: true })))}>
                Push {num(runs)} {runs === 1 ? 'run' : 'runs'}
              </ActionButton>
            </div>
          ) : null}
        </Step>

        <Step n={3} state={states.ci} title="Push from CI" cli={step ? step.command : null}>
          <PushFromCiStep view={view} state={states.ci} ci={ci} setCi={setCi} step={step} saving={saving} off={off} save={save} copy={copy} />
        </Step>

        <Step n={4} state={states.team} title="Bring your team" cli={view.commit && states.team === 'cur' ? view.commit.command : null}>
          <p>Commit the project config. Anyone whose cloud account can read the bucket gets the store on their next pull.</p>
          {states.team !== 'todo' && view.commit ? (
            <>
              <pre tabIndex={0} className="codebox">
                {`  ${view.commit.file}\n`}
                <span className="add">{`+ ${view.commit.line}`}</span>
              </pre>
              {states.team === 'cur' ? (
                <div className="actions">
                  <button className="btn" type="button" onClick={() => copy(view.commit!.command, 'the commit command')}>
                    Copy the commit command
                  </button>
                  <ActionButton
                    className="btn lime"
                    disabled={saving}
                    why={off}
                    onClick={() =>
                      guard(() => {
                        setSaving(true);
                        void client.storeSetup
                          .save({ finished: true })
                          .then(
                            () => {
                              onFinish();
                              toast('The store is set up');
                              onChange();
                            },
                            (err: unknown) => toast(errorText(err), 'error'),
                          )
                          .finally(() => setSaving(false));
                      })
                    }
                  >
                    Finish
                  </ActionButton>
                </div>
              ) : null}
            </>
          ) : null}
        </Step>
      </ol>
      {finishedNow ? (
        <div className="setupdone">
          <div>
            <b>The store is set up.</b>
            <span>Your runs are in the bucket. Teammates’ runs show up here as they pull the config and push.</span>
          </div>
          <a className="btn lime" href={href.overview()}>
            Go to the overview
          </a>
        </div>
      ) : null}
    </>
  );
}

/** The design's words over the steps. */
const SETUP_TEXT = 'Your team’s runs, in a bucket you own. Fifteen minutes, nothing to host.';

/**
 * `#/setup/store`: the setup's page, with the design's header. It reads where the setup stands again
 * when runs or the store's rows change, and when a job it started ends. A setup finished before
 * says so, with the way to the store's settings; a store set with the CLI shows the steps left.
 */
export function StoreSetupPage() {
  const app = useApp();
  const { client, tick, feeds, jobs, meta, watchJob } = app;
  const [seen, setSeen] = useState(0);
  const [finishedNow, setFinishedNow] = useState(false);
  const mine = useRef(new Set<string>());
  useEffect(() => {
    for (const w of jobs) {
      if (!w.job.done || !mine.current.has(w.job.id)) continue;
      mine.current.delete(w.job.id);
      setSeen((n) => n + 1);
    }
  }, [jobs]);
  const loaded = useLoad(() => client.storeSetup.view(), 'store-setup', `${tick}:${feeds.team ?? 0}:${seen}`);
  const name = projectOf(meta)?.name ?? 'this project';
  const header = <PageHeader eyebrow={`store · ${name}`} title={ACTIONS.setUpTeamStore.label} text={SETUP_TEXT} />;
  const view = loaded.data;
  if (!view) return <Page busy={!loaded.error}>{header}{loaded.error ? <LoadProblem error={loaded.error} /> : <Loading title="Store" />}</Page>;
  const onChange = (job?: Promise<JobView>) => {
    if (job) {
      void job.then((j) => mine.current.add(j.id), () => undefined);
      watchJob(job);
    }
    setSeen((n) => n + 1);
  };
  return (
    <Page>
      {header}
      {view.store && view.setup.finishedAt !== null && !finishedNow ? <SetUpAlready view={view} /> : <StoreSetup view={view} finishedNow={finishedNow} onFinish={() => setFinishedNow(true)} onChange={onChange} />}
    </Page>
  );
}

/** A setup finished before: the store it set up, and where it stands now. */
function SetUpAlready({ view }: { view: StoreSetupView }) {
  return (
    <div className="setupdone">
      <div>
        <b>The store is set up.</b>
        <span>
          {view.store!.url} · {num(view.runs.onlyLocal)} {view.runs.onlyLocal === 1 ? 'run' : 'runs'} only on this machine. Its settings are in Settings → Store.
        </span>
      </div>
      <a className="btn" href={href.settings('store')}>
        Open Settings → Store
      </a>
      <a className="btn lime" href={href.overview()}>
        Go to the overview
      </a>
    </div>
  );
}
