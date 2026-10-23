// Types for github.mjs, which the action runs as plain JavaScript.

/** The token the action speaks to GitHub with, where it came from, and whether GitHub starts workflows for what it does with it. */
export interface GitHubAuth {
  token: string | null;
  source: 'input' | 'gh-token' | 'github-token' | 'none';
  startsWorkflows: boolean;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export function githubToken(env: NodeJS.ProcessEnv): GitHubAuth;
export function tokenEnv(env: NodeJS.ProcessEnv, auth: GitHubAuth): NodeJS.ProcessEnv;
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
