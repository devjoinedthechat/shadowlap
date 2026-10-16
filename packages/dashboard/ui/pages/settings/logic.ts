import { ACTION, ALERT_FAILURES, FIX_BUDGETS, REPAIRERS, WORKFLOW_FILE, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml } from '../../../src/ci-yaml.js';
import type { CiOptions, CiPullRequest, CiWorkflowsView } from '../../settings-api.js';

/**
 * What the Settings tabs work out without a server or a DOM: the tabs and their addresses, the Add
 * dialog's rule and the command it stands for, how the preview names a rule, sizes and times as the
 * tabs show them, what the drawer offers after calibrate and a clean-up, and the CI tab's panels
 * when the server doesn't serve them. The tests import it.
 */

export { SETTINGS_TABS, settingsTab, type SettingsTab } from './tabs.js';

// ---- the Add dialog ----

export type RuleListName = 'normalize' | 'redact';

/** What a rule matches inside the value at its path: a named pattern, a /regex/, or the whole value (Advanced). */
export type PatternMode = 'named' | 'regex' | 'whole';

export interface RuleFormState {
  /** `` for every call, else a call kind: api, tool (and clock, random for a normalizer). */
  kind: string;
  /** A tool name for a tool rule, a call name such as `POST /v1/messages` for an api one (Advanced). */
  name: string;
  path: string;
  mode: PatternMode;
  named: string;
  regex: string;
  replace: string;
}

/** What each named pattern is replaced with unless the person types something else. */
const REPLACE_FOR: Readonly<Record<string, string>> = {
  uuid: '<UUID>',
  ulid: '<ULID>',
  'iso-date': '<DATE>',
  'iso-datetime': '<DATETIME>',
  number: '<NUMBER>',
  email: '<EMAIL>',
};

/** The replacement the dialog suggests for a pattern, or the list's default for a regex or the whole value. */
export function suggestedReplace(list: RuleListName, mode: PatternMode, named: string): string {
  return (mode === 'named' && REPLACE_FOR[named]) || (list === 'normalize' ? '<MASKED>' : '<REDACTED>');
}

/** The form a dialog opens with: the mock's, a UUID for a normalizer and an email for a redaction rule. */
export function emptyRuleForm(list: RuleListName, patterns: readonly string[]): RuleFormState {
  const want = list === 'normalize' ? 'uuid' : 'email';
  const named = patterns.includes(want) ? want : (patterns[0] ?? want);
  return { kind: '', name: '', path: '', mode: 'named', named, regex: '', replace: suggestedReplace(list, 'named', named) };
}

/** A regex as the config writes it, `/…/flags`: typed without slashes, it is wrapped in them. */
export function regexLiteral(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return /^\/[\s\S]*\/[a-z]*$/.test(t) && t.length > 1 ? t : `/${t}/`;
}

/** The rule the dialog sends: blank fields left out, as the CLI leaves out a flag that wasn't given. */
export function ruleInput(f: RuleFormState): { kind?: string; name?: string; path?: string; pattern?: string; replace?: string } {
  const out: { kind?: string; name?: string; path?: string; pattern?: string; replace?: string } = {};
  if (f.kind) out.kind = f.kind;
  if (f.kind && f.name.trim()) out.name = f.name.trim();
  if (f.path.trim()) out.path = f.path.trim();
  if (f.mode === 'named' && f.named) out.pattern = f.named;
  if (f.mode === 'regex' && f.regex.trim()) out.pattern = regexLiteral(f.regex);
  if (f.replace !== '') out.replace = f.replace;
  return out;
}

/** Why the dialog can't add the rule yet, before the server is asked; null when it can. */
export function ruleProblem(f: RuleFormState): string | null {
  if (f.mode === 'regex' && !f.regex.trim()) return 'Type the regex to match.';
  if (f.mode === 'whole' && !f.path.trim()) return 'Give the path whose whole value is replaced.';
  if (f.path.trim() && !f.path.trim().startsWith('$')) return 'A path starts with $, such as $.metadata.user_id.';
  return null;
}

/** An argument as a shell takes it, quoted only when it has to be. */
export function shellArg(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * A command line's words, split at the spaces a shell splits at (outside '…' and "…"), each kept
 * with its quotes: what a command line on the page wraps between, so a flag and its value or a
 * quoted header never break inside.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let escaped = false;
  for (const c of line) {
    if (escaped) {
      word += c;
      escaped = false;
    } else if (quote) {
      word += c;
      if (c === quote) quote = null;
    } else if (c === '\\') {
      word += c;
      escaped = true;
    } else if (c === ' ') {
      if (word) words.push(word);
      word = '';
    } else {
      word += c;
      if (c === "'" || c === '"') quote = c;
    }
  }
  if (word) words.push(word);
  return words;
}

/** The CLI command that adds the same rule: what the dialog shows under its fields. */
export function ruleCommand(list: RuleListName, f: RuleFormState): string {
  const r = ruleInput(f);
  const parts = ['shadowlap', list, 'add'];
  if (r.kind) parts.push('--kind', r.kind);
  if (r.name) parts.push('--name', shellArg(r.name));
  if (r.path) parts.push('--path', shellArg(r.path));
  if (r.pattern) parts.push('--pattern', shellArg(r.pattern));
  if (r.replace !== undefined) parts.push('--replace', shellArg(r.replace));
  return parts.join(' ');
}

// ---- the preview ----

/** How the preview names a rule, as the mock does: its path, else what a regex puts in place, else its named pattern. */
export function previewChip(rule: { path?: string; pattern?: string; replace: string }): string {
  if (rule.path) return rule.path;
  if (!rule.pattern || rule.pattern.startsWith('/')) return rule.replace;
  return rule.pattern;
}

/** `3 values would be masked`. */
export function maskedLine(total: number): string {
  return `${total.toLocaleString('en-US')} value${total === 1 ? '' : 's'} would be masked`;
}

/** How far a preview a limit stopped got, and which limit: the words before the command that reads the whole run. */
export function partialLine(p: { read: number; of: number; stopped?: 'calls' | 'bytes' | 'time' }): string {
  const first = `Read the first ${p.read.toLocaleString('en-US')} of ${p.of.toLocaleString('en-US')} calls`;
  if (p.stopped === 'bytes') return `${first}, as much as a preview reads.`;
  if (p.stopped === 'time') return `${first} in the time a preview takes.`;
  return `${first}.`;
}

// ---- words ----

/** `a`, `a or b`, `a, b or c`. */
export function orList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

// ---- sizes and counts ----

/** A store's size as the Project tab shows it: `18.4 MB`. */
export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** A time as the Store tab's "Last sync" shows it: `10:14` today, `Sep 30` before, `never` without one. */
export function syncText(at: number | null, now = Date.now()): string {
  if (at === null) return 'never';
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

// ---- what the drawer offers ----

/** A calibrate job's result, as `calibrate --json` prints it and fd 3 carries it. */
interface CalibrateResult {
  normalizers?: unknown;
  written?: unknown;
  clean?: unknown;
}

/** How many normalizers "Add it (--write)" would add: those a finished calibration proposed and didn't write. 0 hides the button. */
export function proposedCount(job: { done: boolean; result?: unknown }): number {
  if (!job.done) return 0;
  const r = job.result as CalibrateResult | null | undefined;
  if (!r || typeof r !== 'object' || r.written === true || !Array.isArray(r.normalizers)) return 0;
  return r.normalizers.length;
}

/** A clean-up's dry run, as `gc --json` prints it. */
export interface GcDryRun {
  dryRun: true;
  count: number;
  cutoff: number | null;
  keep: number | null;
  olderThanDays: number | null;
  bytes: number;
  expect: string;
}

/** The dry run "Delete N runs" confirms: a finished one that found runs; null hides the button. */
export function gcDryRun(job: { done: boolean; code: number | null; result?: unknown }): GcDryRun | null {
  if (!job.done || job.code !== 0) return null;
  const r = job.result as Partial<GcDryRun> | null | undefined;
  if (!r || typeof r !== 'object' || r.dryRun !== true || typeof r.count !== 'number' || r.count < 1 || typeof r.expect !== 'string') return null;
  return { dryRun: true, count: r.count, cutoff: typeof r.cutoff === 'number' ? r.cutoff : null, keep: typeof r.keep === 'number' ? r.keep : null, olderThanDays: typeof r.olderThanDays === 'number' ? r.olderThanDays : null, bytes: typeof r.bytes === 'number' ? r.bytes : 0, expect: r.expect };
}

/** The command "Delete N runs" runs, as the server builds it from the dry run: shown in the confirm dialog. */
export function gcDeleteCommand(d: GcDryRun): string {
  return ['shadowlap gc', ...(d.cutoff !== null ? [`--before ${d.cutoff}`] : []), ...(d.keep !== null ? [`--keep ${d.keep}`] : []), `--expect ${d.expect}`].join(' ');
}

// ---- MCP servers ----

/** One row of the Tools tab's MCP table. */
export interface McpRow {
  key: string;
  name: string;
  transport: 'stdio' | 'http';
  /** Its command or URL, credentials hidden. */
  target: string;
  /** The tools it offers (or that were called through it); null when nothing was recorded through it. */
  tools: number | null;
  writes: number;
  /** For a server the client starts without `shadowlap mcp`: the line to put in front of it. */
  line: string | null;
  /** Under its name: that it isn't recorded, or that no config here lists it. */
  note: string | null;
  /** The client config that lists it. */
  file: string | null;
  /** What its line leaves out, to put back before the client starts it (an environment variable to set). */
  putBack: string[];
}

interface McpServerLike {
  name: string;
  file: string;
  transport: 'stdio' | 'http';
  target: string;
  viaShadowlap: boolean;
  line: string;
  putBack: readonly string[];
  recorded: { tools: number; writes: number } | null;
}

interface McpRecordedLike {
  transport: 'stdio' | 'http';
  server: string;
  tools: number;
  writes: number;
  inConfig: boolean;
}

/** A recorded server's short name: its host, or the package a runner starts (`server-filesystem`), or its command. */
export function mcpShortName(transport: 'stdio' | 'http', server: string): string {
  if (transport === 'http') return server;
  const last = server.split(' ').pop() ?? server;
  return last.replace(/@[^@/]*$/, '').split('/').pop() || server;
}

/**
 * The servers the project's client configs list, then those calls came through that no config here
 * lists (a config outside the project), each once.
 */
export function mcpRows(mcp: { servers: readonly McpServerLike[]; recorded: readonly McpRecordedLike[] }): McpRow[] {
  const rows: McpRow[] = mcp.servers.map((s) => ({
    key: `${s.file}\u0000${s.name}`,
    name: s.name,
    transport: s.transport,
    target: s.target,
    tools: s.recorded ? s.recorded.tools : null,
    writes: s.recorded?.writes ?? 0,
    line: s.viaShadowlap ? null : s.line,
    note: s.viaShadowlap ? null : `not recorded · ${s.file} starts it directly`,
    file: s.file,
    putBack: [...s.putBack],
  }));
  for (const r of mcp.recorded) {
    if (r.inConfig) continue;
    rows.push({ key: `recorded\u0000${r.transport}\u0000${r.server}`, name: mcpShortName(r.transport, r.server), transport: r.transport, target: r.server, tools: r.tools, writes: r.writes, line: null, note: 'recorded · in no config in this project', file: null, putBack: [] });
  }
  return rows;
}

/** A client entry to paste under `mcpServers`, as docs/mcp.md writes one. */
export function mcpEntryText(name: string, entry: { command: string; args: readonly string[] }): string {
  return `${JSON.stringify(name)}: {\n  "command": ${JSON.stringify(entry.command)},\n  "args": [${entry.args.map((a) => JSON.stringify(a)).join(', ')}]\n}`;
}

/** The forms a server takes, each with the line that records one: what the page shows for a form no server here uses. */
export const MCP_FORMS: Readonly<Record<'stdio' | 'http', { label: string; line: string }>> = {
  stdio: { label: 'Started as a command', line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-filesystem .' },
  http: { label: 'Reached by its URL', line: 'shadowlap mcp --url https://mcp.example.com/mcp --header "Authorization: Bearer ${TOKEN}"' },
};

/** Words in a server's name that say nothing about which server it is. */
const NAME_NOISE = new Set(['mcp', 'api', 'www', 'server', 'servers', 'app', 'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'cloud', 'node', 'python', 'python3', 'deno', 'bun', 'uv', 'docker']);

/**
 * A name for a server "Add a server…" has no name for: `linear` for https://mcp.linear.app/mcp,
 * `github` for npx -y @modelcontextprotocol/server-github, else `server`.
 */
export function serverNameFor(transport: 'stdio' | 'http', target: string): string {
  const pick = (words: string[]) => words.map((w) => w.toLowerCase()).find((w) => /^[a-z][a-z0-9-]*$/.test(w) && !NAME_NOISE.has(w)) ?? 'server';
  if (transport === 'http') {
    let host = '';
    try {
      host = new URL(target.trim()).hostname;
    } catch {
      return 'server';
    }
    return pick(host.split('.').slice(0, -1));
  }
  const words = target.trim().split(/\s+/);
  const runner = /(^|[\\/])(npx|pnpx|bunx|uvx)$/.test(words[0] ?? '');
  const pkg = runner ? words.slice(1).find((w) => !w.startsWith('-')) : words[0]?.split(/[\\/]/).pop();
  if (!pkg) return 'server';
  const bare = pkg.replace(/@[^@/]*$/, '').split('/').pop()!.replace(/\.(c?js|mjs|py|exe)$/, '');
  return pick(bare.split(/[-_.]/).reverse());
}

/** Where to paste an entry, by the client configs the project has: the key and the file. */
export function pasteWhere(files: ReadonlyArray<{ path: string; found: boolean }>): string {
  const found = files.find((f) => f.found);
  if (!found) return 'under mcpServers in your client’s config (servers in VS Code’s)';
  return `under ${found.path === '.vscode/mcp.json' ? 'servers' : 'mcpServers'} in ${found.path}`;
}

// ---- CI ----

/** What the CI tab's panels start as: Fix on failure off, $2 with Claude Code; alerts for main, to SLACK_WEBHOOK_URL. */
export const CI_DEFAULTS: CiOptions = { fix: false, budget: '2.00', repairer: 'claude-code', onlyMain: true, secret: 'SLACK_WEBHOOK_URL' };

/** The pull request the panel shows before any fix was verified here: the docs' refund agent. */
function examplePullRequest(budget: string): CiPullRequest {
  return {
    title: 'Escalate refunds above the policy limit',
    author: 'github-actions',
    base: 'main',
    branch: 'shadowlap/fix-refund-limit',
    verify: 'target 3 of 3 · held-out 2 of 2 · good 5 of 5',
    blame: 'lost at model call #5 · confidence high',
    change: 'prompts/refund.md +1 −0',
    spent: `≈$0.84 of $${budget}`,
    fixId: null,
    example: true,
  };
}

const ciRows = (list: ReadonlyArray<readonly [string, string]>) => list.map(([label, value]) => ({ label, value }));

/**
 * Both CI panels written here, from the same functions the server uses (`src/ci-yaml.ts`), for a
 * dashboard that doesn't serve `GET /api/ci/workflows`: what it serves for a project with no
 * goldens listed, no verified fix and no GitHub remote it can read.
 */
export function localCiWorkflows(o: CiOptions): CiWorkflowsView {
  const recordings = 'goldens/*';
  const message = alertsMessage({ failed: 1, branch: o.onlyMain ? 'main' : 'your-branch', runUrl: 'github.com/owner/repo/actions/runs/…' });
  return {
    file: WORKFLOW_FILE,
    action: ACTION,
    fixOnFailure: {
      on: o.fix,
      budget: o.budget,
      repairer: o.repairer,
      budgets: FIX_BUDGETS.map((b) => ({ value: b, label: `$${Number(b)}` })),
      repairers: REPAIRERS.map((r) => ({ ...r })),
      offNote: 'Off: a failed check fails the build, and nobody opens a fix.',
      yaml: fixOnFailureYaml({ budget: o.budget, repairer: o.repairer, recordings }),
      needs: ciRows(fixOnFailureNeeds(o.repairer)),
      never: ciRows(fixOnFailureNever(o.budget)),
      preview: examplePullRequest(o.budget),
    },
    alerts: {
      onlyMain: o.onlyMain,
      secret: alertsSecret(o.secret),
      yaml: alertsYaml({ onlyMain: o.onlyMain, secret: o.secret, recordings }),
      needs: ciRows(alertsNeeds(o.secret)),
      failures: ciRows(ALERT_FAILURES),
      message: { app: 'GitHub Actions', text: message.text, link: message.link, at: null },
    },
    recordings,
    repository: null,
  };
}

/** A secret's name as it is typed: only what GitHub allows in one (letters, digits and `_`) is kept. */
export function typedSecret(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 100);
}
