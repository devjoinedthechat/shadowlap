import type { ComponentType } from 'react';
import type { JobView } from './types.js';

/**
 * What a feature adds to the job drawer's way on for its own kind of job: a button that acts on what
 * the job found, such as calibrate's "Add normalizer" or a clean-up's "Delete N runs". The drawer
 * renders the component registered for the job's kind in its header line, beside its links, with the
 * job as it is now; the component decides when it shows (usually once the job is done). `plain`: the
 * page leads with a lime step of its own, so this reads plain. `done`: what it did needed no job of
 * its own and is over, so the drawer closes.
 */

export type JobFooter = ComponentType<{ job: JobView; plain?: boolean; done?: () => void }>;

const footers = new Map<string, JobFooter>();

/** Registers the footer for a job kind, once, when the feature's module loads. */
export function addJobFooter(kind: string, footer: JobFooter): void {
  footers.set(kind, footer);
}

/** The footer registered for a job's kind, if any. */
export function jobFooter(kind: string | undefined): JobFooter | null {
  return (kind && footers.get(kind)) || null;
}
