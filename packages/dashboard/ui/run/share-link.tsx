import { JOB_KINDS } from '../api.js';
import { copyText } from '../dom.js';
import { addJobFooter } from '../job-actions.js';
import { useApp } from '../state.js';
import type { JobView } from '../types.js';
import { sharedLink } from './share.js';

/**
 * A share job's drawer ends on the link it made: **Copy link**, with when it expires on hover. The
 * link is a presigned URL in the team's bucket, so it is copied rather than opened from the drawer,
 * whose links only open pages of the dashboard. Registered when the app loads, as Settings' are.
 */
function ShareLinkFooter({ job }: { job: JobView }) {
  const { toast } = useApp();
  const link = sharedLink(job);
  if (!link) return null;
  const until = link.expiresAt ? new Date(link.expiresAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return (
    <button className="btn lime" type="button" title={until ? `Anyone with the link can open the report until ${until}` : 'Anyone with the link can open the report'} onClick={() => void copyText(link.url).then((ok) => toast(ok ? `Copied the share link${until ? ` · it works until ${until}` : ''}` : 'Copying was refused by the browser'))}>
      Copy link
    </button>
  );
}

addJobFooter(JOB_KINDS.share, ShareLinkFooter);
