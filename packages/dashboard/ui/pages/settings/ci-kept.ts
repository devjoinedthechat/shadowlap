import type { CiWorkflowOptions } from '../../types.js';

/**
 * What Settings → CI's switches were changed to and not yet written, by project, kept while the
 * dashboard is open; what isn't changed is the repository's workflow's. Each project's workflow is
 * its own file, so a change made in one project never carries over to another. Settings → Store's
 * Push from CI reads it too, to say whether Your workflow, as the switches have it, now equals the
 * repository's.
 */
const kept = new Map<string, Partial<CiWorkflowOptions>>();

/** The project's changes (`meta.project.id`; none for a dashboard of one store): its own object, which the CI tab changes in place. */
export function keptFor(project: string | null | undefined): Partial<CiWorkflowOptions> {
  const id = project ?? '';
  let o = kept.get(id);
  if (!o) kept.set(id, (o = {}));
  return o;
}

/** A switch's toast after its first half, once the answer for it says whether the file the switches build now equals the repository's. */
export const AGAIN = 'Your workflow is your repository’s again';
export const CHANGES = 'Your workflow changes with it';
