import { ApiError, type TestsView } from '../api.js';
import { EmptyState, ErrorState, Skeleton } from '../components/States.js';
import { VerdictLine } from '../components/VerdictLine.js';

/**
 * Tests' states besides the goldens: loading drawn in the page's final layout as quiet bars, a read
 * that failed as one line in the error tone with Retry, and no golden yet with what gets there.
 */

/** Loading: the verdict and a table of three goldens in their final shape, as bars; a screen reader hears it once. */
export function TestsLoading() {
  return (
    <Skeleton what="the goldens">
      <VerdictLine className="tv" word="passed" tone="mu" facts="test session · when">
        7 of 7 goldens passed
      </VerdictLine>
      <section className="panel sec gtw">
        <table className="t gt">
          <tbody>
            {[0, 1, 2].map((i) => (
              <tr key={i}>
                <td className="gg">
                  <code className="gn">a-golden-name</code>
                  <span className="gmeta">
                    <span className="chip">replay</span>
                  </span>
                </td>
                <td className="chk gck">a check on the run</td>
                <td className="glast">
                  <span className="st mu">
                    <i />
                    passed
                  </span>
                  <span className="rsub">replayed without a divergence</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Skeleton>
  );
}

/** A read that failed: the server's status where it answered, else what went wrong, and Retry. */
export function TestsFailed({ error, retry }: { error: Error; retry: () => void }) {
  return <ErrorState retry={retry}>{error instanceof ApiError ? `The dashboard server answered ${error.status} for this page’s data.` : error.message}</ErrorState>;
}

/**
 * No golden yet: what the page will hold and the command that packs one. The command names a run,
 * so a project with no run yet is offered none: recording one comes first.
 */
export function TestsEmpty({ view, runs }: { view: Pick<TestsView, 'commands'>; runs: readonly unknown[] | null }) {
  // The project's runs not yet listed: the command, as it may well have one.
  return <EmptyState title="No goldens yet" text="Pack a run you consider correct into the repository, and CI replays it offline on every commit." command={runs?.length !== 0 ? view.commands.pack : undefined} />;
}
