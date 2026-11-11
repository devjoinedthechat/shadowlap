import { ApiError, type TestsView } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { EmptyState, ErrorState, Skeleton } from '../components/States.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { usePendingHidden } from '../pending-delete.js';
import { PackAsGolden } from '../run/PackAsGolden.js';
import { packRunCommand } from '../run/share.js';
import { useApp } from '../state.js';
import type { NextStepRow, RunListItem } from '../types.js';

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
 * No golden yet: what the page will hold and the step that gets there, Pack <id> as golden… for the
 * newest run whose listed step is to pack it, with its command for a terminal under it; with none,
 * the command that packs one. The command names a run, so a project with no run yet is offered
 * none: recording one comes first.
 */
export function TestsEmpty({ view, runs }: { view: Pick<TestsView, 'commands'>; runs: readonly RunListItem[] | null }) {
  const hidden = usePendingHidden();
  const run = runs ? newestToPack(runs, hidden) : null;
  const own = run ? (run.next.command ?? packRunCommand(run.runId, run.next.folder)) : null;
  // The project's runs not yet listed: the command, as it may well have one.
  const command = own ?? (runs?.length !== 0 ? view.commands.pack : undefined);
  return <EmptyState title="No goldens yet" text="Pack a run you consider correct into the repository, and CI replays it offline on every commit." step={run && own ? <PackRun run={run} command={own} /> : undefined} command={command} />;
}

type ToPack = RunListItem & { next: NextStepRow & { folder: string } };

/** The newest run the server says to pack as a golden (its listed step `pack`), none of them being deleted. */
function newestToPack(runs: readonly RunListItem[], hidden: ReadonlySet<string>): ToPack | null {
  const packable = runs.filter((r): r is ToPack => r.next?.key === 'pack' && !!r.next.folder && !hidden.has(r.runId));
  return packable.reduce<ToPack | null>((a, r) => (a && a.startedAt >= r.startedAt ? a : r), null);
}

/** Pack <id> as golden…, lime: its page's dialog, with the run's redaction rules as its page says them. */
function PackRun({ run, command }: { run: ToPack; command: string }) {
  const { client } = useApp();
  const offers = useLoad(() => client.offers(run.runId), `tests-pack-rules:${run.runId}`).data ?? null;
  const id = shortId(run.runId);
  return <PackAsGolden runId={run.runId} folder={run.next.folder} offers={offers} lead tip={tipCard(`Pack ${id} as golden`, [], run.about?.text ?? null, `$ ${command}`)} label={`Pack ${id} as golden…`} />;
}
