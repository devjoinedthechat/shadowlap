import type { FactWords } from '../../actions.js';
import type { AgentOffer } from '../../../src/agent-skill.js';
import { regexProblem } from '../../../../engine/src/safe-regex.js';
import type { CiWorkflowOptions, CiWorkflowsView } from '../../types.js';

/**
 * What the Settings tabs work out without a server or a DOM: the tabs and their addresses, the Add
 * dialog's rule and the command it stands for, how the preview names a rule, sizes and times as the
 * tabs show them, what the drawer offers after calibrate and a clean-up, and what the CI tab's
 * controls show. The tests import it.
 */

export { SETTINGS_TABS, settingsTab, type SettingsTab } from './tabs.js';

// ---- when a tab reads again ----

/**
 * What a tab's data depends on in the run list: which runs there are, which are still recording,
 * and the project. A recording adding calls changes none of it, so an open tab doesn't read its data
 * again every time the run list reloads while something records.
 */
export function runListKey(runs: ReadonlyArray<{ runId: string; status: string }> | null, project: string | null): string {
  if (!runs) return `${project ?? ''}:-`;
  const running = runs.reduce((n, r) => n + (r.status === 'running' ? 1 : 0), 0);
  return `${project ?? ''}:${runs.length}:${runs[0]?.runId ?? ''}:${runs[runs.length - 1]?.runId ?? ''}:${running}`;
}

// ---- what leaves the machine ----

/**
 * What Redaction says after the copies the rules apply to, every export, pack and share link: the
 * local store is never touched; with a team store, push copies runs there as recorded, so teammates
 * can replay them; and what is never stored to begin with, which is only a credential sent the way
 * providers and services take it (a key the agent puts in a tool's arguments is stored).
 */
export function redactionNotes(teamStore: boolean): string {
  return [
    'The local store is never modified.',
    ...(teamStore ? ['Push copies runs to your team store as recorded, so teammates can replay them.'] : []),
    'A model call’s key and authorization headers, and a captured HTTP call’s credentials, are never stored at all.',
  ].join(' ');
}

/** What a rule does beyond the lead, as Add normalizer's and Add redaction rule's rows; with a team store, what Push leaves as it is. */
export function ruleFacts(list: 'normalize' | 'redact', teamStore: boolean): FactWords[] {
  if (list === 'normalize') return [{ label: 'Matches', value: 'older recordings too', quiet: 'their fingerprints are worked out again' }];
  return [{ label: 'Packs', value: 'still replay', quiet: 'the rule applies to them as a normalizer' }, ...(teamStore ? [{ label: 'Push', value: 'copies runs as recorded', quiet: 'to your team store' }] : [])];
}

/**
 * The Store tab's Share links row: the report behind a link applies every redaction rule, so it
 * says how many, and warns when there are none (the report then holds what was recorded) or when
 * they can't be read (`null`: a share stops until the file is fixed).
 */
export function shareLinksLine(rules: number | null): { text: string; warn: string | null } {
  const applied = rules ? ` with ${rules === 1 ? '1 redaction rule' : `${rules.toLocaleString('en-US')} redaction rules`} applied` : '';
  const text = `A report in the bucket${applied}, behind a link that expires after 7 days. Anyone with the link can open it, without an account.`;
  if (rules === null) return { text, warn: 'The redaction rules can’t be read, so a share link waits until shadowlap.config.json is fixed.' };
  if (rules === 0) return { text, warn: 'No redaction rules: the report holds the prompts and tool data as recorded. Add rules before you share a run.' };
  return { text, warn: null };
}

// ---- coding agents ----

/** The job that puts the Claude Code plugin or the skills into the project: `shadowlap skill install <agent>`. */
export const SKILL_INSTALL_KIND = 'skill-install';

/** What an install button says, and whether it asks first: it replaces a copy edited here. */
export interface AgentAction {
  label: string;
  ask: boolean;
}

/** A row of the instruction files, in words, and its tone: ok (dim), warn (amber), or muted. */
export interface AgentFileWords {
  text: string;
  tone: 'ok' | 'warn' | 'muted';
}

/**
 * An instruction file's row, as the design words it: found and mentioning Shadowlap, found without
 * a Shadowlap section yet (amber), or not in this project. A file whose agents read Shadowlap's
 * skills from where they are installed needs no section (`covered`, the words that say so):
 * CLAUDE.md once the plugin is in the project, AGENTS.md and the others once the skills are in
 * `.agents/skills`.
 */
export function agentFileWords(file: { found: boolean; mentions: boolean }, covered: string | null = null): AgentFileWords {
  if (!file.found) return { text: 'not in this project', tone: 'muted' };
  if (file.mentions) return { text: 'found · mentions Shadowlap', tone: 'ok' };
  if (covered) return { text: `found · ${covered}`, tone: 'ok' };
  return { text: 'found · no Shadowlap section yet', tone: 'warn' };
}

/**
 * The `.agents/skills` row with Shadowlap's skills (`skillOffer().agents`): this version's read
 * "found · shadowlap-setup-agent, shadowlap-debug-agent, 0.1.0" with nothing to do; with none yet,
 * the folder's own words and Add the skills; another version's, "found · Shadowlap’s skills 0.0.9"
 * and Update to 0.1.0, asking nothing; ones edited here, Replace with 0.1.0's copy…, which asks
 * first; a way that is blocked, the folder's words and why (`why`), with no button.
 */
export function sharedSkillsWords(
  file: { found: boolean; mentions: boolean },
  offer: Pick<AgentOffer, 'state' | 'blocked' | 'install' | 'installedVersion'>,
  version: string | null,
  names: readonly string[],
): AgentFileWords & { action: AgentAction | null; why: string | null } {
  if (offer.blocked) return { ...agentFileWords(file), action: null, why: offer.blocked };
  if (offer.state === 'current') return { text: `found · ${names.join(', ')}${version ? `, ${version}` : ''}`, tone: 'ok', action: null, why: null };
  if (offer.state === 'missing') {
    const own: AgentFileWords = file.found ? { text: 'found · no Shadowlap skills yet', tone: 'warn' } : { text: 'not in this project', tone: 'muted' };
    return { ...own, action: offer.install ? { label: 'Add the skills', ask: false } : null, why: null };
  }
  const to = version ?? 'this version';
  if (offer.state === 'other-version') return { text: `found · Shadowlap’s skills ${offer.installedVersion ?? ''}`.trimEnd(), tone: 'warn', action: offer.install ? { label: `Update to ${to}`, ask: false } : null, why: null };
  return { text: 'found · Shadowlap’s skills, edited here', tone: 'warn', action: offer.install ? { label: `Replace with ${to}’s copy…`, ask: true } : null, why: null };
}

/**
 * The skills' row once the owner has published the plugin (the design's skillPanelRows, and the
 * states MISSING.md words from `skillOffer()`): nothing there, its command and Install the skills;
 * this version's copy, installed; another version's, "0.0.9 in the project" and Update to 0.1.0,
 * asking nothing; one edited here, "Edited here." and Replace with 0.1.0's copy…, which asks first;
 * a way that is blocked, why, with no command and no button.
 */
export function skillWords(
  offer: Pick<AgentOffer, 'state' | 'blocked' | 'install'> & { installedVersion: string | null },
  version: string | null,
): { installed: boolean; line: string | null; tone: '' | 'warn'; command: string | null; action: AgentAction | null } {
  const command = offer.install?.command ?? null;
  if (offer.blocked) return { installed: false, line: offer.blocked, tone: 'warn', command: null, action: null };
  switch (offer.state) {
    case 'current':
      return { installed: true, line: null, tone: '', command: null, action: null };
    case 'missing':
      return { installed: false, line: null, tone: '', command: command ?? 'shadowlap skill install claude-code', action: command ? { label: 'Install the skills', ask: false } : null };
    case 'other-version':
      return { installed: false, line: `${offer.installedVersion ?? 'Another version'} in the project.`, tone: 'warn', command, action: command ? { label: `Update to ${version ?? 'this version'}`, ask: false } : null };
    case 'changed':
      return { installed: false, line: 'Edited here.', tone: 'warn', command, action: command ? { label: `Replace with ${version ?? 'this version'}’s copy…`, ask: true } : null };
  }
}

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

/**
 * What the dialog warns about before it asks the server: a regex the engine's pattern check refuses
 * (safe-regex.ts), as one that could take minutes on some text in every replay or copy it reads, in
 * the engine's words. The CLI refuses it too, so adding it is refused with the same reason.
 */
export function ruleWarning(f: RuleFormState): string | null {
  if (f.mode !== 'regex' || !f.regex.trim()) return null;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(regexLiteral(f.regex));
  const why = m ? regexProblem(m[1]!, m[2]!) : null;
  return why ? `The CLI refuses it: ${why}.` : null;
}

/** An argument as a shell takes it, quoted only when it has to be. */
export function shellArg(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** A command line's words, which a command line on any page wraps between (`CommandLine`). */
export { shellWords } from '../../format.js';

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

/**
 * `3 values would be masked`; `, 2 left as they are` when the rules match values a pack keeps as
 * recorded (numbers); `, 1 more in HTML, HAR and dataset copies` when a path rule masks what a call
 * got back, which only those copies do.
 */
export function maskedLine(total: number, unmasked = 0, returned = 0): string {
  const left = unmasked ? `, ${unmasked.toLocaleString('en-US')} left as ${unmasked === 1 ? 'it is' : 'they are'}` : '';
  const read = returned ? `, ${returned.toLocaleString('en-US')} more in HTML, HAR and dataset copies` : '';
  return `${total.toLocaleString('en-US')} value${total === 1 ? '' : 's'} would be masked${left}${read}`;
}

/** What a rule matches that a pack leaves as it is, as the preview gives it (`redact preview --json`, a rule's `unmasked`). */
export interface UnmaskedLike {
  count: number;
  samples: ReadonlyArray<{ value: string; key: boolean; callNo: number; kind: string; name: string; in: string; path: string; event: number | null }>;
  places: number;
  remedies: ReadonlyArray<{ rule: { path?: string }; command: string; copies: 'all' | 'read' }>;
  covered: readonly number[];
  reasons: readonly string[];
}

/** Why a value gets no path rule, in the page's words. */
const REASONS: Record<string, string> = {
  replay: 'clock or random reads, which a replay needs as recorded',
  stream: 'a stream’s events, which no path reaches',
  whole: 'the top of a request or response, which no path names alone',
  key: 'a key no path can name',
  signed: 'signed reasoning, which a pack keeps as recorded',
};

/**
 * The quiet line under a rule for what it matches that a pack leaves as it is (a number, which a
 * pattern never rewrites), in few words: how many, "more" after values it masks, and what masks
 * them: the first place's path rule, shown by its path with the command behind Copy (`command`), in
 * a request for every copy, in what a call got back for HTML, HAR and dataset copies only, since a
 * pack keeps that for its replay; how many other places have one (`more`, which `shadowlap redact
 * preview` gives); the rules that already mask them in those copies; and why the rest get none. On
 * hover (`rows`), each value with where it is. Null when the rule leaves nothing.
 */
export function unmaskedLine(
  u: UnmaskedLike,
  masked: number,
): { text: string; path: string | null; command: string | null; more: number; after: string; rows: Array<{ label: string; value: string }> } | null {
  if (!u.count) return null;
  const them = u.count === 1 ? 'it' : 'them';
  const left = `${u.count.toLocaleString('en-US')}${masked ? ' more' : ''} left as ${u.count === 1 ? 'it is' : 'they are'}`;
  const rows = u.samples.map((s) => ({ label: s.value, value: `call ${s.callNo} ${s.kind}${s.kind === 'api' ? '' : ` ${s.name}`}, ${s.in}${s.event === null ? '' : ` event ${s.event}`}${s.key ? ' key' : ''} ${s.path}` }));
  const first = u.remedies[0];
  const covered = u.covered.length ? `${u.covered.map((n) => `#${n}`).join(', ')} ${u.covered.length === 1 ? 'masks' : 'mask'} ${them} in HTML, HAR and dataset copies` : '';
  const none = u.reasons.map((r) => REASONS[r]).filter(Boolean);
  const noneText = none.length ? `none for ${none.join(', ')}` : '';
  if (first) {
    const how = first.copies === 'all' ? `a path rule masks ${them}` : `a pack keeps what calls got back; HTML, HAR and dataset copies mask ${them} with a path rule`;
    return { text: `${left} · ${how}`, path: first.rule.path ?? null, command: first.command, more: u.places - 1, after: [covered, noneText].filter(Boolean).join('; '), rows };
  }
  if (covered) return { text: `${left} · a pack keeps what calls got back; ${covered}`, path: null, command: null, more: 0, after: noneText, rows };
  return { text: none.length ? `${left}, in ${none.join(', ')}.` : `${left}.`, path: null, command: null, more: 0, after: '', rows };
}

/**
 * The quiet line under a rule with a path for what it masks in what calls got back, which only
 * HTML, HAR and dataset copies do (a rule's `returned`); null when it masks nothing there.
 */
export function returnedLine(r: { count: number; samples: ReadonlyArray<{ before: string; after: string }> }): { text: string; rows: Array<{ label: string; value: string }> } | null {
  if (!r.count) return null;
  return {
    text: `${r.count.toLocaleString('en-US')} in what calls got back, masked in HTML, HAR and dataset copies; a pack keeps ${r.count === 1 ? 'it' : 'them'} for its replay`,
    rows: r.samples.map((s) => ({ label: s.before, value: `→ ${s.after}` })),
  };
}

/** How far a preview a limit stopped got, and which limit: the words before the command that reads the whole run. */
export function partialLine(p: { read: number; of: number; stopped?: 'calls' | 'bytes' | 'time' }): string {
  const first = `Read the first ${p.read.toLocaleString('en-US')} of ${p.of.toLocaleString('en-US')} calls`;
  if (p.stopped === 'bytes') return `${first}, as much as a preview reads.`;
  if (p.stopped === 'time') return `${first} in the time a preview takes.`;
  return `${first}.`;
}

// ---- words ----

/** `a`, `a or b`, `a, b or c`; with `and`, `a, b and c`. */
export function orList(items: readonly string[], word: 'or' | 'and' = 'or'): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]!}`;
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
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]!}`;
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
  /** The attempts bundled under those runs, which go with them, as `shadowlap rm` takes them; 0 from an older CLI. */
  attempts: number;
  cutoff: number | null;
  keep: number | null;
  olderThanDays: number | null;
  /** What the blobs only those runs use take. */
  bytes: number;
  /** Unused space in the store now, which a clean-up's vacuum gives back too. */
  free: number;
  expect: string;
}

/** Unused space worth a clean-up of its own when no run is old enough: 1 MB, as `gc` counts it. */
export const UNUSED_WORTH = 1024 * 1024;

/**
 * What the drawer offers after a clean-up's dry run: "Delete N runs" when it found runs; "Free X"
 * when it found none but blobs nothing uses or unused space to give back (a plain `gc`, which
 * deletes no run); null, nothing, when there is neither, or while a run records (gc waits for it).
 */
export function gcDryRun(job: { done: boolean; code: number | null; result?: unknown }): GcDryRun | null {
  if (!job.done || job.code !== 0) return null;
  const r = job.result as (Partial<GcDryRun> & { store?: { free?: unknown }; recordingCount?: unknown }) | null | undefined;
  if (!r || typeof r !== 'object' || r.dryRun !== true || typeof r.count !== 'number' || r.count < 0 || typeof r.expect !== 'string') return null;
  const bytes = typeof r.bytes === 'number' ? r.bytes : 0;
  const free = typeof r.store?.free === 'number' ? r.store.free : 0;
  if (r.count === 0 && (Number(r.recordingCount) > 0 || (bytes <= 0 && free < UNUSED_WORTH))) return null;
  return { dryRun: true, count: r.count, attempts: typeof r.attempts === 'number' && r.attempts > 0 ? r.attempts : 0, cutoff: typeof r.cutoff === 'number' ? r.cutoff : null, keep: typeof r.keep === 'number' ? r.keep : null, olderThanDays: typeof r.olderThanDays === 'number' ? r.olderThanDays : null, bytes, free, expect: r.expect };
}

/** What a dry run that found no runs would give back: the blobs nothing uses, and the unused space past 1 MB. */
/**
 * The Size row's words after the size: blobs are shared, and the space deleted runs left unused
 * that Clean up old runs gives back, once no run is recording when one is (gc leaves the store
 * alone while a recording writes to it).
 */
export function sizeNote(free: number, recording: number): string {
  if (free < UNUSED_WORTH) return 'blobs shared between runs';
  return `blobs shared between runs · ${bytesText(free)} unused, which Clean up old runs gives back${recording ? ' once no run is recording' : ''}`;
}

export function gcGivesBack(d: GcDryRun): number {
  return d.bytes + (d.free >= UNUSED_WORTH ? d.free : 0);
}

/** The command the confirm runs, as the server builds it from the dry run: exactly the runs it listed, or for none, a plain `gc`. */
export function gcDeleteCommand(d: GcDryRun): string {
  if (d.count === 0) return 'shadowlap gc';
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

/** A client entry to paste under `mcpServers`, as docs/mcp.md writes one, with its `env` when it has one. */
export function mcpEntryText(name: string, entry: { command: string; args: readonly string[] }, env: ReadonlyArray<{ name: string; value: string }> = []): string {
  const q = (v: string) => JSON.stringify(v);
  const lines = [`${q(name)}: {`, `  "command": ${q(entry.command)},`, `  "args": [${entry.args.map(q).join(', ')}]${env.length ? ',' : ''}`];
  if (env.length) lines.push(`  "env": { ${env.map((e) => `${q(e.name)}: ${q(e.value)}`).join(', ')} }`);
  return [...lines, '}'].join('\n');
}

/**
 * What the toast says once a row's `shadowlap mcp` line is copied: where it goes, and what in the
 * line itself needs a value before the client starts it (a ••• it hides, a `${VAR}` its header
 * reads). The entry's own environment stays as it is in the file, so it isn't named.
 */
export function copiedLineText(row: { name: string; file: string | null; line: string | null }): string {
  const line = row.line ?? '';
  const vars = [...new Set([...line.matchAll(/\$\{([A-Za-z_][\w]*)\}/g)].map((m) => m[1]!))];
  // Claude Code fills in ${…} in .mcp.json itself, from the environment it starts from.
  const where = row.file === CLAUDE_CODE_FILE ? 'the environment Claude Code starts from' : 'its env';
  const needs = [...(line.includes('•••') ? ['put back the ••• in it'] : []), ...(vars.length ? [`set ${orList(vars)} in ${where}`] : [])];
  return `Copied the line for ${row.name} · put it in front of the server in ${row.file ?? 'your client’s config'}${needs.length ? `, then ${needs.join(' and ')}` : ''}`;
}

/** Claude Code's project file: it fills in `${NAME}` in it from the environment Claude Code starts from, and won't start a server while NAME is unset there. */
export const CLAUDE_CODE_FILE = '.mcp.json';

/** The project's client config a copied entry goes in: the first one found, or null when there is none. */
export function pasteFile(files: ReadonlyArray<{ path: string; found: boolean }>): string | null {
  return files.find((f) => f.found)?.path ?? null;
}

/**
 * The copied entry's environment for the file it goes in: in .mcp.json, the variable a URL's user
 * and password became is `${NAME}`, which Claude Code fills in; elsewhere `…`, for its value.
 */
export function entryEnvFor(env: ReadonlyArray<{ name: string; value: string }>, basic: string | null | undefined, file: string | null): Array<{ name: string; value: string }> {
  return env.map((e) => (file === CLAUDE_CODE_FILE && e.name === basic ? { name: e.name, value: `\${${e.name}}` } : { ...e }));
}

/**
 * What Add MCP server… says under the entry, by what it hid: `basic`, the variable a URL's user and
 * password became and where to set it (in .mcp.json's case, where Claude Code starts; for another
 * file, the entry's env; with no file yet, either); `inCopy`, a URL's user and password in a
 * command, which show as ••• in the copy too; `asTyped`, anything else that shows as ••• but is
 * copied as typed (a URL's query, a key in its path, a token in a command). Null when nothing was.
 */
export function addServerNotes(shown: { line: string; hidden: boolean; basic?: string | null; copy?: { args: readonly string[] } | null }, file: string | null): { basic: { name: string; where: 'claude-code' | 'env' | 'either' } | null; inCopy: boolean; asTyped: boolean } | null {
  if (!shown.hidden) return null;
  const count = (text: string) => text.split('•••').length - 1;
  const copied = count((shown.copy?.args ?? []).join(' '));
  const basic = shown.basic ? { name: shown.basic, where: file === CLAUDE_CODE_FILE ? ('claude-code' as const) : file ? ('env' as const) : ('either' as const) } : null;
  return { basic, inCopy: copied > 0, asTyped: count(shown.line) > copied };
}

/** The forms a server takes, each with the line that records one: what the page shows for a form no server here uses. */
export const MCP_FORMS: Readonly<Record<'stdio' | 'http', { label: string; line: string }>> = {
  stdio: { label: 'Started as a command', line: 'shadowlap mcp -- npx -y @modelcontextprotocol/server-filesystem .' },
  // `$TOKEN`, which the proxy reads from its environment: a client that fills in `${…}` itself would put the token on the command line.
  http: { label: 'Reached by its URL', line: "shadowlap mcp --url https://mcp.example.com/mcp --header 'Authorization: Bearer $TOKEN'" },
};

/** Words in a server's name that say nothing about which server it is. */
const NAME_NOISE = new Set(['mcp', 'api', 'www', 'server', 'servers', 'app', 'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'cloud', 'node', 'python', 'python3', 'deno', 'bun', 'uv', 'docker']);

/**
 * A name for a server Add MCP server… has no name for: `linear` for https://mcp.linear.app/mcp,
 * `github` for npx -y @modelcontextprotocol/server-github, else `server`.
 */
export function serverNameFor(transport: 'stdio' | 'http', target: string): string {
  const pick = (words: string[]) => words.map((w) => w.toLowerCase()).find((w) => /^[a-z][a-z0-9-]*$/.test(w) && !NAME_NOISE.has(w)) ?? 'server';
  if (transport === 'http') {
    let host: string;
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

/**
 * What the CI tab's controls show: what was changed on the tab, else what the server answered with
 * (its defaults, which the panels' first answer carries), so nothing in the UI repeats them.
 */
export function ciShown(changed: Partial<CiWorkflowOptions>, view: CiWorkflowsView): CiWorkflowOptions {
  return {
    fix: changed.fix ?? view.fixOnFailure.on,
    alerts: changed.alerts ?? view.alerts.on ?? true,
    budget: changed.budget ?? view.fixOnFailure.budget,
    repairer: changed.repairer ?? view.fixOnFailure.repairer,
    onlyMain: changed.onlyMain ?? view.alerts.onlyMain,
    secret: changed.secret ?? view.alerts.secret,
    inconclusive: changed.inconclusive ?? view.alerts.inconclusive ?? 'fail',
  };
}

/** A secret's name as it is typed: only what GitHub allows in one (letters, digits and `_`) is kept. */
export function typedSecret(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 100);
}
