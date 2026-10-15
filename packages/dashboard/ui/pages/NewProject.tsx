import { CmdLine, PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';

/** Add a project (#/new). Not in the dashboard yet: a dashboard serves the store of the folder it starts in. */
export function NewProjectPage() {
  return (
    <Page>
      <PageHeader eyebrow="projects" title="Add a project" text="A project is a folder with your agent’s code, and it keeps its own store." />
      <section className="panel stepempty">
        <h3>Start the dashboard in that folder</h3>
        <p>The dashboard serves the store of the folder it starts in, and its actions run there.</p>
        <CmdLine>{'cd <folder> && shadowlap dashboard'}</CmdLine>
      </section>
    </Page>
  );
}
