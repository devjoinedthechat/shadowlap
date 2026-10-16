/**
 * Who made a run, in the words and colours the Runs page uses: the same person always gets the same
 * tint, CI is its own author and is named by its provider when the run says which. No DOM here: the
 * tests import it.
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
