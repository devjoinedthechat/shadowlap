import type { TestsView } from '../api.js';
import { CodeBox } from '../components/CodeBox.js';
import { Link } from '../components/Link.js';
import { Section } from '../components/Section.js';
import { href } from '../route.js';

/** What runs live in CI, by what the goldens are: those marked fork, counted, and an injection test's payloads; the first clause alone where nothing does. */
function liveWords(view: Pick<TestsView, 'rows'>): string {
  const forks = view.rows.filter((r) => r.mode === 'fork').length;
  // An injection test runs live from each payload it plants, as a fork does: CI needs the keys for it.
  const injection = view.rows.some((r) => r.injection);
  const fork = forks > 1 ? `${forks} goldens marked fork run live from where they fork` : 'a golden marked fork runs live from where it forks';
  if (!forks && !injection) return 'Replay goldens run offline and need no key.';
  if (!forks) return 'Replay goldens run offline and need no key; an injection test runs live from each payload it plants and needs the providers’ keys.';
  return `Replay goldens run offline and need no key; ${injection ? `${fork}, and an injection test from each payload it plants: both need` : `${fork} and need${forks > 1 ? '' : 's'}`} the providers’ keys.`;
}

/**
 * How CI runs the goldens, and how to add one: the two sections under Tests' reports, each command in
 * its box with its own Copy, and under both, quiet, where the recordings other test runners keep run.
 */
export function CiSections({ view }: { view: TestsView }) {
  // A gate against history needs the store kept between CI's runs, and warns on a short history.
  const historyGate = view.rows.some((r) => r.gate?.gate.kind === 'baseline');
  return (
    <>
      <div className="grid2 secs">
        <Section title="In CI">
          <p className="muted">{liveWords(view)} A divergence, a non-zero exit, no calls, or a check, gate or injection test that fails or can’t decide fails a golden.</p>
          <CodeBox command={view.commands.ci} what="the CI command" />
          {historyGate ? (
            <p className="muted after">
              A gate against history with fewer than 30 sessions only warns when it runs out of attempts, until the plan reads a decline or a drop. It needs the store kept between runs: the Action’s <code>keep-history</code> does it, or cache <code>.shadowlap/shadowlap.db</code>.
            </p>
          ) : null}
          <p className="muted after">
            On GitHub, <Link href="#/settings/ci">Settings → CI</Link> builds the whole workflow.
          </p>
        </Section>
        <Section title="Add a golden">
          <p className="muted">Pack a run you consider correct into the repository. Redaction rules apply to the copy.</p>
          <CodeBox command={view.commands.pack} what="the pack command" />
          <p className="muted after">
            A golden whose checks say what the agent must do is also a task a model can be scored on.{' '}
            <Link href={href.training('tasks')} to>
              Training tasks
            </Link>
          </p>
        </Section>
      </div>
      <p className="muted tfoot">{view.note}</p>
    </>
  );
}
