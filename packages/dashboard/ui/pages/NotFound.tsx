import { Page } from '../components/Page.js';
import { href } from '../route.js';

export function NotFoundPage({ what = 'Nothing here.' }: { what?: string }) {
  return (
    <Page>
      <div className="empty tall">
        {what}{' '}
        <a className="more" href={href.overview()}>
          Back to the overview
        </a>
      </div>
    </Page>
  );
}
