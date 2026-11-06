import { PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { href } from '../route.js';

/**
 * What a page with nothing at it shows: what was missing and the way back (`back`, its address and
 * words), to the list that holds its kind or to the overview. With `header` it has the page's header
 * too, as an exported copy's run it doesn't hold has: `not found`, Nothing here, then the line.
 */
export function NotFoundPage({ what = 'Nothing here.', back = [href.overview(), 'Back to the overview'], header = false }: { what?: string; back?: readonly [string, string]; header?: boolean }) {
  const link = (
    <a className="more" href={back[0]}>
      {back[1]}
    </a>
  );
  if (header)
    return (
      <Page>
        <PageHeader
          eyebrow="not found"
          title="Nothing here"
          text={
            <>
              {what} {link}
            </>
          }
        />
      </Page>
    );
  return (
    <Page>
      <div className="empty tall">
        {what} {link}
      </div>
    </Page>
  );
}
