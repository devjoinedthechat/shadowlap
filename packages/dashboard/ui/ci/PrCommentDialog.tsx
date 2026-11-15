import { Words } from '../components/Copy.js';
import { Dialog } from '../components/Dialog.js';
import { EmptyLine, ErrorState, failedRead, Skeleton } from '../components/States.js';
import { DotLine } from '../components/Verdict.js';
import { copyText } from '../dom.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { useApp } from '../state.js';
import type { PrCommentPreview } from '../types.js';
import { DecisionSteps } from './comment-parts.js';
import { DRAWN_MARK, markTone, PREVIEW_WAIT, sessionWhen } from './words.js';

/**
 * Preview pull request comment: the one comment the Action keeps on each pull request, as GitHub
 * shows it, from the newest session that ran every golden (`GET /api/ci/comment`): the session and
 * who posts it, then the comment under the hairline they end on, with no window drawn around it.
 * Close, then Copy Markdown, which copies what the Action would post and stays open. Its words are
 * the server's (the engine's), and what only the job knows (the base branch's column, the fixes it
 * opened, the job summary's address) is left out. Settings → CI hands in the preview it read; a
 * revision's page and the palette's row leave it to the dialog, which reads it as the tests feed
 * moves. A read that fails says so as every page's does, in the server's words, with Retry.
 */

type Answer = PrCommentPreview | { session: null };

const hasSession = (a: Answer | null | undefined): a is PrCommentPreview => !!a?.session;

export function PrCommentDialog({ preview, onClose }: { preview?: Answer | null | undefined; onClose: () => void }) {
  const { client, feeds, toast } = useApp();
  const loaded = useLoad<Answer>(() => (preview ? null : client.settings.prComment()), 'pr-comment', feeds.tests ?? 0);
  const answer = preview ?? loaded.data;
  const p = hasSession(answer) ? answer : null;
  const body = p ? (
    <DrawnComment preview={p} />
  ) : answer ? (
    <EmptyLine>{PREVIEW_WAIT.why}.</EmptyLine>
  ) : loaded.error ? (
    <ErrorState retry={loaded.reload}>{failedRead(loaded.error)}</ErrorState>
  ) : (
    <Skeleton what="the comment" lines={6} />
  );
  return (
    <Dialog
      title={ACTIONS.previewPrComment.label}
      lead="The one comment the Action keeps on each pull request, edited on every push."
      doc="prComment"
      facts={p ? [{ label: 'Session', value: sessionWhen(p.session.revision, p.session.at), quiet: 'the last test session' }, { label: 'Posted by', value: p.postedBy }] : undefined}
      ok="Copy Markdown"
      tone="plain"
      local
      okDisabled={!p}
      cancel="Close"
      initialFocus="cancel"
      className="prdlg"
      onClose={onClose}
      onOk={() =>
        p
          ? copyText(p.markdown).then((ok) => {
              toast(ok ? 'Copied the comment’s Markdown' : 'Copying was refused by the browser');
              return false;
            })
          : false
      }
    >
      {body}
    </Dialog>
  );
}

/**
 * The comment as GitHub shows its Markdown: the heading with the session's tally, each golden worst
 * first with its mark, its name and its verdict line; the decisions the branch changes; a run's cost
 * before and after; each injection gate that ran, its line breaking only after a dot; and the job
 * summary's line. Its sentences are neither balanced nor set apart, as GitHub sets them. Its headings
 * sit under the dialog's title.
 */
export function DrawnComment({ preview: p }: { preview: PrCommentPreview }) {
  const d = p.decisions;
  return (
    <div className="prc">
      {/* the tally glued as the mock's is, a count with its noun */}
      <h4>
        <Words>{`shadowlap: ${p.head}`}</Words>
      </h4>
      <ul className="prc-g">
        {p.rows.map((r) => (
          <li key={r.golden} className={markTone(r.verdict)}>
            <i role="img" aria-label={r.verdict}>
              {DRAWN_MARK[r.verdict] ?? DRAWN_MARK.failed}
            </i>
            <code>{r.golden}</code>
            <span>
              <Words>{r.line}</Words>
            </span>
          </li>
        ))}
      </ul>
      {d ? (
        <>
          <h5>Decisions</h5>
          <p className="prc-dh">
            <b className={d.mark === '✗' ? 'fail' : d.mark === '!' ? 'inc' : 'pass'} aria-hidden="true">
              {d.mark}
            </b>{' '}
            {d.headline}
          </p>
          <DecisionSteps rows={d.rows} />
          {d.note ? <p className="prc-dim">{d.note}</p> : null}
        </>
      ) : null}
      {p.cost ? (
        <p className="prc-cost">
          <span>cost per run</span> {p.cost.line}
        </p>
      ) : null}
      {p.injection.length ? (
        <>
          <h5>Injection</h5>
          {p.injection.map((x) => (
            <p key={x.golden} className={`prc-i ${markTone(x.verdict)}`}>
              <i role="img" aria-label={x.verdict}>
                {DRAWN_MARK[x.verdict] ?? DRAWN_MARK.failed}
              </i>
              <code>{x.golden}</code>
              <span>
                <DotLine text={x.line} max={40} />
              </span>
            </p>
          ))}
        </>
      ) : null}
      <p className="prc-foot">{p.foot}</p>
    </div>
  );
}
