// Types for home-guard.mjs, which each test file's setup (file-home.mjs) installs.

/** The home folders of the user the tests run as: HOME (USERPROFILE on Windows) as this process found it, and the system's record of it. */
export function realHomes(): string[];
/** A path as the file system finds it: absolute, and each link on the way followed, as far as the path exists. */
export function canonical(path: string): string;
/** The real home's Shadowlap folders, `homes`' .shadowlap, as the file system finds them. */
export function realShadowlapFolders(homes?: readonly string[]): string[];
/** Shadowlap's folder for this machine's files in `env`, with `home` the home folder, as the engine finds it; `named` says whether SHADOWLAP_HOME named it. */
export function shadowlapHomeIn(env: NodeJS.ProcessEnv, home: string): { dir: string; named: boolean };
/** Why a write to `path` is refused: in one of the `real` home's Shadowlap folders, or in the home `env` names while SHADOWLAP_HOME is unset or ignored. Null when it may go ahead. */
export function writeProblem(path: string, options?: { env?: NodeJS.ProcessEnv; home?: string; real?: readonly string[] }): string | null;
/** Why a process `command` with environment `env` is refused: Shadowlap in it would keep this machine's files in one of the `real` home's Shadowlap folders. Null when they would go elsewhere. */
export function childProblem(env: NodeJS.ProcessEnv, options?: { command?: string; real?: readonly string[]; platform?: NodeJS.Platform }): string | null;
/** What was refused since this was last called, oldest first: each is said once. */
export function takeRefused(): string[];
/** Installs the guard in this process, once: Node's calls that change a file, and those that start a process, refuse what would reach the real home's Shadowlap files. */
export function guardHome(): void;
