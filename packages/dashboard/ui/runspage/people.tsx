import { tipText } from '../components/HoverCard.js';
import { personName } from '../overview/model.js';
import { authorTint, ciName } from './authors.js';

/**
 * Who made a run, as the By column, the calendar and the activity feed show it: an email by its name
 * part (decision: SHADOWLAP_AUTHOR, else `ci` in CI, else git's user.email, else the OS user), CI as
 * its own author, with the CI provider when the run says which.
 */

export function Avatar({ author }: { author: string | null }) {
  const name = personName(author);
  const tint = authorTint(author);
  return (
    <span className={`av ${tint}`} aria-hidden="true">
      {tint === 'bot' ? (author === 'ci' ? 'CI' : '?') : name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Who made a run in words: the name (with "you" for whoever this machine records as), and for CI its
 * provider when the run says which: `maya (you)`, `ci · GitHub Actions`.
 */
export function authorWords(author: string | null, o: { ci?: string | null | undefined; you?: boolean } = {}): string {
  if (!author) return 'who made this run is not recorded';
  const provider = author === 'ci' ? ciName(o.ci) : null;
  return `${personName(author)}${o.you ? ' (you)' : ''}${provider ? ` · ${provider}` : ''}`;
}

/**
 * Runs' By column, as the design's byCell draws it: who made the run as their avatar, 20px as in the
 * top bar, the name on hover, so the column takes an avatar's width and every row keeps one line.
 */
export function ByAvatar({ author, ci, you = false }: { author: string | null; ci?: string | null; you?: boolean }) {
  const words = authorWords(author, { ci, you });
  return (
    <span className="byav" role="img" aria-label={words} data-tip={tipText(words)}>
      <Avatar author={author} />
    </span>
  );
}
