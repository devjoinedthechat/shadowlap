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
import type { CiWorkflowOptions } from '../src/ci-workflows.js';
import type { PrCommentPreview } from '../src/pr-comment-preview.js';
import type { GatePreview } from '../src/tests-gate.js';

/**
 * Settings' part of the API client (`client.settings`): each tab's read, and the edits to
 * shadowlap.config.json. Every edit sends the version of the file the tab read (`config.version`),
 * so the server refuses it with a 409 when the file changed on disk since. Types only from the
 * server's read model (`src/settings.ts`): nothing here needs Node. The CI tab reads
 * `client.ciWorkflows`, which Tests uses too, and the pull request comment's preview here, which a
 * revision's page under Changes opens too.
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

/** What Add MCP server… shows for a command or a URL: the line, the client entry, and whether a credential was hidden. */
export interface McpLine {
  transport: 'stdio' | 'http';
  target: string;
  line: string;
  entry: { command: string; args: string[] };
  hidden: boolean;
  /** The entry's environment: the variable a URL's user and password became (value `…`, to set). */
  env?: Array<{ name: string; value: string }>;
  /** That variable, for an `Authorization: Basic` header; null without one. */
  basic?: string | null;
  /** The entry as typed, except a URL's user and password, which are never copied: what Copy entry copies. */
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
  /** Answers the rule as the file held it, for its Undo (`restoreRule`). */
  removeRule(list: RuleListName, n: number, expect: string): Promise<{ n: number; rule: unknown; version: string }>;
  /** Undo of a removal: the rule `removeRule` answered, back at its number, against the version that removal wrote. */
  restoreRule(list: RuleListName, n: number, rule: unknown, expect: string): Promise<{ n: number; version: string }>;
  /** Null takes the key out (the Undo of a file that had none); `was` is what the file said before, null for nothing. */
  setClock(mode: 'auto' | 'exact' | null, expect: string): Promise<{ clock: 'auto' | 'exact'; was: 'auto' | 'exact' | null; changed: boolean; version: string }>;
  setCiPush(on: boolean | null, expect: string): Promise<{ ciPush: boolean; was: boolean | null; changed: boolean; version: string }>;
  /** "Add normalizer": the normalizers a finished calibrate job proposed, read from its result on the server. */
  writeCalibration(jobId: string): Promise<{ added: number[]; already: number[]; version: string }>;
  /**
   * Settings → CI's Write file: the workflow the switches build, written only while the file is the
   * version read (`expect`) and the text the ask showed (`shown`, its hash). `was` names its Undo.
   */
  writeWorkflow(options: Partial<CiWorkflowOptions>, expect: string, shown: string): Promise<{ path: string; version: string; changed: boolean; was: string | null }>;
  /** Write file's Undo: the file as the write found it, or none, against the version the write left, which the server holds with `was`. */
  undoWorkflow(was: string): Promise<{ path: string; version: string; removed: boolean }>;
  /** What a gate's figures would do, as Gates previews them: the query `GET /api/tests/gate` takes. */
  gate(query: string, signal?: AbortSignal): Promise<GatePreview>;
  /** The pull request comment as the Action would post it (`GET /api/ci/comment`): `{ session: null }` before a session ran every golden. */
  prComment(): Promise<PrCommentPreview | { session: null }>;
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
    restoreRule: (list, n, rule, expect) => send('POST', `settings/rules/${list}/${n}/restore`, { rule, expect }),
    setClock: (mode, expect) => send('PUT', 'settings/clock', { mode, expect }),
    setCiPush: (on, expect) => send('PUT', 'settings/store/ci-push', { on, expect }),
    writeCalibration: (jobId) => send('POST', 'settings/calibrate/write', { jobId }),
    writeWorkflow: (options, expect, shown) => send('PUT', 'ci/workflow', { options, expect, shown }),
    undoWorkflow: (was) => send('POST', 'ci/workflow/undo', { was }),
    gate: (query, signal) => request(`tests/gate?${query}`, signal ? { signal } : {}),
    prComment: () => request('ci/comment'),
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
    restoreRule: refuse,
    setClock: refuse,
    setCiPush: refuse,
    writeCalibration: refuse,
    writeWorkflow: refuse,
    undoWorkflow: refuse,
    gate: refuse,
    prComment: refuse,
  };
}
