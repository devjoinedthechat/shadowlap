import type { AttemptGroup, FixAttemptGroups } from '../../src/attempt-groups.js';
import { Badge } from '../components/bits.js';
import { plural, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { useOfflineLink } from '../components/ActionButton.js';

/**
 * A gate's attempts grouped by what each did, on a fix's Blame and Verify steps: the tool calls each
 * made from where it left the run, a call that didn't plainly run marked (`issue_refund (blocked)`),
 * and how it came out, with how many took that path and one of them to open. So the failing attempts
 * show how they differ from the passing ones. Read apart from the fix (`/api/fixes/:id/groups`):
 * the step shows at once, and the groups when they arrive.
 */

/** The groups of a fix's attempts, read again when fixes or runs move. */
export function useAttemptGroups(fixId: string): FixAttemptGroups | null {
  const { client, tick, feeds, exported } = useApp();
  return useLoad(() => (exported ? null : client.attemptGroups(fixId)), `groups:${fixId}`, `${tick}:${feeds.fixes ?? 0}`).data ?? null;
}

const VERDICT: Record<AttemptGroup['verdict'], { tone: 'ok' | 'no' | 'y'; word: string }> = { passed: { tone: 'ok', word: 'passed' }, failed: { tone: 'no', word: 'failed' }, inconclusive: { tone: 'y', word: 'not judged' } };

/**
 * One probe's or one run's attempts, a line per group: how many, what they did, how they came out,
 * why, and one to open. Of more attempts than the server reads, the first it read (`read`), which the
 * heading says.
 */
export function AttemptGroups({ groups, attempts, read = attempts, label }: { groups: readonly AttemptGroup[]; attempts: number; read?: number; label: string }) {
  const attemptLink = useOfflineLink();
  // One path for all of them says nothing a list of attempts doesn't.
  if (groups.length < 2) return null;
  return (
    <div className="agroups">
      <span className="k">{read < attempts ? `what the first ${read} of ${plural(attempts, 'attempt')} did` : `what ${plural(attempts, 'attempt')} did`}</span>
      <ul aria-label={`What ${label}’s attempts did`}>
        {groups.map((g) => (
          // Spaces between the parts, so the line reads and copies as words, not only as a layout.
          <li key={`${g.verdict}:${g.path.join('\u0000')}`} className={g.verdict}>
            <b className="ac">{g.count}×</b> <span className="ap">{g.path.length ? g.path.join(' → ') : 'no tool call'}</span> <Badge tone={VERDICT[g.verdict].tone}>{VERDICT[g.verdict].word}</Badge>
            {g.why ? (
              <>
                {' '}
                <span className="aw">{g.why}</span>
              </>
            ) : null}{' '}
            <a className="ax" href={g.example.href} title={`Open one of them: ${g.example.runId}`} onClick={attemptLink}>
              <code>{shortId(g.example.runId)}</code> →
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
