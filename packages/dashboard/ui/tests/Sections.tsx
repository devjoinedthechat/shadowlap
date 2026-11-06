import type { TestsView } from '../api.js';
import { CmdLine, CommandLine, CopyButton } from '../components/bits.js';
import { href } from '../route.js';

/** How CI runs the goldens, and how to add one: the two sections under Tests' reports. */
export function CiSections({ view }: { view: TestsView }) {
  // A gate against history needs the store kept between CI's runs.
  const historyGate = view.rows.some((r) => r.gate?.gate.kind === 'baseline');
  // An injection test runs live from each payload it plants, as a fork does: CI needs the keys for it.
  const injection = view.rows.some((r) => r.injection);
  return (
    <div className="grid2 gpanel">
      <section className="panel">
        <header>
          <h2>In CI</h2>
          <span className="sp" />
          <CopyButton text={view.commands.ci} label="the CI command" />
        </header>
        <div className="pbody">
          <p className="muted">
            Replay goldens run offline and need no key. {injection ? 'A golden marked fork runs live from where it forks, and an injection test from each payload it plants: both need the providers’ keys.' : 'A golden marked fork runs live from where it forks, and needs the providers’ keys.'} A divergence, a non-zero exit, no calls, or a check or gate that fails or can’t decide fails a golden.
          </p>
          <CommandLine command={view.commands.ci} />
          {historyGate ? (
            <p className="muted after">
              A gate against history needs the store kept between runs: the Action’s <code>keep-history</code> does it, or cache <code>.shadowlap/shadowlap.db</code>.
            </p>
          ) : null}
        </div>
      </section>
      <section className="panel">
        <header>
          <h2>Add a golden</h2>
        </header>
        <div className="pbody">
          <p className="muted">Pack a run you consider correct into the repository. Redaction rules apply to the copy.</p>
          <CmdLine>{view.commands.pack}</CmdLine>
          <p className="muted after">
            A golden whose checks say what the agent must do is also a task a model can be scored on.{' '}
            <a className="more" href={href.training('tasks')}>
              Training tasks
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
