// Types for no-stray-stores.mjs, which the framework tests run under Node as it is.

/** What a folder holds: its entries, itself as `.`, as `path -> mtime:size`; null when it isn't there. */
export type Listing = Map<string, string> | null;

/** The folders watched: a .shadowlap in each place a suite runs from. */
export const WATCHED: readonly string[];
/** What each of `dirs` holds now. */
export function snapshot(dirs?: readonly string[]): Map<string, Listing>;
/** What appeared or changed in the folders of `before` since, by path. */
export function strays(before: Map<string, Listing>, after?: Map<string, Listing>): string[];
/** Why the run fails, naming what the tests left. */
export function straysMessage(found: readonly string[]): string;
/** The check around a run of tests in `dirs`: a warning for each already there, and the teardown that fails on what the tests left. */
export function check(dirs?: readonly string[], warn?: (line: string) => void): () => void;
/** Vitest's global setup: the check around the whole run. */
export default function setup(): () => void;
