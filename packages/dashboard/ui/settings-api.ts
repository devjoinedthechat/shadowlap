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
 * server's read model (`src/settings.ts`): nothing here needs Node. The CI tab reads
 * `client.ciWorkflows`, which Tests uses too.
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
  addRule(list: RuleListName, rule: RuleInput, expect: string): Promise<{ n: number; added: boolean; version: string }>;
  removeRule(list: RuleListName, n: number, expect: string): Promise<{ n: number; version: string }>;
  setClock(mode: 'auto' | 'exact', expect: string): Promise<{ clock: string; changed: boolean; version: string }>;
  setCiPush(on: boolean, expect: string): Promise<{ ciPush: boolean; changed: boolean; version: string }>;
  /** "Add it (--write)": the normalizers a finished calibrate job proposed, read from its result on the server. */
  writeCalibration(jobId: string): Promise<{ added: number[]; already: number[]; version: string }>;
}

/** The client's request function, as `createClient` has it. */
export type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

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
    addRule: refuse,
    removeRule: refuse,
    setClock: refuse,
    setCiPush: refuse,
    writeCalibration: refuse,
  };
}
