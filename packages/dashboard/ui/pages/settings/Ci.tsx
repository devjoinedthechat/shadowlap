import { useState, type ReactNode } from 'react';
import { ALERT_FAILURES, FIX_BUDGETS, REPAIRERS, WORKFLOW_FILE, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml } from '../../../src/ci-yaml.js';
import { CodeBlock } from '../../components/bits.js';
import { Tile } from '../../components/Icon.js';
import { clock } from '../../format.js';
import { useLoad } from '../../hooks.js';
import { useApp } from '../../state.js';

/**
 * CI (`#/settings/alerts`, as Alerts had it): two panels with one layout. Settings on the left as
 * rows ending in what the step needs; on the right, what lands and a short list; the workflow file
 * across the bottom with Copy. Nothing runs on the server: the YAML is written here as you pick,
 * by the same functions docs/ci.md shows (src/ci-yaml.ts), and the steps run in your CI.
 */

/** What the panels are set to, kept while the dashboard is open. */
const kept = { fixOn: false, budget: '2.00', repairer: 'claude-code', onlyMain: true, secret: 'SLACK_WEBHOOK_URL' };

export function CiTab() {
  const { client } = useApp();
  // The repository and its main branch, for the Slack preview's link and the Alerts condition.
  const repo = useLoad(() => client.settings.ci(), 'settings:ci');
  const branch = repo.data?.branch ?? 'main';
  return (
    <>
      <FixOnFailure />
      <Alerts branch={branch} repo={repo.data?.repo ?? null} />
    </>
  );
}

function CiList({ rows, tone = '' }: { rows: ReadonlyArray<readonly [ReactNode, ReactNode]>; tone?: '' | 'err' }) {
  return (
    <ul className="cilist">
      {rows.map(([label, value], i) => (
        <li key={i}>
          <i className={tone || undefined} aria-hidden="true" />
          <span>{label}</span>
          {value ? <code>{value}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function FixOnFailure() {
  const { toast } = useApp();
  const [on, setOnState] = useState(kept.fixOn);
  const [budget, setBudgetState] = useState(kept.budget);
  const [repairer, setRepairerState] = useState(kept.repairer);
  const setOn = (v: boolean) => {
    kept.fixOn = v;
    setOnState(v);
    toast(v ? 'Fix on failure is on · add the step to your workflow' : 'Fix on failure is off');
  };
  const yaml = fixOnFailureYaml({ budget, repairer });
  return (
    <section className={`panel set cip${on ? '' : ' off'}`}>
      <header>
        <h2>Fix on failure</h2>
        <span className="sub">a fix pull request when a rule breaks in CI</span>
        <span className="sp" />
        <div className="seg" role="group" aria-label="Fix on failure">
          <button type="button" aria-pressed={on} onClick={() => !on && setOn(true)}>
            On
          </button>
          <button type="button" aria-pressed={!on} onClick={() => on && setOn(false)}>
            Off
          </button>
        </div>
      </header>
      <div className="alertgrid">
        <div className="pbody cimain">
          <p className="muted">
            <span className="ln">When an outcome check fails, CI runs blame, repair and verify.</span> <span className="ln">If verify accepts a fix, CI opens a pull request with its evidence.</span>
            {on ? null : <b className="offnote">Off: a failed check fails the build, and nobody opens a fix.</b>}
          </p>
          <div className="setrow tight">
            <div>
              <b>Budget per failing golden</b>
              <span>Repair stops once it’s spent.</span>
            </div>
            <select
              className="sel"
              aria-label="Budget per failing golden"
              value={budget}
              onChange={(e) => {
                kept.budget = e.target.value;
                setBudgetState(e.target.value);
              }}
            >
              {FIX_BUDGETS.map((b) => (
                <option key={b} value={b}>
                  ${Number(b)}
                </option>
              ))}
            </select>
          </div>
          <div className="setrow tight">
            <div>
              <b>Repairer</b>
              <span>Proposes fixes; verify decides.</span>
            </div>
            <select
              className="sel"
              aria-label="Repairer"
              value={repairer}
              onChange={(e) => {
                kept.repairer = e.target.value;
                setRepairerState(e.target.value);
              }}
            >
              {REPAIRERS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <span className="k cineeds">it needs</span>
          <CiList rows={fixOnFailureNeeds(repairer)} />
        </div>
        <div className="pbody teamside">
          <span className="k">what lands in GitHub · example</span>
          <PullRequest budget={budget} />
          <span className="k">it never</span>
          <CiList rows={fixOnFailureNever(budget)} />
        </div>
      </div>
      <div className="pbody cicode">
        <CodeBlock file={WORKFLOW_FILE} code={yaml} copyLabel="the workflow step" />
      </div>
    </section>
  );
}

/** The pull request Fix on failure opens, as GitHub shows it: an example, from the refund agent the docs follow. */
function PullRequest({ budget }: { budget: string }) {
  return (
    <div className="alertcard prcard">
      <div className="ah">
        <svg className="prico" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4" cy="3.5" r="1.7" />
          <circle cx="4" cy="12.5" r="1.7" />
          <circle cx="12" cy="12.5" r="1.7" />
          <path d="M4 5.2v5.6M12 10.8V6.5a2 2 0 0 0-2-2H7.4M9 3 7.4 4.5 9 6" />
        </svg>
        <b>Escalate refunds above the policy limit</b>
        <span>#142</span>
      </div>
      <p className="msgtext">
        shadowlap-bot wants to merge 1 commit into <code>main</code>{' '}
        <span className="nw">
          from <code>shadowlap/fix-refund-limit</code>
        </span>
      </p>
      <ul className="prl">
        <li>
          <i className="ok" />
          verify: target 3 of 3 · held-out 2 of 2 · good 5 of 5
        </li>
        <li>
          <i />
          blame: lost at model call #5 · confidence high
        </li>
        <li>
          <i />
          <code>prompts/refund.md</code> +1 −0 · ≈$0.84 of ${Number(budget).toFixed(2)}
        </li>
      </ul>
    </div>
  );
}

function Alerts({ branch, repo }: { branch: string; repo: string | null }) {
  const [onlyMain, setOnlyMainState] = useState(kept.onlyMain);
  const [secret, setSecretState] = useState(kept.secret);
  const setOnlyMain = (v: boolean) => {
    kept.onlyMain = v;
    setOnlyMainState(v);
  };
  const yaml = alertsYaml({ onlyMain, secret, branch });
  const msg = alertsMessage({ failed: 1, branch: onlyMain ? branch : 'fix-refund-limit', runUrl: `github.com/${repo ?? '<owner>/<repo>'}/actions/runs/…` });
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
              <b>Only for the {branch} branch</b>
              <span>Pull requests stay quiet; their checks already show it.</span>
            </div>
            <span
              className="switch"
              role="switch"
              tabIndex={0}
              aria-checked={onlyMain}
              aria-label={`Only for the ${branch} branch`}
              onClick={() => setOnlyMain(!onlyMain)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  setOnlyMain(!onlyMain);
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
            <input
              className="inp"
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label="Webhook secret"
              value={secret}
              onChange={(e) => {
                // A secret's name as GitHub takes it: letters, digits and _.
                const v = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
                kept.secret = v;
                setSecretState(v);
              }}
            />
          </div>
          <span className="k cineeds">it needs</span>
          <CiList rows={alertsNeeds(secret)} />
        </div>
        <div className="pbody teamside">
          <span className="k">what lands in Slack</span>
          <div className="slackmsg">
            <Tile />
            <div className="sm">
              <div className="sh">
                <b>GitHub Actions</b>
                <span className="sapp">APP</span>
                <span className="t">{clock(Date.now())}</span>
              </div>
              <p>{msg.text}</p>
              <span className="sl">{msg.link}</span>
            </div>
          </div>
          <span className="k">a golden fails when</span>
          <CiList rows={ALERT_FAILURES} tone="err" />
        </div>
      </div>
      <div className="pbody cicode">
        <CodeBlock file={WORKFLOW_FILE} code={yaml} copyLabel={`the workflow steps (secret ${alertsSecret(secret)})`} />
      </div>
    </section>
  );
}
