import { readFileSync } from 'node:fs';
import { canonicalize } from './canonical.js';

/**
 * When the models a recording uses stop working, so `shadowlap decisions` and `migrate` can warn that a
 * recorded model retires without asking anyone. The table is data, `data/model-retirements.json` in
 * this package: the providers' own pages as they read on the day in its `version`. Nothing here calls
 * home: a release ships the table as it stood, and a newer release ships a newer one.
 *
 * Only dates a page states are kept, each row with the page it comes from:
 *
 * - a model's retirement or shutdown date, as announced. Anthropic's "not sooner than" dates and
 *   Vertex AI's "or later" ones for active models set no date, and are left out;
 * - Google's Gemini API gives the earliest date a model may shut down (`earliest`);
 * - Amazon Bedrock's dates differ by Region (`regions`), and apply to Bedrock only: a platform that
 *   serves another provider's models sets its own dates, so a Claude model called through Bedrock is
 *   judged by Bedrock's table, not Anthropic's, and one called through Vertex AI by Google's page
 *   for partner models;
 * - Azure OpenAI is left out: a call there names the deployment, which can serve any model.
 *
 * Models that hold no conversation (embeddings, images, speech, video) and the Live APIs, which
 * Shadowlap doesn't record, are left out. The same file keeps the request fields newer models stop
 * accepting (`fields`), which `migrate` changes.
 */

/** Where a model is served, as the table tells its dates apart: a provider's own API, or a platform that serves it. */
export type RetirementPlatform = 'anthropic' | 'openai' | 'gemini' | 'vertex' | 'bedrock';

export interface ModelRetirement {
  platform: RetirementPlatform;
  /** The model id exactly as the page lists it. */
  model: string;
  /** When it was deprecated: the announcement (Bedrock: the day it became Legacy). */
  deprecated?: string;
  /** The day requests to it stop working (YYYY-MM-DD), or null when the page says it is yet to be announced. */
  retires: string | null;
  /** The date is the earliest it may shut down, not a date set for it (the Gemini API). */
  earliest?: true;
  /** The Regions the date covers (Bedrock). */
  regions?: readonly string[];
  /** The replacement the page recommends, as it words it. */
  replacement?: string;
  /** The page the row comes from. */
  source: string;
}

/** A platform: how a report names it, its main page, every page its rows cite, and what the table keeps from them. */
export interface RetirementSource {
  name: string;
  owner: string;
  url: string;
  pages: readonly string[];
  keeps: string;
}

/**
 * Request fields a provider stops accepting on its newer models, from its own pages: what a model
 * switch may need besides the model's name. `models` are the model ids the page's words cover.
 * Anthropic's rules are about Claude models wherever they are served: they apply to a Messages API
 * body on the Claude API, Amazon Bedrock and Vertex AI alike.
 */
export interface FieldRetirement {
  platform: RetirementPlatform;
  fields: readonly string[];
  /** The models it applies to, by id (an alias or a dated snapshot of one starts with it). */
  models: readonly string[];
  /** Which models, in the page's words. */
  appliesTo: string;
  /** What the provider does with such a request, in the page's words. */
  behavior: string;
  /** The same as a clause a report can follow "where" with. */
  says: string;
  /** What the page recommends instead. */
  instead: string;
  /** The value the field may still take (its default), when the page allows one: the request gets it in place of its own. */
  allowed?: Record<string, unknown>;
  /**
   * The rule covers a field only when its value is an object carrying these entries (`thinking` whose
   * `type` is `enabled`); without it, any value but the allowed one.
   */
  when?: Record<string, Record<string, unknown>>;
  source: string;
}

/** The table as the file holds it. */
export interface RetirementTable {
  /** The day the pages were read: the table holds what they said then. */
  version: string;
  about: string;
  platforms: Readonly<Record<RetirementPlatform, RetirementSource>>;
  models: readonly ModelRetirement[];
  fields: readonly FieldRetirement[];
}

let table: RetirementTable | null = null;

/** The table that ships with Shadowlap, read the first time it is needed. */
export function retirementTable(): RetirementTable {
  table ??= JSON.parse(readFileSync(new URL('../data/model-retirements.json', import.meta.url), 'utf8')) as RetirementTable;
  return table;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Which platform's dates apply to a call, by the provider Shadowlap recorded it through. */
export function retirementPlatform(provider: string | null | undefined): RetirementPlatform | null {
  return provider === 'anthropic' || provider === 'openai' || provider === 'gemini' || provider === 'vertex' || provider === 'bedrock' ? provider : null;
}

/**
 * A recorded model id as the table names it: Gemini's `models/` prefix and Vertex AI's publisher path
 * left out, and for Bedrock an inference profile's Region prefix (`us.`, `eu.`, `global.`…) and an
 * ARN's path, keeping the Region an ARN names.
 */
export function tableModel(platform: RetirementPlatform, model: string): { model: string; region: string | null } {
  let m = model.trim();
  let region: string | null = null;
  if (platform === 'bedrock') {
    const arn = /^arn:aws[\w-]*:bedrock:([a-z0-9-]*):[^:]*:(?:foundation-model|inference-profile|application-inference-profile)\/(.+)$/.exec(m);
    if (arn) {
      region = arn[1] || null;
      m = arn[2]!;
    }
    m = m.replace(/^(us|eu|apac|jp|au|ca|us-gov|global)\./, '');
  }
  if (platform === 'gemini' || platform === 'vertex') m = m.replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/[^/]+\/models\//, '').replace(/^models\//, '');
  return { model: m, region };
}

/** What a report says about a model that retires: the row, and the words. */
export interface RetirementNotice {
  provider: string;
  /** The model as the recording names it. */
  model: string;
  platform: RetirementPlatform;
  /** The row's model id, when the recording names an alias or a version of it (an Anthropic `claude-…-latest`). */
  matched: string;
  deprecated: string | null;
  retires: string | null;
  earliest: boolean;
  regions: readonly string[] | null;
  replacement: string | null;
  /** retired: its date has passed; retiring: it is set; deprecated: no date yet. */
  state: 'retired' | 'retiring' | 'deprecated';
  /** Days until it retires (negative once retired), or null without a date. */
  days: number | null;
  source: string;
  text: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-11-30` as a report writes it: `November 30, 2026`. */
export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

function rowsFor(platform: RetirementPlatform, model: string): ModelRetirement[] {
  const rows = retirementTable().models;
  const exact = rows.filter((r) => r.platform === platform && r.model === model);
  if (exact.length) return exact;
  if (platform === 'vertex') {
    // A version of a model Google's pages list by name: a Claude version after `@`
    // (`claude-3-7-sonnet@20250219`), a Gemini stable version (`gemini-2.0-flash-001`).
    const named = model.replace(/@[^@]+$/, '').replace(/^(gemini-.+)-\d{3}$/, '$1');
    return named === model ? [] : rows.filter((r) => r.platform === 'vertex' && r.model === named);
  }
  if (platform !== 'anthropic') return [];
  // An Anthropic alias (`claude-sonnet-4-5`, `claude-3-7-sonnet-latest`) names the one dated snapshot it points to.
  const base = model.replace(/-latest$/, '');
  const dated = rows.filter((r) => r.platform === 'anthropic' && new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(r.model));
  return dated.length === 1 ? dated : [];
}

/**
 * Whether a model a call was made with retires, by the table, as of `now`; null when the table has
 * nothing on it. `region` picks Bedrock's row for that Region, when known.
 */
export function retirementOf(provider: string | null | undefined, model: string | null | undefined, o: { now?: number; region?: string | null } = {}): RetirementNotice | null {
  const platform = retirementPlatform(provider);
  if (!platform || !model) return null;
  const { model: id, region: fromArn } = tableModel(platform, model);
  let rows = rowsFor(platform, id);
  if (!rows.length) return null;
  const region = o.region ?? fromArn;
  if (region && rows.some((r) => r.regions)) {
    const here = rows.filter((r) => r.regions?.includes(region));
    if (!here.length) return null;
    rows = here;
  }
  const now = o.now ?? Date.now();
  // The date that matters first: the soonest still to come, else the latest gone by, else none set.
  const future = rows.filter((r) => r.retires && dayMs(r.retires) > now).sort((a, b) => dayMs(a.retires!) - dayMs(b.retires!));
  const past = rows.filter((r) => r.retires && dayMs(r.retires) <= now).sort((a, b) => dayMs(b.retires!) - dayMs(a.retires!));
  const row = future[0] ?? past[0] ?? rows[0]!;
  const days = row.retires ? Math.ceil((dayMs(row.retires) - now) / 86_400_000) : null;
  const state = !row.retires ? 'deprecated' : days! <= 0 ? 'retired' : 'retiring';
  const where = retirementTable().platforms[platform];
  const named = row.model === id ? model : `${model} (${row.model})`;
  // Bedrock: the Regions of every row with that date, and the other dates with theirs.
  const regionsOn = (day: string | null) => [...new Set(rows.filter((r) => r.retires === day).flatMap((r) => r.regions ?? []))];
  const regions = row.regions ? regionsOn(row.retires) : null;
  const otherDays = [...new Set(rows.map((r) => r.retires).filter((d): d is string => !!d && d !== row.retires))].sort();
  const count = (n: number) => (n === 1 ? '1 Region' : `${n} Regions`);
  const inRegions = regions
    ? ` in ${regions.length === 1 ? regions[0] : count(regions.length)}${otherDays.length ? ` (${otherDays.map((d) => `${dayMs(d) <= now ? 'it reached it on' : 'and on'} ${longDate(d)} in ${count(regionsOn(d).length)}`).join(', ')})` : ''}`
    : '';
  const instead = row.replacement ? `; ${where.owner} recommends ${row.replacement}` : '';
  const text =
    state === 'deprecated'
      ? `${named} is deprecated on ${where.name}${row.deprecated ? ` since ${longDate(row.deprecated)}` : ''}, its retirement date to be announced${instead}`
      : state === 'retired'
        ? `${named} ${row.earliest ? 'may have shut down' : 'was retired'} on ${where.name} on ${longDate(row.retires!)}${inRegions}${row.earliest ? '' : ': requests to it fail'}${instead}`
        : row.earliest
          ? `${named} may shut down on ${where.name} from ${longDate(row.retires!)}, in ${days} day${days === 1 ? '' : 's'}: the earliest date ${where.owner} gives${instead}`
          : `${named} retires on ${where.name} on ${longDate(row.retires!)}${inRegions}, in ${days} day${days === 1 ? '' : 's'}${instead}`;
  return { provider: provider!, model, platform, matched: row.model, deprecated: row.deprecated ?? null, retires: row.retires, earliest: row.earliest === true, regions, replacement: row.replacement ?? null, state, days, source: row.source, text };
}

/** Every model among these that retires, each once, the soonest first. */
export function retirementsOf(models: Iterable<{ provider: string | null | undefined; model: string | null | undefined }>, o: { now?: number } = {}): RetirementNotice[] {
  const seen = new Map<string, RetirementNotice>();
  for (const { provider, model } of models) {
    const key = `${provider ?? ''}\u0000${model ?? ''}`;
    if (seen.has(key)) continue;
    const n = retirementOf(provider, model, o);
    if (n) seen.set(key, n);
  }
  const order = (n: RetirementNotice) => (n.days === null ? Number.MAX_SAFE_INTEGER : n.days);
  return [...seen.values()].sort((a, b) => order(a) - order(b) || a.model.localeCompare(b.model));
}

/**
 * The Claude model a Messages API body is sent to, as Anthropic names it, wherever it is served:
 * Bedrock's `anthropic.` prefix and version suffix (`anthropic.claude-sonnet-4-5-20250929-v1:0`) and
 * Vertex AI's `@` version left out. Null for a body that isn't a Messages API request to Claude.
 */
function claudeModel(provider: string | null | undefined, model: string, body: Record<string, unknown>): string | null {
  const platform = retirementPlatform(provider);
  if (platform === 'anthropic') return tableModel(platform, model).model;
  // On Bedrock and Vertex AI a Messages API body names its version; Converse and Gemini's don't.
  if ((platform === 'bedrock' || platform === 'vertex') && body.anthropic_version !== undefined) {
    const id = tableModel(platform, model).model.replace(/^anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '').replace(/@[^@]+$/, '');
    return id.startsWith('claude-') ? id : null;
  }
  return null;
}

const holds = (value: unknown, entries: Record<string, unknown>) => typeof value === 'object' && value !== null && Object.entries(entries).every(([k, v]) => (value as Record<string, unknown>)[k] === v);

/** Request fields the target model refuses, by the table: those a request sets, with what the page says. */
export function retiredFields(provider: string | null | undefined, model: string, body: unknown): Array<{ field: string; value: unknown; rule: FieldRetirement }> {
  const platform = retirementPlatform(provider);
  if (!platform || typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const fields = body as Record<string, unknown>;
  const out: Array<{ field: string; value: unknown; rule: FieldRetirement }> = [];
  for (const rule of retirementTable().fields) {
    const id = rule.platform === 'anthropic' ? claudeModel(provider, model, fields) : rule.platform === platform ? tableModel(platform, model).model : null;
    if (id === null || !rule.models.some((m) => id === m || id.startsWith(`${m}-`))) continue;
    for (const field of rule.fields) {
      const value = fields[field];
      if (value === undefined || (rule.allowed && field in rule.allowed && canonicalize(rule.allowed[field]) === canonicalize(value))) continue;
      if (rule.when?.[field] && !holds(value, rule.when[field]!)) continue;
      out.push({ field, value, rule });
    }
  }
  return out;
}

const PLATFORMS: readonly RetirementPlatform[] = ['anthropic', 'openai', 'gemini', 'vertex', 'bedrock'];

/** The table's own checks, for its test: every platform named, every row dated and sourced, every rule complete. */
export function retirementTableProblems(t: RetirementTable = retirementTable()): string[] {
  const problems: string[] = [];
  const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  if (!isDate(t.version)) problems.push('version is not the date the pages were read');
  for (const p of PLATFORMS) {
    const s = t.platforms[p];
    if (!s || !text(s.name) || !text(s.owner) || !text(s.keeps) || !Array.isArray(s.pages) || !s.pages.includes(s.url)) problems.push(`${p}: its name, owner, pages or what the table keeps from them is missing`);
  }
  const pages = new Set(Object.values(t.platforms).flatMap((s) => s.pages));
  for (const page of pages) if (!/^https:\/\/[^\s]+$/.test(page)) problems.push(`${page}: not a page's address`);
  for (const r of t.models) {
    const at = `${r.platform} ${r.model}`;
    if (!PLATFORMS.includes(r.platform) || !text(r.model)) problems.push(`${at}: a row needs a platform and a model`);
    if (!pages.has(r.source)) problems.push(`${at}: its source is not one of the platforms' pages`);
    if (r.retires !== null && !isDate(r.retires)) problems.push(`${at}: retires is not a date`);
    if (r.deprecated !== undefined && !isDate(r.deprecated)) problems.push(`${at}: deprecated is not a date`);
    if (r.deprecated && r.retires && r.deprecated > r.retires) problems.push(`${at}: deprecated after it retires`);
    if (r.earliest !== undefined && r.earliest !== true) problems.push(`${at}: earliest is true or left out`);
    if (r.replacement !== undefined && !text(r.replacement)) problems.push(`${at}: an empty replacement`);
    if (r.platform === 'bedrock' && !r.regions?.length) problems.push(`${at}: a Bedrock date needs its Regions`);
  }
  for (const f of t.fields) {
    const at = `the ${f.fields.join(', ')} rule`;
    if (!PLATFORMS.includes(f.platform) || !f.fields.length || !f.models.length) problems.push(`${at}: it needs a platform, fields and models`);
    if (![f.appliesTo, f.behavior, f.says, f.instead].every(text)) problems.push(`${at}: it needs the page's words`);
    if (!pages.has(f.source)) problems.push(`${at}: its source is not one of the platforms' pages`);
  }
  return problems;
}
