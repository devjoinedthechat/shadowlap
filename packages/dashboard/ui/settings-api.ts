import type {
  CodingAgentsSettings,
  MatchingSettings,
  ProjectSettings,
  RedactionPreviewView,
  RedactionSettings,
  RuleRow,
  StoreSettings,
  ToolsSettings,
} from '../src/settings.js';

/**
 * Settings' part of the API client (`client.settings`): each tab's read, and the edits to
 * shadowlap.config.json. Every edit sends the version of the file the tab read (`config.version`),
 * so the server refuses it with a 409 when the file changed on disk since. Types only from the
 * server's read model (`src/settings.ts`): nothing here needs Node.
 */

export type { CodingAgentsSettings, MatchingSettings, ProjectSettings, RedactionPreviewView, RedactionSettings, RuleRow, StoreSettings, ToolsSettings };

export type RuleListName = 'normalize' | 'redact';

/** A rule as the Add dialog sends it: blank fields are left out, as the CLI leaves out a flag not given. */
export interface RuleInput {
  kind?: string;
  name?: string;
  path?: string;
  pattern?: string;
  replace?: string;
}

/** What "Add a server…" shows for a command or a URL: the line, the client entry, and whether a credential was hidden. */
export interface McpLine {
  transport: 'stdio' | 'http';
  target: string;
  line: string;
  entry: { command: string; args: string[] };
  hidden: boolean;
  /** The entry as typed, credentials included: what Copy the entry copies. */
  copy?: { command: string; args: string[] };
}

/** What the CI tab's two panels are set to, as `GET /api/ci/workflows` takes them. */
export interface CiOptions {
  /** Fix on failure is on. */
  fix: boolean;
  /** Dollars per failing golden: `2.00`. */
  budget: string;
  /** As `repair --repairer` takes it: `claude-code`, `anthropic`, `openai:gpt-5`. */
  repairer: string;
  /** Alerts post only for the main branch. */
  onlyMain: boolean;
  /** The repository secret that holds the Slack webhook URL. */
  secret: string;
}

/** A row of an "it needs" or "it never" list, or a failure with its tag. */
export interface CiListRow {
  label: string;
  value: string;
}

/** The pull request Fix on failure opens, as GitHub shows it: from the newest fix verified here, or an example. */
export interface CiPullRequest {
  title: string;
  author: string;
  base: string;
  branch: string;
  verify: string | null;
  blame: string | null;
  change: string | null;
  /** `≈$0.84 of $2.00`. */
  spent: string;
  fixId: string | null;
  example: boolean;
}

/**
 * Settings → CI as the tests feature serves it (`GET /api/ci/workflows`, its `CiWorkflowsView`):
 * both panels' workflow steps, what each needs, and what lands, for the options given.
 */
export interface CiWorkflowsView {
  /** Where the steps go: `.github/workflows/agent.yml`. */
  file: string;
  action: string;
  fixOnFailure: {
    on: boolean;
    budget: string;
    repairer: string;
    budgets: Array<{ value: string; label: string }>;
    repairers: Array<{ value: string; label: string }>;
    offNote: string;
    yaml: string;
    needs: CiListRow[];
    never: CiListRow[];
    preview: CiPullRequest;
  };
  alerts: {
    onlyMain: boolean;
    secret: string;
    yaml: string;
    needs: CiListRow[];
    failures: CiListRow[];
    /** The message as Slack shows it; `at` is when the tests last ran. */
    message: { app: string; text: string; link: string; at: number | null };
  };
  recordings: string;
  repository: string | null;
}

export interface SettingsApi {
  matching(): Promise<MatchingSettings>;
  redaction(runId?: string | null): Promise<RedactionSettings>;
  /** What the redaction rules would mask in one run, path rules included; `signal` stops waiting, and the server stops reading. */
  preview(runId: string, signal?: AbortSignal): Promise<RedactionPreviewView>;
  agents(): Promise<CodingAgentsSettings>;
  tools(): Promise<ToolsSettings>;
  mcpLine(input: { command?: string; url?: string }): Promise<McpLine>;
  project(): Promise<ProjectSettings>;
  store(): Promise<StoreSettings>;
  /** The CI tab's panels from the tests feature's endpoint; null when this server doesn't have it (the tab writes them itself). */
  ciWorkflows(options: CiOptions): Promise<CiWorkflowsView | null>;
  addRule(list: RuleListName, rule: RuleInput, expect: string): Promise<{ n: number; added: boolean; version: string }>;
  removeRule(list: RuleListName, n: number, expect: string): Promise<{ n: number; version: string }>;
  setClock(mode: 'auto' | 'exact', expect: string): Promise<{ clock: string; changed: boolean; version: string }>;
  setCiPush(on: boolean, expect: string): Promise<{ ciPush: boolean; changed: boolean; version: string }>;
  /** "Add it (--write)": the normalizers a finished calibrate job proposed, read from its result on the server. */
  writeCalibration(jobId: string): Promise<{ added: number[]; already: number[]; version: string }>;
}

/** The client's request function, as `createClient` has it. */
export type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** A server without the endpoint asked for (an older one, or one built before the feature that serves it). */
function noEndpoint(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  return !!e && (e.status === 404 || e.status === 405) && /^no endpoint/.test(e.message ?? '');
}

export function settingsApi(request: Request): SettingsApi {
  const q = encodeURIComponent;
  const send = <T,>(method: string, path: string, body: unknown) => request<T>(path, { method, body: JSON.stringify(body) });
  return {
    matching: () => request('settings/matching'),
    redaction: (runId) => request(`settings/redaction${runId ? `?run=${q(runId)}` : ''}`),
    preview: (runId, signal) => request(`settings/redaction/preview?run=${q(runId)}`, signal ? { signal } : {}),
    agents: () => request('settings/agents'),
    tools: () => request('settings/tools'),
    mcpLine: (input) => request(`settings/tools/mcp?${input.url !== undefined ? `url=${q(input.url)}` : `command=${q(input.command ?? '')}`}`),
    project: () => request('settings/project'),
    store: () => request('settings/store'),
    ciWorkflows: async (o) => {
      const query = `fix=${o.fix ? 'on' : 'off'}&budget=${q(o.budget)}&repairer=${q(o.repairer)}&onlyMain=${o.onlyMain ? 'on' : 'off'}&secret=${q(o.secret)}`;
      try {
        return await request<CiWorkflowsView>(`ci/workflows?${query}`);
      } catch (err) {
        if (noEndpoint(err)) return null;
        throw err;
      }
    },
    addRule: (list, rule, expect) => send('POST', `settings/rules/${list}`, { rule, expect }),
    removeRule: (list, n, expect) => request(`settings/rules/${list}/${n}?expect=${q(expect)}`, { method: 'DELETE' }),
    setClock: (mode, expect) => send('PUT', 'settings/clock', { mode, expect }),
    setCiPush: (on, expect) => send('PUT', 'settings/store/ci-push', { on, expect }),
    writeCalibration: (jobId) => send('POST', 'settings/calibrate/write', { jobId }),
  };
}

/** An exported copy has no Settings: every call says so. */
export function noSettings(refuse: () => Promise<never>): SettingsApi {
  return {
    matching: refuse,
    redaction: refuse,
    preview: refuse,
    agents: refuse,
    tools: refuse,
    mcpLine: refuse,
    project: refuse,
    store: refuse,
    ciWorkflows: refuse,
    addRule: refuse,
    removeRule: refuse,
    setClock: refuse,
    setCiPush: refuse,
    writeCalibration: refuse,
  };
}
