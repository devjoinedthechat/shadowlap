import { personName } from '../overview/model.js';

/**
 * Who made a run, as the By column, the calendar and the activity feed show it: an email by its name
 * part (decision: SHADOWLAP_AUTHOR, else `ci` in CI, else git's user.email, else the OS user), CI as
 * its own author, with the CI provider when the run says which.
 */

const TINTS = ['t1', 't2', 't3', 't4'] as const;

/** The same person always gets the same tint. */
export function authorTint(author: string | null): string {
  if (!author) return 'bot';
  if (author === 'ci') return 'bot';
  let h = 0;
  for (const ch of author) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

/** The provider's name for "ci (GitHub Actions)". */
export const CI_NAMES: Readonly<Record<string, string>> = { github: 'GitHub Actions', gitlab: 'GitLab CI', buildkite: 'Buildkite', circleci: 'CircleCI', azure: 'Azure Pipelines', bitbucket: 'Bitbucket Pipelines', jenkins: 'Jenkins', travis: 'Travis CI' };

export function ciName(ci: string | null | undefined): string | null {
  if (!ci) return null;
  return CI_NAMES[ci] ?? ci;
}

export function Avatar({ author }: { author: string | null }) {
  const name = personName(author);
  const tint = authorTint(author);
  return (
    <span className={`av ${tint}`} aria-hidden="true">
      {tint === 'bot' ? (author === 'ci' ? 'CI' : '?') : name.charAt(0).toUpperCase()}
    </span>
  );
}

/** A person in a table cell: the avatar and the name, and what kind of author when it is CI. */
export function Person({ author, ci }: { author: string | null; ci?: string | null }) {
  const provider = author === 'ci' ? ciName(ci) : null;
  return (
    <span className="person" title={author ?? 'who made this run is not recorded'}>
      <Avatar author={author} />
      <span className="pn">
        <span className="nm">{personName(author)}</span>
        {provider ? <small>{provider}</small> : null}
      </span>
    </span>
  );
}
