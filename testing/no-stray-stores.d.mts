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
/** Whether a path git lists (from the root, with / between parts) is a build output, a test report or the system's own file. */
export function isOutput(path: string): boolean;
/** The checkout as git sees it, as `path -> XY`, outputs left out; null where `root` is no git checkout. */
export function checkoutStatus(root?: string): Map<string, string> | null;
/** What is new in the checkout since `before`: what appeared, untracked or ignored, and the tracked files whose state changed. */
export function leftInCheckout(before: Map<string, string>, after: Map<string, string>): { left: string[]; changed: string[] };
/** Why the run fails, naming what appeared in the checkout. */
export function checkoutMessage(left: readonly string[]): string;
/** What is said, or under CI failed on, when a tracked file changed during the run. */
export function changedMessage(changed: readonly string[]): string;
/** What the check covers besides the folders: the checkout at `root` (null: not at all), and whether a tracked file changed fails it. */
export interface CheckOptions {
  root?: string | null;
  strict?: boolean;
}
/** The check around a run of tests: warnings for what is there already, and the teardown that fails on what the tests left. */
export function check(dirs?: readonly string[], warn?: (line: string) => void, options?: CheckOptions): () => void;
/** What the check around a Vitest run covers, given the project Vitest runs: the checkout too, but in watch mode. */
export function setupOptions(project?: { config?: { watch?: boolean } }): CheckOptions;
/** Vitest's global setup (its argument is the project Vitest runs): the check around the whole run. */
export default function setup(project?: { config?: { watch?: boolean } }): () => void;
