import { CmdLine, PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/** Tests (#/tests): goldens and how they did. Not in the dashboard yet; the page says how to run them. */
export function TestsPage() {
  const { meta } = useApp();
  return (
    <Page>
      <PageHeader eyebrow={projectOf(meta)?.name ?? 'tests'} title="Tests" text="Goldens are runs packed into the repository and replayed offline on every commit, so a change to what the agent sends fails the build." />
      <section className="panel stepempty">
        <h3>Tests run in the terminal for now</h3>
        <p>Replay every golden offline; each one that diverges or fails a check is reported.</p>
        <CmdLine>shadowlap test goldens/*</CmdLine>
      </section>
    </Page>
  );
}
