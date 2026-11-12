import { ActionButton } from '../../components/ActionButton.js';
import { Copy } from '../../components/Copy.js';
import { href } from '../../route.js';
import type { CiName, StoreSetupView } from '../../store-api.js';
import type { SetupStepState } from './store-logic.js';

/**
 * The store's setup, step 3, Push from CI. On GitHub Actions, Your workflow on Settings → CI runs
 * the goldens once and pushes them, its sign-in steps and all, so the step is two buttons: Turn on
 * Push from CI and Skip for now, each recorded with the setup and written to the config as Settings →
 * Store's switch writes it. GitLab CI and other CI keep their step to paste, Copy, I added it and
 * Skip for now, written to the config the same way: I added it turns Push from CI on, Skip for now
 * off, as one rule for every CI.
 */

type SetupCi = NonNullable<StoreSetupView['ci']>[number];
type Save = (step: { ci: 'added' | 'skipped'; ciProvider: CiName; ciPush?: boolean }, ok: string) => void;

const LINE = 'CI pushes every test run, its report and each fix it opens, so the store covers every pull request.';

export function PushFromCiStep({ view, state, ci, setCi, step, saving, off, save, copy }: { view: StoreSetupView; state: SetupStepState; ci: CiName; setCi: (ci: CiName) => void; step: SetupCi | null; saving: boolean; off: string | null; save: Save; copy: (text: string, what: string) => void }) {
  if (state === 'done') {
    const github = (view.setup.ciProvider ?? 'github') === 'github';
    if (view.setup.ci === 'skipped') return <Copy>{github ? 'Skipped. Turn on Push from CI any time on Settings → Store.' : 'Skipped. Turn on Push from CI any time on Settings → Store, where its step is too.'}</Copy>;
    return github ? (
      <Copy>
        Push from CI is on: Your workflow on Settings → CI pushes every test run, its report and each fix it opens, so the store covers every pull request.{' '}
        <a className="more nw" href={href.settings('ci')}>
          Write the workflow →
        </a>
      </Copy>
    ) : (
      <Copy>{LINE}</Copy>
    );
  }
  const github = !!step?.workflow;
  return (
    <>
      <Copy>{github ? `${LINE} Your workflow on Settings → CI adds the push step, and CI needs its own access to the bucket, with short-lived credentials where your CI allows it.` : `${LINE} Give CI its own access to the bucket, with short-lived credentials where your CI allows it.`}</Copy>
      {state === 'cur' && view.ci ? (
        <>
          <div className="seg" role="group" aria-label="CI">
            {view.ci.map((x) => (
              <button key={x.ci} type="button" aria-pressed={ci === x.ci} onClick={() => setCi(x.ci)}>
                {x.name}
              </button>
            ))}
          </div>
          {github ? (
            <div className="actions">
              <ActionButton className="btn lime" disabled={saving} why={off} onClick={() => save({ ci: 'added', ciProvider: ci, ciPush: true }, 'Push from CI is on · Your workflow changes with it')}>
                Turn on Push from CI
              </ActionButton>
              <ActionButton className="btn quiet" disabled={saving} why={off} onClick={() => save({ ci: 'skipped', ciProvider: ci, ciPush: false }, 'Skipped for now · Push from CI is off')}>
                Skip for now
              </ActionButton>
            </div>
          ) : (
            <>
              {step ? (
                <>
                  <pre tabIndex={0} className="codebox" title={step.file}>
                    {step.text}
                  </pre>
                  {step.notes.map((n) => (
                    <p key={n} className="muted cinote">
                      {n}
                    </p>
                  ))}
                </>
              ) : null}
              <div className="actions">
                <button className="btn" type="button" disabled={!step} onClick={() => step && copy(step.text, `the ${step.name} step`)}>
                  Copy
                </button>
                <ActionButton className="btn lime" disabled={saving} why={off} onClick={() => save({ ci: 'added', ciProvider: ci, ciPush: true }, 'Push from CI added')}>
                  I added it
                </ActionButton>
                <ActionButton className="btn quiet" disabled={saving} why={off} onClick={() => save({ ci: 'skipped', ciProvider: ci, ciPush: false }, 'Skipped for now · Push from CI is off')}>
                  Skip for now
                </ActionButton>
              </div>
            </>
          )}
        </>
      ) : null}
    </>
  );
}
