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

/** A person in a table cell: the avatar and the name (with "you" for whoever this machine records as), and what kind of author when it is CI. */
export function Person({ author, ci, you = false }: { author: string | null; ci?: string | null; you?: boolean }) {
  const provider = author === 'ci' ? ciName(ci) : null;
  return (
    <span className="person" title={author ?? 'who made this run is not recorded'}>
      <Avatar author={author} />
      <span className="pn">
        <span className="nm">
          {personName(author)}
          {you ? <em>you</em> : null}
        </span>
        {provider ? <small>{provider}</small> : null}
      </span>
    </span>
  );
}
