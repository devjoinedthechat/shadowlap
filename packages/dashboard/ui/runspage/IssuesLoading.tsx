import { Skeleton } from '../components/States.js';

/** What the issues' rows are drawn as while they load: an issue's title, as long as one runs. */
const SKEL_ISSUES = ['check refund-in-limit failed', 'HTTP 529 at the first model call', 'send_email blocked after the fork', 'The turn ended with no answer', 'check answer-names-order failed'];

/**
 * Failed's issues while they load, or while the view's own script comes (pages/served.tsx): rows in
 * the issues table's columns as quiet bars, each an issue's title and the line under it, its runs,
 * when it was first and last seen, and its fix. They are no table rows, which the tests read as the
 * issues drawn (`table.issues tbody tr`), as the runs' bars are none (RunsTable.tsx).
 */
export function IssuesLoading() {
  return (
    <Skeleton what="the issues">
      {SKEL_ISSUES.map((title, i) => (
        <div className="iskrow" key={i}>
          <span>
            {title}
            <span className="iskl">golden refund · 3 runs since Oct 1</span>
          </span>
          <span>12</span>
          <span>Oct 1</span>
          <span>2h ago</span>
          <span>Run blame</span>
        </div>
      ))}
    </Skeleton>
  );
}
