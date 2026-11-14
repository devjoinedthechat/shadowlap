import type { TestsView } from '../api.js';
import { CodeBox } from '../components/CodeBox.js';
import { Code, Copy } from '../components/Copy.js';
import { Link } from '../components/Link.js';
import { Section } from '../components/Section.js';
import { href } from '../route.js';

/**
 * What runs live in CI, by what the goldens are: those marked fork, counted, and an injection test's
 * payloads, with the keys they need; then that replay goldens need none, which is all there is to say
 * where nothing runs live.
 */
function keyWords(view: Pick<TestsView, 'rows'>): string {
  const forks = view.rows.filter((r) => r.mode === 'fork').length;
  // An injection test runs live from each payload it plants, as a fork does: CI needs the keys for it.
  const injection = view.rows.some((r) => r.injection);
  const offline = 'Replay goldens run offline and need no key.';
  if (!forks && !injection) return offline;
  if (!forks) return `An injection test runs live from each payload it plants and needs the providers’ keys. ${offline}`;
  const fork = forks > 1 ? `${forks} goldens marked fork run live from where they fork` : 'A golden marked fork runs live from where it forks';
  return `${injection ? `${fork}, and an injection test from each payload it plants: both need` : `${fork} and need${forks > 1 ? '' : 's'}`} the providers’ keys. ${offline}`;
}

/**
 * How CI runs the goldens, and how to add one: the two sections under Tests' reports, each command in
 * its box with its own Copy, and under both, quiet, where the recordings other test runners keep run.
 * In CI leads with its command, then says what a run there needs and how it judges, a label and its
 * line each: three rules in one paragraph read as none.
 */
export function CiSections({ view }: { view: TestsView }) {
  // A gate against history needs the store kept between CI's runs.
  const historyGate = view.rows.some((r) => r.gate?.gate.kind === 'baseline');
  return (
    <>
      <div className="grid2 secs">
        <Section title="In CI">
          <CodeBox command={view.commands.ci} what="the CI command" />
          <dl className="tci">
            <div>
              <dt>Keys</dt>
              <Copy as="dd" phrases>
                {keyWords(view)}
              </Copy>
            </div>
            {historyGate ? (
              <div>
                <dt>Store</dt>
                <Copy as="dd" phrases>
                  A gate against history needs the store kept between runs: the Action’s <Code>keep-history</Code> does it, or cache <Code>.shadowlap/shadowlap.db</Code>.
                </Copy>
              </div>
            ) : null}
            <div>
              <dt>Fails a golden</dt>
              <Copy as="dd" phrases>
                A divergence, a non-zero exit, no calls, or a check, gate or injection test that fails or can’t decide.
              </Copy>
            </div>
            <div>
              <dt>Only warns</dt>
              <Copy as="dd" phrases>
                A gate against history with fewer than 30 sessions, when it runs out of attempts, until the plan reads a decline or a drop.
              </Copy>
            </div>
          </dl>
          <Copy className="muted after">
            On GitHub, <Link href="#/settings/ci">Settings → CI</Link> builds the whole workflow, with the pull request comment, Fix on failure and alerts.
          </Copy>
        </Section>
        <Section title="Add a golden">
          <Copy className="muted">Pack a run you consider correct into the repository. Redaction rules apply to the copy.</Copy>
          <CodeBox command={view.commands.pack} what="the pack command" />
          <Copy className="muted after">
            A golden whose checks say what the agent must do is also a task a model can be scored on.{' '}
            <Link href={href.training('tasks')} to>
              Training tasks
            </Link>
          </Copy>
        </Section>
      </div>
      <Copy className="muted tfoot">{view.note}</Copy>
    </>
  );
}
