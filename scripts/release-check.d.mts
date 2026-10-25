// Types for release-check.mjs, which the release workflow runs under Node as it is.

/** The section of a changelog for `version`: its heading and what follows, without link references; null when it has none, or an empty one. */
export function changelogSection(text: string, version: string): string | null;
/** Each way the repository at `root` disagrees with a release of `version`. */
export function releaseProblems(root: string, version: string): string[];
