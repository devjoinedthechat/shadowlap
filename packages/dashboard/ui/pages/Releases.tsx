import { PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';

/** Releases (#/releases[/<id>]): a placeholder page. */
export function ReleasesPage({ id }: { id: string | null }) {
  return (
    <Page>
      <PageHeader eyebrow="releases" title={id ? `Release ${id}` : 'Releases'} text="One signed report per release: the revision, the goldens checked, the fixes included, and its signature." />
      <section className="panel stepempty">
        <h3>No releases here</h3>
        <p>This dashboard has no release reports.</p>
      </section>
    </Page>
  );
}
