import type { ComponentType } from 'react';
import type { JobView } from './types.js';

/**
 * What a feature adds to the job drawer's footer for its own kind of job: a button that acts on what
 * the job found, such as calibrate's "Add it (--write)" or a clean-up's "Delete N runs". The drawer
 * renders the component registered for the job's kind beside its Close button and links, with the
 * job as it is now; the component decides when it shows (usually once the job is done).
 */

export type JobFooter = ComponentType<{ job: JobView }>;

const footers = new Map<string, JobFooter>();

/** Registers the footer for a job kind, once, when the feature's module loads. */
export function addJobFooter(kind: string, footer: JobFooter): void {
  footers.set(kind, footer);
}

/** The footer registered for a job's kind, if any. */
export function jobFooter(kind: string | undefined): JobFooter | null {
  return (kind && footers.get(kind)) || null;
}
