// Types for temp-project.mjs, which the framework tests run under Node as it is.

/** The repository's own node_modules. */
export const REPO_MODULES: string;
/**
 * A new, empty project folder under the system's temporary folder, below links to `modules` (nearest
 * first; one that isn't there is left out). Its path is a real one, as a command run in it sees it.
 */
export function tempProject(prefix: string, modules?: readonly string[]): string;
/** Removes a project `tempProject` made, with the links above it (never what they link to). */
export function removeTempProject(project: string): void;
