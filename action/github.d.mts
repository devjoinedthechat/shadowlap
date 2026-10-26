// Types for github.mjs, which the action runs as plain JavaScript.

/** The token the action speaks to GitHub with, where it came from, and whether GitHub starts workflows for what it does with it. */
export interface GitHubAuth {
  token: string | null;
  source: 'input' | 'gh-token' | 'github-token' | 'none';
  startsWorkflows: boolean;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export function githubToken(env: NodeJS.ProcessEnv): GitHubAuth;
export function tokenEnv(env: NodeJS.ProcessEnv, auth: GitHubAuth): NodeJS.ProcessEnv;
/** The variables a job holds GitHub's tokens in, which the CLI and the agent never get. */
export const TOKEN_VARIABLES: readonly string[];
export function withoutTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function repositoryOf(env: NodeJS.ProcessEnv): { api: string; repo: string | null };
export function workflowFile(env: NodeJS.ProcessEnv): string | null;

/** Whether the workflow was started on a fix's branch, and why not. */
export interface Dispatch {
  dispatched: boolean;
  workflow: string | null;
  why: string | null;
}
export function dispatchWorkflow(o: { env: NodeJS.ProcessEnv; auth: GitHubAuth; branch: string; fetch?: Fetch }): Promise<Dispatch>;

export interface PullRequest {
  number: number;
  baseRef: string | null;
  baseSha: string | null;
}
export function pullRequestOf(env: NodeJS.ProcessEnv, read?: (path: string) => string): PullRequest | null;

/** How keeping the comment went: `updated`, `created`, `denied` (the token may not comment) or `failed`; `skipped` and `none` come from postComment. */
export interface Posted {
  state: 'updated' | 'created' | 'denied' | 'failed' | 'skipped' | 'none';
  url: string | null;
  why: string | null;
}
export function upsertComment(o: { env: NodeJS.ProcessEnv; auth: GitHubAuth; number: number; marker: string; body: string; fetch?: Fetch }): Promise<Posted>;
