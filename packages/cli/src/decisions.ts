import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyNormalizers,
  byConsequence,
  CONTROL_MIN_SAMPLES,
  CONTROL_RISK,
  rankBeyondNoise,
  commandIsImported,
  compareDecisions,
  controlOpen,
  decisionOfResponse,
  decisionView,
  effectsOf,
  emptyCounts,
  estimateCost,
  estimatedTokens,
  hasRecordedCommand,
  isReservedScope,
  JUDGED_IN_RECORDED_STATE,
  judgeOpen,
  loadApiRequest,
  majorityRank,
  modelFamily,
  NO_TOKENS,
  outcomeOf,
  placeFields,
  promoteByJudge,
  promptOf,
  promptParts,
  quoteArgv,
  recordEvent,
  refused,
  requestShape,
  resolveAuthor,
  retiredFields,
  retirementOf,
  retirementsOf,
  retirementTable,
  rewriteText,
  sameModel,
  setRequestFields,
  shownSample,
  unjudgedSample,
  unavailableStatus,
  describeBaselineRule,
  describeGate,
  dropBound,
  SPRT_DEFAULTS,
  switchModel,
  ulid,
  withoutEarlierThinking,
  withPrompt,
  type CallRecord,
  type DecisionChange,
  type DecisionCounts,
  type DecisionJudge,
  type DecisionRank,
  type DecisionRemedy,
  type DecisionRun,
  type DecisionsChange,
  type DecisionsReport,
  type DecisionStep,
  type DecisionsVerify,
  type DecisionView,
  type Effect,
  type FromCodeChange,
  type ModelDecision,
  type Normalizer,
  type Price,
  type RequestPrompt,
  type RetirementNotice,
  type RunRecord,
  type SprtGate,
  type Store,
  type TokenCount,
  type Usage,
  type VerifyRole,
  rateBound,
} from '@shadowlap/engine';
import { STOP_SIGNALS } from './agent-signals.js';
import { judgeRecording } from './attempts.js';
import { specFor, type TestSpec } from './checks.js';
import { codeVersion, loadConfig, loadTests, upstreamOverrides, type ShadowlapConfig } from './config.js';
import { captureFromCode, type FromCodeCapture } from './decisions-capture.js';
import { TextJudge } from './decisions-judge.js';
import { azureApiVersion, azureDeploymentCall, ModelSender, providerById, type ModelAnswer } from './decisions-send.js';
import { gateFlags, recordVerifyFix, verifyCommand } from './fixes.js';
import { importGolden } from './golden-test.js';
import { expandRecordings, goldenName, rawExpectFor } from './goldens.js';
import { checksOfRun } from './interventions.js';
import { signalExit } from './exit-codes.js';
import { cannotJudge } from './judge.js';
import { type GuardMode } from './run-agent.js';
import { openStore, requireRun, type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';
import { runVerify } from './verify.js';

/**
 * `shadowlap decisions`: what a change decides differently on recorded runs, without running the
 * agent. Each recorded model call is asked again: its request exactly as recorded, with only what
 * the change touches swapped in (the model, request fields, or the prompt and tools the working tree
 * sends now), sent through the sidecar's upstreams. Its answer's decision is compared with the
 * recorded one and ranked by consequence (engine decisions.ts); a text-only change that a judge check
 * of the run reads is judged (decisions-judge.ts), and one it reads otherwise ranks with a changed
 * stop. No tool runs, and a step doesn't depend on the one before, so the steps go in parallel.
 * `--then-verify` hands the runs with a write, stop or judged change to `shadowlap verify`, the
 * end-to-end check, and only those.
 *
 * A model switch changes the agent's calls, not every call a recording holds: those made with the
 * models `--from` names, else (decisions) the one the runs use most, or (migrate) the ones that
 * retire. A simulated user, a sub-agent on another model, and Shadowlap's own judge keep theirs.
 */

/** A run to ask again, and where it came from: a golden's pack, or the store. */
export interface DecisionTarget {
  run: RunRecord;
  /** The golden's name, as `shadowlap test` names it, or null for a run from the store. */
  golden: string | null;
  /**
   * The checks it is judged by, from the config: a golden's tests entry, or for a run from the store
   * the entry of the recording it comes from (checksOfRun). What verifies it, and what judges its
   * text-only changes.
   */
  spec: TestSpec | null;
  expect: Record<string, unknown> | null;
}

export class DecisionsError extends Error {}

/**
 * A run from the store as a target: its checks are those of the tests entry the recording it comes
 * from has (a golden `shadowlap test` replayed, the pack it was unpacked from), as a replay of it
 * finds them; none when no entry names it.
 */
export function storeTarget(store: Store, run: RunRecord, cwd: string): DecisionTarget {
  const own = checksOfRun(store, run, cwd);
  if (!own) return { run, golden: null, spec: null, expect: null };
  let expect: Record<string, unknown> | null = null;
  try {
    expect = rawExpectFor(loadTests(cwd), own.source, cwd);
  } catch {
    // the config read for the checks a moment ago: what it says of them is what verify is told
  }
  return { run, golden: null, spec: own.spec, expect };
}

/** Runs and goldens as given: run ids or prefixes, `label:<name>`, and pack folders (`goldens/*`). */
export function resolveTargets(store: Store, specs: readonly string[], cwd: string): DecisionTarget[] {
  const out = new Map<string, DecisionTarget>();
  let tests: ReturnType<typeof loadTests> = [];
  try {
    tests = loadTests(cwd);
  } catch {
    // checks the config can't give: the goldens are asked again all the same
  }
  for (const spec of specs) {
    if (spec.startsWith('label:')) {
      const label = spec.slice('label:'.length);
      const runs = store.allRuns().filter((r) => r.meta?.labels?.includes(label));
      if (!runs.length) throw new DecisionsError(`${spec}: no run has the label "${label}" (see shadowlap ls --label ${label})`);
      for (const run of runs) if (!out.has(run.runId)) out.set(run.runId, storeTarget(store, run, cwd));
      continue;
    }
    const path = /[\\/*?]/.test(spec) || existsSync(join(resolve(cwd, spec), 'run.json'));
    if (!path) {
      const run = requireRun(store, spec);
      if (!out.has(run.runId)) out.set(run.runId, storeTarget(store, run, cwd));
      continue;
    }
    const { dirs, unmatched } = expandRecordings([spec], cwd);
    if (unmatched.length) throw new DecisionsError(`${spec}: no pack matches (a golden is a folder with a run.json, such as goldens/refund-flow)`);
    for (const dir of dirs) {
      const abs = resolve(cwd, dir);
      if (!existsSync(join(abs, 'run.json'))) throw new DecisionsError(`${dir} is not a pack: it has no run.json`);
      let run: RunRecord;
      try {
        run = importGolden(store, abs);
      } catch (err) {
        throw new DecisionsError(`${dir}: ${(err as Error).message}`);
      }
      if (!out.has(run.runId)) out.set(run.runId, { run, golden: goldenName(dir, cwd), spec: specFor(tests, abs, cwd), expect: rawExpectFor(tests, abs, cwd) });
    }
  }
  return [...out.values()];
}

export interface DecisionsSettings {
  model: string | null;
  fields: Record<string, unknown>;
  /** `--from`: the recorded models the model and the fields change at. Null takes the default (defaultFrom). */
  from: string[] | null;
  fromCode: boolean;
  /** Times each step is asked. */
  samples: number;
  /**
   * Ask each step as recorded as often, the control arm, and rank a step only when the change decides
   * it otherwise beyond that variation (engine control-arm.ts). Absent: from 3 samples on, the fewest
   * for which any difference can reach the test's 5%.
   */
  control?: boolean;
  /** Requests in flight at once. */
  concurrency: number;
  /** Start no request once this much (USD) is spent. */
  budget: number | null;
  /** Stop a request after this long (and with --then-verify, an attempt). */
  timeoutMs: number | null;
  /** Only model calls made in this scope; `none`, only those made in none. */
  scope: string | null;
  /**
   * `migrate`: change the fields the new model refuses so it takes the requests, by the retirement
   * table and by its own refusals, and say so (`remedies` in the report). `decisions` sends the change
   * as given.
   */
  remedies: boolean;
  guard: GuardMode;
  /** The command to run instead of each run's recorded one, for --from-code and --then-verify. */
  argv: string[] | null;
  /**
   * --then-verify: verify the runs with a rank 1 or 2 change, with these: each run's gate, as verify
   * decides by default (`attempts` is then its `max`), or with `gate` null a fixed count, `needed` of
   * `attempts`.
   */
  thenVerify: { attempts: number; needed: number; gate: SprtGate | null; writes: 'stub' | 'block'; expect: { spec: TestSpec; json: unknown } | null } | null;
}

export interface DecisionsInput {
  opts: GlobalOpts;
  targets: DecisionTarget[];
  settings: DecisionsSettings;
  /** The command that asks the same way again, as reports show it. */
  command: string;
  log: (line: string) => void;
  /** For tests: the sender's environment. */
  env?: NodeJS.ProcessEnv;
  now?: number;
  kind?: 'decisions' | 'migrate';
}

/** What a refusal or the retirement table changes in a request: a field set to a value, or sent under another name. */
export type FieldFix = { field: string; value: unknown } | { field: string; renamedTo: string };

/** One request to make, for one recorded model call. */
interface Planned {
  target: DecisionTarget;
  call: CallRecord;
  step: number;
  provider: string;
  method: string;
  path: string;
  query: string | undefined;
  headers: Record<string, string>;
  /**
   * Makes the request to send. It is made each time it is sent and let go once answered, so only the
   * requests in flight are held, never a suite's. It throws only if the recording changed under it.
   */
  build: () => unknown;
  /** Makes the request as recorded, for the control arm. */
  buildControl: () => unknown;
  /** The fields a refusal named that were changed in this step's requests, so each is said once per step. */
  fixed: Set<string>;
  /** The request carries cache breakpoints, as the agent placed them. */
  cacheControl: boolean;
  recorded: ModelDecision;
  recordedModel: string | null;
  askedModel: string | null;
  recordedUsage: Usage | null;
  thinkingStripped: number;
  effectOf: (tool: string) => Effect | null;
  opts: { normalizers: Normalizer[]; clock?: number[] };
  answers: Array<{ answer: ModelAnswer; decision: ModelDecision | null }>;
  /** The judge checks that read a text-only answer's words, by the answer's place in `answers`. */
  judged: Map<number, DecisionJudge[]>;
  /** The path the call was recorded on: a model switch can change the one the change is sent to. */
  recordedPath: string;
  /** The control arm: the request exactly as recorded, asked as often as the change, and its judged text, by place. */
  controlAnswers: Array<{ answer: ModelAnswer; decision: ModelDecision | null }>;
  controlJudged: Map<number, DecisionJudge[]>;
  /** Why it is not asked; null when it is. */
  skip: string | null;
  /** The change doesn't touch this request: the working tree sends it the same prompt, or it was made with a model the switch leaves. */
  untouched: boolean;
  /** The model and the fields change here: it was made with a model they change from. */
  switched: boolean;
  /** `decisions --model`: the fields the provider's pages say the new model refuses here, and what it takes instead (migrate's changes, not made). */
  takes: Array<{ field: string; value: unknown; leftOut: boolean; renamedTo: string | null }>;
}

const tokensOf = (u: Usage | null | undefined): TokenCount | null => (u ? { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 } : null);
const usageOf = (t: TokenCount): Usage => ({ inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheWrite });
const addTokens = (a: TokenCount, b: TokenCount | null): TokenCount => (b ? { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite } : a);
const recordedModelOf = (call: CallRecord): string | null => (call.end?.meta.model ?? call.meta.model ?? null);
const fieldText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** The fields `migrate` changed, each once, with the steps that needed it. */
class Remedies {
  private readonly byKey = new Map<string, DecisionRemedy>();
  note(r: Omit<DecisionRemedy, 'steps'>): void {
    const key = `${r.field}\u0000${JSON.stringify(r.value)}\u0000${r.leftOut}\u0000${r.renamedTo ?? ''}`;
    const had = this.byKey.get(key);
    if (had) had.steps++;
    else this.byKey.set(key, { ...r, steps: 1 });
  }
  list(): DecisionRemedy[] {
    return [...this.byKey.values()];
  }
}

/**
 * What a provider's refusal says to change, when it says it plainly: Anthropic's `max_tokens: 64000
 * > 32000` and `"thinking.type.enabled" is not supported` (the model thinks adaptively, its extended
 * thinking page says), OpenAI's `supports at most 16384 completion tokens`, `Only the default (1)
 * value is supported` and `'max_tokens' is not supported with this model. Use 'max_completion_tokens'
 * instead`. Null when it says nothing a field can fix.
 */
export function refusalRemedy(error: string): FieldFix | null {
  const over = /\bmax_tokens:\s*\d+\s*>\s*(\d+)/.exec(error) ?? /at most (\d+) (?:completion|output) tokens/i.exec(error);
  if (over) return { field: 'max_tokens', value: Number(over[1]) };
  if (/"?thinking\.type\.enabled"? is not supported/.test(error)) return { field: 'thinking', value: { type: 'adaptive' } };
  const renamed = /'(\w+)' is not supported with this model\. Use '(\w+)' instead/.exec(error);
  if (renamed && renamed[1] !== renamed[2]) return { field: renamed[1]!, renamedTo: renamed[2]! };
  const only = /'(\w+)' does not support .*?\. Only the default \(([^)]+)\) value is supported/.exec(error);
  if (only) {
    let value: unknown = only[2];
    try {
      value = JSON.parse(only[2]!);
    } catch {
      // a word
    }
    return { field: only[1]!, value };
  }
  return null;
}

/** The request with these fields left out, wherever its shape keeps them. */
export function withoutFields(provider: string | null, path: string, body: unknown, fields: readonly string[]): unknown {
  if (!fields.length || typeof body !== 'object' || body === null) return body;
  const shape = requestShape(provider, path, body);
  const placed = placeFields(shape, Object.fromEntries(fields.map((f) => [f, null])));
  if (refused(placed)) return body;
  const out = structuredClone(body) as Record<string, unknown>;
  for (const { path: at } of placed) {
    let node: unknown = out;
    for (const key of at.slice(0, -1)) node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined;
    if (typeof node === 'object' && node !== null) delete (node as Record<string, unknown>)[at.at(-1)!];
  }
  return out;
}

/**
 * The request with a field sent under another name, with its value, where Chat Completions keeps
 * both at its top (OpenAI's `max_tokens`, `max_completion_tokens`). Any other shape, a request
 * without the field or one that sends both, as it is.
 */
export function renameField(provider: string | null, path: string, body: unknown, from: string, to: string): unknown {
  if (requestShape(provider, path, body) !== 'openai-chat' || typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;
  if (b[from] === undefined || b[to] !== undefined) return body;
  const { [from]: value, ...rest } = b;
  return { ...rest, [to]: value };
}

/** A field's value where the request's shape keeps it, or undefined. */
function fieldAt(provider: string | null, path: string, body: unknown, field: string): unknown {
  const placed = placeFields(requestShape(provider, path, body), { [field]: null });
  if (refused(placed) || !placed[0]) return undefined;
  let node: unknown = body;
  for (const key of placed[0].path) node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined;
  return node;
}

/** The thinking budget a request gives, wherever its shape keeps it (Messages API, Converse's model fields), or null. */
function thinkingBudget(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const extra = (typeof b.additionalModelRequestFields === 'object' && b.additionalModelRequestFields !== null ? b.additionalModelRequestFields : {}) as Record<string, unknown>;
  for (const t of [b.thinking, extra.thinking, extra.reasoning_config]) {
    const budget = typeof t === 'object' && t !== null ? (t as { budget_tokens?: unknown }).budget_tokens : undefined;
    if (typeof budget === 'number') return budget;
  }
  return null;
}

const LIMITS = new Set(['max_tokens', 'max_completion_tokens', 'max_output_tokens']);

/**
 * A fix a refusal named, as one request takes it: an output limit only lowers a request above it,
 * and never under the request's thinking budget (which must stay below it); a field another name
 * replaces moves to it; any other field is set. Null when the request needs no change, or can't take it.
 */
export function applyFix(provider: string, path: string, body: unknown, fix: FieldFix): { body: unknown } | null {
  if ('renamedTo' in fix) {
    const next = renameField(provider, path, body, fix.field, fix.renamedTo);
    return next === body ? null : { body: next };
  }
  if (LIMITS.has(fix.field) && typeof fix.value === 'number') {
    const current = fieldAt(provider, path, body, fix.field) ?? (typeof body === 'object' && body !== null ? (body as Record<string, unknown>).max_completion_tokens : undefined);
    if (typeof current !== 'number' || current <= fix.value) return null;
    const budget = thinkingBudget(body);
    if (budget !== null && budget >= fix.value) return null;
  }
  const set = setRequestFields(requestShape(provider, path, body), body, { [fix.field]: fix.value });
  return refused(set) || !set.changed ? null : { body: set.body };
}

/** The change in words, for reports and the store. */
export function changeText(s: Pick<DecisionsSettings, 'model' | 'fields' | 'fromCode'>): string {
  const parts: string[] = [];
  if (s.fromCode) parts.push('the prompt and tools in the working tree');
  if (s.model) parts.push(`the model ${s.model}`);
  const fields = Object.entries(s.fields).filter(([k]) => k !== 'model');
  if (fields.length) parts.push(fields.map(([k, v]) => `${k}=${fieldText(v)}`).join(', '));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}` : (parts[0] ?? 'no change');
}

/** Whether a model call is one `--scope` asks: made in that scope, or with `none`, in none. Shadowlap's own scopes (its judge's) never are. */
export function inScope(callScope: unknown, scope: string | null): boolean {
  if (isReservedScope(callScope)) return false;
  if (scope === null) return true;
  const s = typeof callScope === 'string' && callScope ? callScope : null;
  return scope === 'none' ? s === null : s === scope;
}

/** The models the runs' model calls were made with (the agent's: Shadowlap's own scopes left out, and other scopes than `scope`), with how many calls each: most used first. */
export function modelUse(store: Store, targets: readonly DecisionTarget[], scope: string | null): Array<{ model: string; provider: string | null; calls: number }> {
  const use = new Map<string, { model: string; provider: string | null; calls: number }>();
  for (const t of targets) {
    for (const c of store.getCalls(t.run.runId)) {
      if (c.kind !== 'api' || !c.requestRef || !inScope(c.meta.scope, scope)) continue;
      const model = recordedModelOf(c);
      if (!model) continue;
      const had = use.get(model) ?? { model, provider: (c.meta.provider ?? c.end?.meta.provider ?? null), calls: 0 };
      had.calls++;
      use.set(model, had);
    }
  }
  return [...use.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

/**
 * The recorded models a switch changes when `--from` names none: for `migrate`, those the retirement
 * table says retire (as of `now`), else the one the runs use most; for `decisions`, the one they use
 * most. Null when the runs name no model.
 */
export function defaultFrom(use: ReturnType<typeof modelUse>, kind: 'decisions' | 'migrate', to: string | null, now: number): { models: string[]; why: 'retire' | 'most' } | null {
  if (!use.length) return null;
  if (kind === 'migrate') {
    const retiring = use.filter((u) => !(to && sameModel(u.model, to)) && retirementOf(u.provider, u.model, { now }) !== null).map((u) => u.model);
    if (retiring.length) return { models: retiring, why: 'retire' };
  }
  return { models: [use[0]!.model], why: 'most' };
}

/** What the report may carry of a run's values: the project's redaction rules applied, as to every export, pack and share link of a run. */
export interface Mask {
  args: (tool: string, args: unknown) => unknown;
  text: (text: string) => string;
}

const NO_MASK: Mask = { args: (_tool, args) => args, text: (text) => text };

/**
 * The redaction rules as the report applies them: to a tool call's arguments, as to a tool call a copy
 * keeps (a rule scoped to the tool, its `$.args…` paths), and every rule without a path, whatever its
 * kind, since the arguments were a model's answer too; to text, every rule without a path.
 */
export function masking(rules: readonly Normalizer[]): Mask {
  if (!rules.length) return NO_MASK;
  const pathless: Normalizer[] = rules.filter((r) => r.path === undefined && r.pattern !== undefined).map((r) => ({ pattern: r.pattern!, replace: r.replace }));
  return {
    args: (tool, args) => (applyNormalizers(applyNormalizers({ args }, [...rules], 'tool', tool), pathless, 'tool', tool) as { args: unknown }).args,
    text: (text) => rewriteText(text, pathless),
  };
}

const maskView = (v: DecisionView, m: Mask): DecisionView => (m === NO_MASK ? v : { ...v, tools: v.tools.map((t) => ({ ...t, args: m.args(t.name, t.args) })), text: m.text(v.text) });

function maskChange(c: DecisionChange, m: Mask): DecisionChange {
  if (m === NO_MASK) return c;
  if (c.kind === 'text') return { ...c, before: typeof c.before === 'string' ? m.text(c.before) : c.before, after: typeof c.after === 'string' ? m.text(c.after) : c.after };
  if (c.tool && /^(write|read)-(added|removed|arguments)$/.test(c.kind)) return { ...c, before: c.before === null ? null : m.args(c.tool, c.before), after: c.after === null ? null : m.args(c.tool, c.after) };
  return c;
}

/** What the working tree sends against the recording, for the report's change. */
function fromCodeChange(captures: Map<string, FromCodeCapture>, store: Store, planned: Planned[], version: string | null, m: Mask): FromCodeChange {
  let instructions: FromCodeChange['instructions'] = null;
  const tools = { added: new Set<string>(), removed: new Set<string>(), changed: new Set<string>() };
  let calls = 0;
  for (const s of planned) {
    const cap = captures.get(s.target.run.runId)?.prompts.get(s.call.callNo);
    if (!cap?.changed) continue;
    calls++;
    const before = promptOf(loadApiRequest(store, s.call.requestRef!));
    const a = promptParts(before);
    const b = promptParts(cap.prompt);
    if (!instructions && a.instructions !== b.instructions) instructions = { before: m.text(a.instructions), after: m.text(b.instructions) };
    for (const t of b.tools) if (!a.tools.includes(t)) tools.added.add(t);
    for (const t of a.tools) if (!b.tools.includes(t)) tools.removed.add(t);
    const defs = (pr: typeof before) => new Map((Array.isArray(pr.fields.tools) ? pr.fields.tools : []).map((t: unknown) => [JSON.stringify((t as { name?: unknown; function?: { name?: unknown } })?.name ?? (t as { function?: { name?: unknown } })?.function?.name ?? null), JSON.stringify(t)]));
    const da = defs(before);
    for (const [name, def] of defs(cap.prompt)) if (da.has(name) && da.get(name) !== def) tools.changed.add(JSON.parse(name) as string);
  }
  return { calls, instructions, tools: { added: [...tools.added], removed: [...tools.removed], changed: [...tools.changed] }, codeVersion: version };
}

const FAMILY_NAMES = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini' } as const;

/** Plans the request for each recorded model call of a run: the recorded one with only the change swapped in. */
function planRun(store: Store, target: DecisionTarget, s: DecisionsSettings, from: string[] | null, capture: FromCodeCapture | null, batchEffects: Map<string, Effect>, config: ShadowlapConfig, remedies: Remedies, env: NodeJS.ProcessEnv): Planned[] {
  const calls = store.getCalls(target.run.runId);
  const runEffects = effectsOf(calls);
  // What each tool does: what the config declares today first, then the run's own calls, the other
  // runs asked with it, and every run in the store (batchEffects); a tool none of them names is a write.
  const declared = (config.mcp?.effects ?? {}) as Record<string, Effect | undefined>;
  const effectOf = (tool: string): Effect | null => declared[tool] ?? runEffects.get(tool) ?? batchEffects.get(tool) ?? null;
  const normalizers = [...config.normalize, ...(target.run.meta?.redactions ?? [])];
  const opts = { normalizers, ...(config.clock === 'exact' ? {} : { clock: [target.run.startedAt, Date.now()] }) };
  const out: Planned[] = [];
  let step = 0;
  for (const call of calls) {
    if (call.kind !== 'api' || !call.requestRef) continue;
    // Shadowlap's own calls (its judge's) are none of the agent's decisions, and no step of its run.
    if (isReservedScope(call.meta.scope)) continue;
    step++;
    if (!inScope(call.meta.scope, s.scope)) continue;
    const provider = (call.meta.provider ?? call.end?.meta.provider ?? null);
    const space = call.name.indexOf(' ');
    const method = space > 0 ? call.name.slice(0, space) : 'POST';
    const path = space > 0 ? call.name.slice(space + 1) : call.name;
    const end = call.end;
    const contentType = end?.meta.headers?.['content-type'];
    const bytes = end?.responseRef ? store.getBlob(end.responseRef) : null;
    const recorded = decisionOfResponse(bytes, contentType, provider ?? undefined, opts, end?.meta.chunks ?? []);
    const recordedModel = recordedModelOf(call);
    // The model and the fields change at the calls made with a model they change from.
    const switched = !from || from.some((m) => sameModel(recordedModel, m));
    const plan: Planned = {
      target,
      call,
      step,
      provider: provider ?? '',
      method,
      path,
      // The query the agent sent, as the recording keeps it (Azure's api-version, Gemini's alt=sse).
      query: typeof call.meta.query === 'string' && call.meta.query ? call.meta.query : undefined,
      headers: { ...((call.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {}) },
      build: () => null,
      buildControl: () => null,
      fixed: new Set(),
      cacheControl: false,
      recorded,
      recordedModel,
      askedModel: null,
      recordedUsage: end?.meta.usage ?? null,
      thinkingStripped: 0,
      effectOf,
      opts,
      answers: [],
      judged: new Map(),
      recordedPath: path,
      controlAnswers: [],
      controlJudged: new Map(),
      skip: null,
      untouched: false,
      switched,
      takes: [],
    };
    out.push(plan);
    if (!end || end.outcome !== 'ok' || !bytes) {
      plan.skip = 'the recording has no answer to compare with (the call failed when it was recorded)';
      continue;
    }
    const module = providerById(provider);
    if (!module) {
      plan.skip = `it was recorded through ${provider ?? 'no known provider'}, which Shadowlap can't send to`;
      continue;
    }
    const cap = s.fromCode ? capture?.prompts.get(call.callNo) : undefined;
    if (s.fromCode && !cap) {
      plan.skip = 'the offline replay of the working tree never sent it, so its new prompt is unknown';
      continue;
    }
    // A model the switch leaves, with no new prompt either: the change doesn't touch it.
    if (!switched && !cap?.changed) {
      plan.untouched = true;
      continue;
    }
    if (s.model && switched) {
      const was = modelFamily(recordedModel);
      const now = modelFamily(s.model);
      if (was && now && was !== now) {
        plan.skip = `${s.model} is a model of another family than ${recordedModel!} (${FAMILY_NAMES[now]}, not ${FAMILY_NAMES[was]}): asking the recorded request again can't carry it into that family's request format, so verify that switch instead`;
        continue;
      }
    }
    /**
     * The request with the change swapped in, and what changed; `note` keeps what migrate changed in
     * the report, which only the first build does.
     */
    const make = (note: boolean): { body: unknown; path: string; promptChanged: boolean; modelChanged: boolean; fieldsChanged: boolean; thinking: number } | { skip: string } => {
      let body = loadApiRequest(store, call.requestRef!);
      if (requestShape(provider, path, body) === 'other') return { skip: "it is not a conversation (an embeddings call, or a model's native body)" };
      const promptChanged = cap?.changed === true;
      if (promptChanged) body = withPrompt(body, cap.prompt);
      let at = path;
      let modelChanged = false;
      if (s.model && switched) {
        const sw = switchModel(provider, at, body, s.model);
        if (refused(sw)) return { skip: `--model: ${sw.refused}` };
        at = sw.path;
        body = sw.body;
        modelChanged = sw.changed;
      }
      const fields = Object.fromEntries(Object.entries(s.fields).filter(([k]) => k !== 'model'));
      let fieldsChanged = false;
      if (switched && Object.keys(fields).length) {
        const set = setRequestFields(requestShape(provider, at, body), body, fields);
        if (refused(set)) return { skip: `--set: ${set.refused}` };
        body = set.body;
        fieldsChanged = set.changed;
      }
      if (switched && s.model) {
        // What the provider's page says the new model refuses: migrate sends what it takes instead
        // (a value it allows, the field left out, or the field under its new name); decisions keeps it to say.
        const model = module.extractModel(at, body) ?? s.model;
        for (const f of retiredFields(provider, model, body)) {
          const renamedTo = f.rule.renamed?.[f.field] ?? null;
          const allowed = renamedTo ? undefined : f.rule.allowed?.[f.field];
          const leftOut = renamedTo !== null || f.rule.leaveOut === true || allowed === undefined;
          if (!s.remedies) {
            if (note) plan.takes.push({ field: f.field, value: allowed ?? null, leftOut, renamedTo });
            continue;
          }
          if (renamedTo) body = renameField(provider, at, body, f.field, renamedTo);
          else if (allowed !== undefined) {
            const set = setRequestFields(requestShape(provider, at, body), body, { [f.field]: allowed });
            if (!refused(set)) body = set.body;
          } else body = withoutFields(provider, at, body, [f.field]);
          const why = `${model} is among ${f.rule.appliesTo}, where ${f.rule.says} (${retirementTable().platforms[f.rule.platform].owner}); the requests send ${f.field}=${JSON.stringify(f.value)}. ${f.rule.instead}`;
          if (note) remedies.note({ field: f.field, value: allowed ?? null, leftOut, renamedTo, why, source: f.rule.source });
          fieldsChanged = true;
        }
      }
      // Reasoning from earlier turns is tied to the prompt it was made under. A new model gets it as the
      // agent would send it after the switch: Anthropic drops, unbilled, the blocks a model can't read.
      let thinking = 0;
      if (promptChanged) {
        const stripped = withoutEarlierThinking(body);
        body = stripped.body;
        thinking = stripped.removed;
      }
      return { body, path: at, promptChanged, modelChanged, fieldsChanged, thinking };
    };
    const first = make(true);
    if ('skip' in first) {
      plan.skip = first.skip;
      continue;
    }
    if (s.fromCode && !first.promptChanged && !first.modelChanged && !first.fieldsChanged) {
      plan.untouched = true;
      continue;
    }
    plan.path = first.path;
    plan.thinkingStripped = first.thinking;
    plan.askedModel = module.extractModel(first.path, first.body);
    plan.cacheControl = JSON.stringify(first.body).includes('"cache_control"');
    plan.build = () => {
      const again = make(false);
      if ('skip' in again) throw new Error(again.skip);
      return again.body;
    };
    // The control arm asks the request as the agent sent it: no change, nothing left out.
    plan.buildControl = () => loadApiRequest(store, call.requestRef!);
    // A recording made before calls kept their query: Gemini streams as server-sent events when asked
    // with alt=sse, as its SDKs ask; an Azure deployment takes the api-version the SDKs read from the environment.
    if (plan.query === undefined) {
      const version = azureApiVersion(env);
      if (/:streamGenerateContent$/.test(first.path) && contentType?.includes('text/event-stream')) plan.query = 'alt=sse';
      else if (azureDeploymentCall(plan.provider, first.path) && version) plan.query = `api-version=${encodeURIComponent(version)}`;
    }
  }
  return out;
}

/**
 * Asks every planned request, `samples` times each, `concurrency` at once. A run whose requests carry
 * cache breakpoints is asked one request at a time, its steps in order, as the agent asked them: each
 * step can read the prefix the one before it cached. Runs go side by side.
 */
async function askAll(planned: Planned[], s: DecisionsSettings, sender: ModelSender, prices: Record<string, Price> | undefined, log: (line: string) => void, stop: () => string | null, remedies: Remedies): Promise<{ spent: number; upstreamRequests: number; unknownModels: Set<string>; stopReason: string | null }> {
  // A step's samples side by side: after the first, they read what it cached. With the control arm,
  // each sample of the change goes with one of the request as recorded, so both see the same moment.
  const control = controlAsked(s);
  type Ask = { plan: Planned; arm: 'changed' | 'control'; cacheControl: boolean; target: DecisionTarget };
  const queue: Ask[] = [];
  for (const plan of planned) {
    if (plan.skip || plan.untouched) continue;
    for (let i = 0; i < s.samples; i++) {
      queue.push({ plan, arm: 'changed', cacheControl: plan.cacheControl, target: plan.target });
      if (control) queue.push({ plan, arm: 'control', cacheControl: plan.cacheControl, target: plan.target });
    }
  }
  const total = queue.length;
  let spent = 0;
  let upstreamRequests = 0;
  const unknownModels = new Set<string>();
  let stopReason: string | null = null;
  let done = 0;
  const busy = new Set<DecisionTarget>();
  const waiting: Array<() => void> = [];
  const wake = () => {
    for (const w of waiting.splice(0)) w();
  };
  const take = (): Ask | 'wait' | null => {
    for (let i = 0; i < queue.length; i++) {
      const ask = queue[i]!;
      if (ask.cacheControl && busy.has(ask.target)) continue;
      queue.splice(i, 1);
      return ask;
    }
    return queue.length ? 'wait' : null;
  };
  // migrate: what a refusal named, changed in the requests after it to the same model through the same
  // provider, so each is refused once at most; a request that doesn't need it is left as it is.
  const learned = new Map<string, Map<string, { fix: FieldFix; why: string }>>();
  const keyOf = (plan: Planned) => `${plan.provider}\u0000${plan.askedModel ?? ''}`;
  const apply = (plan: Planned, body: unknown, fix: FieldFix, why: string): { body: unknown } | null => {
    const changed = applyFix(plan.provider, plan.path, body, fix);
    if (!changed) return null;
    if (!plan.fixed.has(fix.field)) {
      plan.fixed.add(fix.field);
      remedies.note('renamedTo' in fix ? { field: fix.field, value: null, leftOut: true, renamedTo: fix.renamedTo, why, source: null } : { field: fix.field, value: fix.value, leftOut: false, renamedTo: null, why, source: null });
    }
    return changed;
  };
  /** The request exactly as recorded, on the path it was recorded on: the control arm's. */
  const askRecorded = async (plan: Planned) => {
    let body: unknown;
    try {
      body = plan.buildControl();
    } catch (err) {
      plan.controlAnswers.push({ answer: { status: 0, contentType: undefined, bytes: Buffer.alloc(0), usage: null, stopReason: null, model: null, latencyMs: 0, error: (err as Error).message, attempts: 0 }, decision: null });
      return;
    }
    const answer = await sender.send({ provider: plan.provider, method: plan.method, path: plan.recordedPath, ...(plan.query ? { query: plan.query } : {}), headers: plan.headers, body });
    upstreamRequests += answer.attempts;
    const cost = estimateCost(plan.recordedModel ?? answer.model, answer.usage ?? undefined, prices);
    if (cost !== null) spent += cost;
    else if (answer.usage && (plan.recordedModel ?? answer.model)) unknownModels.add((plan.recordedModel ?? answer.model)!);
    plan.controlAnswers.push({ answer, decision: answer.error ? null : decisionOfResponse(answer.bytes, answer.contentType, plan.provider, plan.opts) });
  };
  const askOne = async (plan: Planned) => {
    let body: unknown;
    try {
      body = plan.build();
    } catch (err) {
      plan.answers.push({ answer: { status: 0, contentType: undefined, bytes: Buffer.alloc(0), usage: null, stopReason: null, model: null, latencyMs: 0, error: (err as Error).message, attempts: 0 }, decision: null });
      return;
    }
    for (const l of learned.get(keyOf(plan))?.values() ?? []) body = apply(plan, body, l.fix, l.why)?.body ?? body;
    const ask = () => sender.send({ provider: plan.provider, method: plan.method, path: plan.path, ...(plan.query ? { query: plan.query } : {}), headers: plan.headers, body });
    let answer = await ask();
    upstreamRequests += answer.attempts;
    // migrate: a refusal that names what to change is asked once more with it changed.
    const fix = s.remedies && answer.error && (answer.status === 400 || answer.status === 422) ? refusalRemedy(answer.error) : null;
    if (fix) {
      const why = `${plan.askedModel ?? 'the new model'} refused the recorded request: ${answer.error!}`;
      const fixed = apply(plan, body, fix, why);
      if (fixed) {
        body = fixed.body;
        const mine = learned.get(keyOf(plan)) ?? new Map<string, { fix: FieldFix; why: string }>();
        if (!mine.has(fix.field)) mine.set(fix.field, { fix, why });
        learned.set(keyOf(plan), mine);
        answer = await ask();
        upstreamRequests += answer.attempts;
      }
    }
    const cost = estimateCost(plan.askedModel ?? answer.model, answer.usage ?? undefined, prices);
    if (cost !== null) spent += cost;
    else if (answer.usage && (plan.askedModel ?? answer.model)) unknownModels.add((plan.askedModel ?? answer.model)!);
    const decision = answer.error ? null : decisionOfResponse(answer.bytes, answer.contentType, plan.provider, plan.opts);
    plan.answers.push({ answer, decision });
  };
  const worker = async () => {
    for (;;) {
      stopReason ??= stop() ?? (s.budget !== null && spent >= s.budget ? `the budget of $${s.budget.toFixed(2)} is spent` : null);
      if (stopReason) return;
      const next = take();
      if (next === null) return;
      if (next === 'wait') {
        await new Promise<void>((r) => waiting.push(r));
        continue;
      }
      if (next.cacheControl) busy.add(next.target);
      try {
        await (next.arm === 'control' ? askRecorded(next.plan) : askOne(next.plan));
      } finally {
        if (next.cacheControl) busy.delete(next.target);
        done++;
        if (done % 10 === 0 || done === total) log(p.dim(`  ${done} of ${total} asked`));
        wake();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(s.concurrency, total)) }, worker));
  return { spent, upstreamRequests, unknownModels, stopReason };
}

/**
 * Samples a step by default: 3 under the change and 3 as recorded, six requests a step, the fewest
 * with which a change can be told from the model's own variation at 5%.
 */
export const DECISIONS_SAMPLES = 3;

/** Whether the control arm is asked: as the settings say, else from the fewest samples that can tell a change from noise. */
export const controlAsked = (s: Pick<DecisionsSettings, 'samples' | 'control'>): boolean => s.control ?? s.samples >= CONTROL_MIN_SAMPLES;

/** Why a judge check got no verdict on a sample's words: the side it got none for, `not judged: ` left off. */
function notJudgedWhy(j: DecisionJudge): string {
  return (j.now.status === 'inconclusive' ? j.now.reason : j.recorded.reason).replace(/^not judged: /, '');
}

/** A step as the report shows it, from its answers, its values masked by the redaction rules. */
function stepOf(plan: Planned, prices: Record<string, Price> | undefined, stopReason: string | null, samples: number, m: Mask): DecisionStep {
  const recordedView = decisionView(plan.recorded, plan.effectOf);
  const answered = plan.answers.flatMap((a, i) => (a.decision ? [{ a, i }] : []));
  // A text-only answer a judge check reads otherwise is raised to rank 2 (promoteByJudge); one it could not judge waits on it.
  const compared = answered.map(({ a, i }) => {
    const judge = plan.judged.get(i) ?? null;
    return { a, judge, unjudged: unjudgedSample(judge), c: promoteByJudge(compareDecisions(plan.recorded, a.decision!, plan.effectOf), judge ?? []) };
  });
  // The most consequential sample shows the step; of text-only ones, one a judge could not judge (shownSample).
  const worst = compared[shownSample(compared.map((x) => ({ rank: x.c.rank, judge: x.judge })))];
  const ranks = compared.map((x) => x.c.rank ?? 0);
  // The control arm: the request as recorded, asked as often. How often it decides otherwise is the
  // model's own variation here, and the change is ranked only beyond it (engine control-arm.ts).
  const controlled = plan.controlAnswers.flatMap((a, i) => (a.decision ? [{ a, i }] : []));
  const controlRanks = controlled.map(({ a, i }) => promoteByJudge(compareDecisions(plan.recorded, a.decision!, plan.effectOf), plan.controlJudged.get(i) ?? []).rank ?? 0);
  const controlError = plan.controlAnswers.find((a) => a.answer.error)?.answer.error ?? null;
  const control = plan.controlAnswers.length ? { asked: plan.controlAnswers.length, answered: controlled.length, changed: controlRanks.filter((r) => r > 0).length, ranks: controlRanks, error: controlled.length >= CONTROL_MIN_SAMPLES || !controlError ? null : m.text(controlError) } : null;
  const beyond = control && controlled.length && answered.length ? rankBeyondNoise(ranks, controlRanks) : null;
  // Fewer than CONTROL_MIN_SAMPLES answers on either side: no split of the scores can reach the
  // control's risk, so nothing tells the change from the model's own variation, and the step ranks
  // nothing (controlOpen). Only a control the provider will never answer again (a model that retired,
  // a request it now turns away: a 4xx other than a timeout, a conflict or a rate limit, or one that
  // can't be built), none of it answered, leaves the change's own samples to rank the step, as the
  // warnings say.
  const gone = (x: ModelAnswer) => (x.status === 0 ? x.attempts === 0 : x.status >= 400 && x.status < 500 && !unavailableStatus(x.status));
  const forGood = !controlled.length && plan.controlAnswers.every((a) => gone(a.answer));
  const waits = !!control && answered.length > 0 && (controlled.length < CONTROL_MIN_SAMPLES || answered.length < CONTROL_MIN_SAMPLES) && !forGood;
  const before = tokensOf(plan.recordedUsage);
  // In a run like the recorded one: the first answer's whole input, split as the recorded call's was, and the samples' mean output.
  const measured = answered.map(({ a }) => tokensOf(a.answer.usage)).filter((t): t is TokenCount => t !== null);
  const first = measured[0];
  const after = first ? estimatedTokens(before, first.input + first.cacheRead + first.cacheWrite, Math.round(measured.reduce((n, t) => n + t.output, 0) / measured.length)) : null;
  const model = plan.askedModel ?? answered[0]?.a.answer.model ?? null;
  const spent = plan.answers.reduce((n, a) => n + (estimateCost(plan.askedModel ?? a.answer.model, a.answer.usage ?? undefined, prices) ?? 0), 0);
  const failed = plan.answers.find((a) => a.answer.error)?.answer.error ?? null;
  const error = plan.skip ?? (plan.untouched ? null : answered.length ? null : failed ?? (stopReason ? `not asked: ${stopReason}` : null));
  return {
    callNo: plan.call.callNo,
    step: plan.step,
    scope: (plan.call.meta.scope ?? null),
    rank: beyond ? beyond.rank : waits ? null : (worst?.c.rank ?? null),
    majority: beyond ? beyond.rank : waits ? null : majorityRank(ranks),
    ...(control ? { control, noise: beyond ? { p: beyond.p } : null, sampled: worst?.c.rank ?? null } : {}),
    changes: (worst?.c.changes ?? []).map((c) => maskChange(c, m)),
    recorded: maskView(recordedView, m),
    now: worst ? maskView(decisionView(worst.a.decision!, plan.effectOf), m) : null,
    samples: { asked: plan.untouched || plan.skip ? 0 : samples, answered: answered.length, changed: compared.filter((x) => x.c.rank !== null).length, unjudged: compared.filter((x) => x.unjudged).length, ranks },
    model: { recorded: plan.recordedModel, asked: plan.untouched || plan.skip ? null : plan.askedModel },
    tokens: { before, after },
    cost: { before: estimateCost(plan.recordedModel, plan.recordedUsage ?? undefined, prices), after: after ? estimateCost(model, usageOf(after), prices) : null, spent },
    thinkingStripped: plan.thinkingStripped,
    error: error === null ? null : m.text(error),
    judge: worst?.judge ? worst.judge.map((j) => maskJudge(j, m)) : null,
  };
}

/** A judge check's sides as the report shows them: its reasons masked, as every value the report holds. */
function maskJudge(j: DecisionJudge, m: Mask): DecisionJudge {
  if (m === NO_MASK) return j;
  return { ...j, recorded: { ...j.recorded, reason: m.text(j.recorded.reason) }, now: { ...j.now, reason: m.text(j.now.reason) } };
}

/**
 * Asks the judge checks that read a text-only answer's words about the recorded words and the new
 * ones (decisions-judge.ts), for every answered sample of a step that is text only: the run's own
 * checks, or those given with --expect for verify. Runs go side by side, `concurrency` at once, as
 * asking does. What it finds raises a step whose check comes out otherwise to rank 2 (stepOf). A run
 * that did not complete is judged by none, as the judge runtime judges none (cannotJudge): it fails
 * its checks whatever a judge says, so asking would only cost. Those runs are returned, for a note.
 */
async function judgeTextSteps(store: Store, targets: readonly DecisionTarget[], planned: readonly Planned[], judge: TextJudge, expect: TestSpec | null, concurrency: number): Promise<{ outputJudges: string[]; incomplete: string[] }> {
  const outputJudges = new Set<string>();
  const incomplete: string[] = [];
  const work: Array<() => Promise<void>> = [];
  for (const t of targets) {
    const spec = expect ?? t.spec;
    // The control arm's text-only answers are judged as the change's are, so a judge check that reads
    // the words otherwise counts on both sides alike.
    const textOnly = (plan: Planned, a: Planned['answers'][number]) => !!a.decision && compareDecisions(plan.recorded, a.decision, plan.effectOf).rank === 5;
    const text = planned.filter((plan) => plan.target === t && [...plan.answers, ...plan.controlAnswers].some((a) => textOnly(plan, a)));
    if (!spec || !text.length) continue;
    for (const j of TextJudge.readsOutput(spec)) outputJudges.add(j.name);
    const calls = store.getCalls(t.run.runId);
    const reads = judge.reads(t.run, calls, spec);
    if (!text.some((plan) => reads.get(plan.call.callNo)?.length)) continue;
    if (cannotJudge(t.run)) {
      incomplete.push(t.run.runId);
      continue;
    }
    work.push(async () => {
      for (const plan of text) {
        const checks = reads.get(plan.call.callNo);
        if (!checks?.length) continue;
        for (const [answers, judged] of [
          [plan.answers, plan.judged],
          [plan.controlAnswers, plan.controlJudged],
        ] as const) {
          for (const [i, a] of answers.entries()) {
            if (!textOnly(plan, a)) continue;
            const given = { bytes: a.answer.bytes, contentType: a.answer.contentType, provider: plan.provider };
            const found: DecisionJudge[] = [];
            for (const j of checks) found.push(await judge.compare(t.run, calls, j, plan.call.callNo, given));
            judged.set(i, found);
          }
        }
      }
    });
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, work.length)) }, async () => {
    while (next < work.length) await work[next++]!();
  }));
  return { outputJudges: [...outputJudges], incomplete };
}

/** A run's part of the report. */
function runOf(target: DecisionTarget, planned: Planned[], steps: DecisionStep[], warnings: string[], refusal: string | null): DecisionRun {
  const counts: DecisionCounts = emptyCounts();
  let before = NO_TOKENS;
  let after = NO_TOKENS;
  let costBefore: number | null = 0;
  let costAfter: number | null = 0;
  for (const s of steps) {
    if (s.rank !== null) counts[String(s.rank) as '1']++;
    // Changed in some sample, with no answer as recorded to tell it from the model's own variation: not settled.
    else if (controlOpen(s)) counts.notAsked++;
    // Changed in some sample, but no more often than as recorded: the model's own variation.
    else if (s.control && s.sampled) counts.noise = (counts.noise ?? 0) + 1;
    else if (s.samples.answered) counts.same++;
    else if (s.error) counts.notAsked++;
    else counts.untouched++;
    if (!s.samples.answered) continue;
    before = addTokens(before, s.tokens.before);
    after = addTokens(after, s.tokens.after);
    costBefore = costBefore === null || s.cost.before === null ? null : costBefore + s.cost.before;
    costAfter = costAfter === null || s.cost.after === null ? null : costAfter + s.cost.after;
  }
  const asked = steps.filter((s) => s.samples.answered).length;
  const ranks = steps.map((s) => s.rank).filter((r): r is DecisionRank => r !== null);
  const majorities = steps.map((s) => s.majority).filter((r): r is DecisionRank => r !== null);
  return {
    runId: target.run.runId,
    golden: target.golden,
    steps: planned.length,
    asked,
    rank: ranks.length ? (Math.min(...ranks) as DecisionRank) : null,
    majority: majorities.length ? (Math.min(...majorities) as DecisionRank) : null,
    counts,
    cost: { before: asked ? costBefore : null, after: asked ? costAfter : null, spent: steps.reduce((n, s) => n + s.cost.spent, 0) },
    tokens: { before, after },
    thinkingStripped: steps.reduce((n, s) => n + s.thinkingStripped, 0),
    refused: refusal,
    decisions: [...steps].sort(byConsequence),
    warnings,
  };
}

/**
 * Why verify can't test the change as migrate asked it, or null: a field the requests must leave
 * out, or send under another name, is no request field `--set` can give, and verify runs the agent's
 * code, which still sends it, so the new model would refuse every attempt. The code changes first.
 */
export function codeChangeNeeded(remedies: readonly DecisionRemedy[], to: string | null): string | null {
  const unsendable = remedies.filter((r) => r.renamedTo !== null || (r.leftOut && r.value === null));
  if (!unsendable.length) return null;
  const what = unsendable.map((r) => (r.renamedTo ? `send ${r.renamedTo} in place of ${r.field}` : `leave ${r.field} out`)).join(' and ');
  return `verify runs your agent's code, which ${to ? `${to} refuses as it stands` : 'the new model refuses'}: ${what} in your agent's requests (What to set), then verify`;
}

/** The fields verify takes for a change: the model, the fields given, and those migrate sent with a value in place of what the new model refuses. */
export function verifyFields(change: Pick<DecisionsChange, 'model' | 'fields'>, remedies: readonly DecisionRemedy[]): Record<string, unknown> {
  return { ...(change.model ? { model: change.model } : {}), ...change.fields, ...Object.fromEntries(remedies.filter((r) => r.value !== null && r.renamedTo === null).map((r) => [r.field, r.value])) };
}

/**
 * Verifies the runs with a write, stop or judged change, as `shadowlap verify` would: each under its
 * own checks (a golden's from the config, those of the recording a run named by id comes from, or
 * `--expect`), one verify per set of checks, each run in the role its recording plays under them (a
 * run that fails them must now pass; one that passes must keep passing), and each with the rule that
 * decided it. With `blocked`, nothing runs: the verdict is not-run, with why, and the commands.
 */
export async function verifyFlagged(input: { opts: GlobalOpts; store: Store; flagged: DecisionTarget[]; fields: Record<string, unknown>; from: string[] | null; settings: Pick<DecisionsSettings, 'thenVerify' | 'argv' | 'timeoutMs' | 'guard'>; prices: Record<string, Price> | undefined; budget: number | null; log: (line: string) => void; blocked?: string | null }): Promise<DecisionsVerify> {
  const { flagged, settings: s, log } = input;
  const v = s.thenVerify!;
  // The rule every run is decided by, said once over them.
  const rule = v.gate ? `gate: ${describeGate(v.gate)}` : `${v.needed} of ${v.attempts} attempts must pass`;
  const empty: DecisionsVerify = { verdict: 'not-run', verifyIds: [], runs: [], rule, commands: [], spent: 0, upstreamRequests: 0, reasons: [] };
  if (!flagged.length) return empty;
  // Grouped by the checks they are judged by: one verify per check.
  const groups = new Map<string, { spec: TestSpec | null; json: unknown; targets: DecisionTarget[] }>();
  for (const t of flagged) {
    const spec = v.expect?.spec ?? t.spec;
    const json = v.expect?.json ?? t.expect;
    const key = JSON.stringify(json ?? null);
    const g = groups.get(key) ?? { spec, json, targets: [] };
    g.targets.push(t);
    groups.set(key, g);
  }
  const plans = [...groups.values()].map((g) => {
    const runs = g.targets.map((t) => {
      const judged = judgeRecording(input.store, t.run, input.store.getCalls(t.run.runId), g.spec, input.prices);
      const role: VerifyRole = judged.passed === false ? 'target' : 'good';
      // A golden runs its pack's command as test runs it; a run unpacked from someone's pack is marked so later replays ask.
      return { parent: t.run, argv: s.argv ?? t.run.command.argv, commandFromImport: !s.argv && t.golden === null && commandIsImported(t.run), role };
    });
    const role = (r: VerifyRole) => runs.filter((x) => x.role === r).map((x) => x.parent.runId);
    const line = verifyCommand({ fixes: role('target').map((id) => shortId(id)), keeps: role('good').map((id) => shortId(id)) }, { expect: g.json ?? null, attempts: v.attempts, passes: !v.gate && v.needed !== Math.ceil(0.8 * v.attempts) ? v.needed : undefined, gate: v.gate, fields: input.fields, from: input.from ?? undefined, liveTools: [], writes: v.writes, reads: 'live', budget: null, timeoutMs: s.timeoutMs, argv: s.argv });
    return { g, runs, line };
  });
  if (input.blocked) return { ...empty, commands: plans.map((x) => x.line), reasons: [input.blocked] };
  const out: DecisionsVerify = { ...empty, verdict: 'accepted' };
  for (const { g, runs, line } of plans) {
    const remaining = input.budget === null ? null : Math.max(0, input.budget - out.spent);
    log(`${p.yellow('⑂')} Verifying ${runs.length} run${runs.length === 1 ? '' : 's'} with a write, stop or judged change: ${runs.map((r) => shortId(r.parent.runId)).join(', ')}`);
    const report = await runVerify({
      opts: input.opts,
      runs,
      settings: { attempts: v.attempts, needed: v.needed, gate: v.gate, concurrency: 1, fields: input.fields, ...(input.from?.length ? { fromModels: input.from } : {}), failFast: false, spec: g.spec, expect: g.json ?? null, writes: v.writes, reads: 'live', liveTools: [], budget: remaining, timeoutMs: s.timeoutMs, guard: s.guard },
      log,
    });
    const kept = recordVerifyFix(input.opts, report, { expect: g.json ?? null, command: line });
    if (kept) out.verifyIds.push(kept.verdict.verifyId);
    out.commands.push(line);
    out.spent += report.spent;
    out.upstreamRequests += report.upstreamRequests;
    out.reasons.push(...report.reasons);
    // In verify --json's words: fixed, not-fixed, kept, broken, inconclusive, unsettled; with why its
    // last attempt could not be judged, when one stopped it (no bound then, as verify gives none), and
    // the rule that decided it.
    // A good run kept against its baseline reads under the baseline test's rule, its bound the drop's.
    const keptRule = report.kept ? describeBaselineRule({ ...report.kept, revision: report.kept.label ?? report.kept.revision ?? null }) : null;
    for (const r of report.runs) {
      const against = r.baseline && keptRule;
      const bound = r.undecided || r.deterministic ? null : against ? (r.drop ? dropBound(r.drop, r.decision) : null) : r.gate ? rateBound(r.gate) : null;
      out.runs.push({ runId: r.runId, role: r.role, outcome: outcomeOf(r).replace(' ', '-'), passes: r.passes, attempts: r.attempts.length, ...(against ? { baseline: { passes: r.baseline!.passes, attempts: r.baseline!.attempts } } : {}), bound, undecided: r.undecided ?? null, rule: against ? keptRule : rule });
    }
    if (report.verdict === 'rejected') out.verdict = 'rejected';
    else if (report.verdict === 'incomplete' && out.verdict !== 'rejected') out.verdict = 'incomplete';
  }
  // The rule stated once is the one every run was decided by: the gate's, or a good run's baseline test.
  const rules = new Set(out.runs.map((r) => r.rule ?? rule));
  out.rule = rules.size === 1 ? [...rules][0]! : rules.size ? null : rule;
  return out;
}

/** Why a run's command can't be run (for --from-code and --then-verify), or null. */
export function commandProblem(t: DecisionTarget, argv: string[] | null): string | null {
  if (argv) return null;
  if (!hasRecordedCommand(t.run)) return `${shortId(t.run.runId)} has no command to run again: give yours after --`;
  return null;
}

/** Asks every target's model calls again under the change, and keeps the report. */
export async function runDecisions(input: DecisionsInput): Promise<DecisionsReport> {
  const { settings: s, log } = input;
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const env = input.env ?? process.env;
  // The report goes where a run's copies go (a pull request, a comment): the redaction rules apply to it.
  let rules: Normalizer[];
  try {
    rules = config.redact;
  } catch (err) {
    throw new DecisionsError(`the redaction rules in shadowlap.config.json: ${(err as Error).message}`);
  }
  const mask = masking(rules);
  const store = openStore(input.opts);
  const at = input.now ?? Date.now();
  let interrupted = false;
  // The first stop signal (Ctrl-C, a dashboard's stop, a closed terminal) starts no new request and
  // keeps what was asked; a second one doesn't wait, and the agent --from-code left running goes with
  // this process (the exit hook kills its group).
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) process.exit(signalExit(signal));
    interrupted = true;
  };
  for (const s of STOP_SIGNALS) process.on(s, onSignal);
  try {
    // Which recorded models the model and the fields change at: --from, else the default for a switch.
    const use = modelUse(store, input.targets, s.scope);
    const chosen = s.from?.length ? null : s.model ? defaultFrom(use, input.kind ?? 'decisions', s.model, at) : null;
    const from = s.from?.length ? s.from : (chosen?.models ?? null);
    // --from-code: what the working tree sends each run, read offline; nothing is sent.
    const captures = new Map<string, FromCodeCapture>();
    const refusedRuns = new Map<string, string>();
    if (s.fromCode) {
      // A suite's calls mostly send the same prompt and tools: each is held once.
      const held = new Map<string, RequestPrompt>();
      for (const t of input.targets) {
        log(p.dim(`  reading the prompt the working tree sends ${t.golden ?? shortId(t.run.runId)}, offline`));
        const cap = await captureFromCode({ store, config, parent: t.run, argv: s.argv ?? t.run.command.argv, commandFromImport: !s.argv && t.golden === null && commandIsImported(t.run), guard: 'block', timeoutMs: s.timeoutMs ?? 120_000, cwd });
        for (const c of cap.prompts.values()) {
          const key = JSON.stringify(c.prompt);
          const had = held.get(key);
          if (had) c.prompt = had;
          else held.set(key, c.prompt);
        }
        captures.set(t.run.runId, cap);
        if (cap.refused) refusedRuns.set(t.run.runId, cap.refused);
      }
    }
    // Effects from the other runs asked with them, then every run in the store (a tool's effect is
    // declared in code, the same in every run); the config's and the run's own come first (planRun).
    const batchEffects = new Map<string, Effect>();
    for (const t of input.targets) effectsOf(store.getCalls(t.run.runId), batchEffects);
    const storeEffects = effectsOf(store.toolUsage().map((u) => ({ kind: 'tool' as const, name: u.name, effect: u.effect })));
    for (const [name, effect] of storeEffects) if (!batchEffects.has(name)) batchEffects.set(name, effect);
    const remedies = new Remedies();
    const planned = input.targets.flatMap((t) => (refusedRuns.has(t.run.runId) ? [] : planRun(store, t, s, from, captures.get(t.run.runId) ?? null, batchEffects, config, remedies, env)));

    // Refused before anything is spent: a provider this machine has no credentials or upstream for.
    // A model request waits as long as the official SDKs do (ten minutes) unless --timeout says less.
    const sender = new ModelSender({ upstreams: upstreamOverrides(env), env, timeoutMs: s.timeoutMs ?? 600_000 });
    const problems = new Set<string>();
    for (const plan of planned) {
      if (plan.skip || plan.untouched) continue;
      const why = sender.problem(plan.provider, plan.path);
      if (why) problems.add(why);
      if (azureDeploymentCall(plan.provider, plan.path) && !plan.query) problems.add("an Azure OpenAI deployment call needs the api-version it was sent with, which this recording doesn't keep (it was made before recordings kept a call's query): set OPENAI_API_VERSION to it, as the AzureOpenAI SDKs read it");
    }
    if (problems.size) throw new DecisionsError(`nothing was sent: ${[...problems].join('; ')}`);

    const asked = await askAll(planned, s, sender, config.prices, log, () => (interrupted ? 'interrupted' : null), remedies);
    // Text-only answers a judge check reads: the judge asked about the recorded words and the new ones,
    // what it costs counted apart from asking, and against the budget (decisions-judge.ts).
    const judge = new TextJudge(store, config, env, (judgeSpent) => (interrupted ? 'interrupted' : (asked.stopReason ?? (s.budget !== null && asked.spent + judgeSpent >= s.budget ? `the budget of $${s.budget.toFixed(2)} is spent` : null))));
    let outputJudges: string[] = [];
    let incomplete: string[] = [];
    try {
      ({ outputJudges, incomplete } = await judgeTextSteps(store, input.targets, planned, judge, s.thenVerify?.expect?.spec ?? null, s.concurrency));
    } finally {
      await judge.close();
    }
    const warnings: string[] = [];
    const runs: DecisionRun[] = [];
    // Why the steps that wait on a judge (judgeOpen) got no verdict, from every sample of them a judge could not judge.
    const notJudged = new Set<string>();
    for (const t of input.targets) {
      const mine = planned.filter((x) => x.target === t);
      const runWarnings = [...(captures.get(t.run.runId)?.notes ?? [])].map(mask.text);
      const refusal = refusedRuns.get(t.run.runId) ?? null;
      const steps = mine.map((plan) => stepOf(plan, config.prices, asked.stopReason, s.samples, mask));
      steps.forEach((step, k) => {
        if (!judgeOpen(step)) return;
        for (const judged of mine[k]!.judged.values()) if (unjudgedSample(judged)) for (const j of judged) if (j.changed === null) notJudged.add(mask.text(notJudgedWhy(j)));
      });
      runs.push(runOf(t, mine, steps, runWarnings, refusal === null ? null : mask.text(refusal)));
    }
    const counts = emptyCounts();
    for (const r of runs) for (const k of Object.keys(counts) as Array<keyof DecisionCounts>) counts[k] = (counts[k] ?? 0) + (r.counts[k] ?? 0);
    // Flagged by what most samples show: a change in fewer than half of them is listed, not flagged.
    const flagged = runs.filter((r) => r.majority !== null && r.majority <= 2).map((r) => r.runId);
    // Per run, each side over the runs it has a price for: a model with no price leaves its side unknown.
    const mean = (side: 'before' | 'after') => {
      const priced = runs.filter((r) => r.asked && r.cost[side] !== null);
      return priced.length ? priced.reduce((n, r) => n + r.cost[side]!, 0) / priced.length : null;
    };
    const allSteps = runs.flatMap((r) => r.decisions);
    const notes = [JUDGED_IN_RECORDED_STATE];
    const stripped = allSteps.filter((x) => x.thinkingStripped > 0);
    if (stripped.length) notes.push(`Reasoning from earlier turns was left out of ${stripped.length} request${stripped.length === 1 ? '' : 's'}: providers tie it to the prompt it was made under, so it would be refused, or read under a prompt that never produced it.`);
    if (planned.some((x) => !x.skip && !x.untouched && x.cacheControl)) {
      notes.push("Cache breakpoints stay where the agent placed them, and a run whose requests carry them is asked one step at a time, in order, so each step can read the prefix the one before it cached. A step's cost after the change is its new answer's tokens split between cache reads, cache writes and plain input as the recorded call's were, as a run makes them; what asking spent is apart.");
    }
    // A switch leaves the calls made with other models as they were: say whose.
    const left = planned.filter((x) => x.untouched && !x.switched && x.recordedModel);
    if (from && left.length) {
      const others = [...new Set(left.map((x) => x.recordedModel!))];
      const whose = chosen ? `, ${chosen.why === 'retire' ? `the model${from.length === 1 ? '' : 's'} the runs use that retire${from.length === 1 ? 's' : ''}` : 'the model the runs use most'} (--from names others)` : '';
      notes.push(`The ${left.length} model call${left.length === 1 ? '' : 's'} made with ${others.join(', ')} stay${left.length === 1 ? 's' : ''} as recorded: the change is at the calls made with ${from.join(', ')}${whose}.`);
    }
    for (const m of s.from ?? []) if (!use.some((u) => sameModel(u.model, m))) warnings.push(`--from ${m}: no model call of the runs was made with it (they use ${use.map((u) => u.model).join(', ') || 'no named model'})`);
    const minority = allSteps.filter((x) => x.rank !== null && x.rank <= 2 && !(x.majority !== null && x.majority <= 2)).length;
    if (minority) notes.push(`${minority} step${minority === 1 ? '' : 's'} had a write, stop or judged change in fewer than half ${minority === 1 ? 'its' : 'their'} samples: listed, not flagged, as a model's own variation.`);
    // The steps whose text-only change a judge check reads, in three parts: those that wait on a judge
    // (judgeOpen), those a check came out otherwise for, and those every check came out as recorded for.
    // Only what was judged is said to have come out as anything.
    const judgedSteps = allSteps.filter((x) => x.judge?.length || judgeOpen(x));
    const waiting = judgedSteps.filter((x) => judgeOpen(x));
    const otherwise = judgedSteps.filter((x) => !judgeOpen(x) && x.judge?.some((j) => j.changed));
    const asRecorded = judgedSteps.length - waiting.length - otherwise.length;
    if (judgedSteps.length) {
      const parts = [
        otherwise.length ? `${otherwise.length} came out otherwise for the new words (rank 2, as a changed stop is)` : '',
        asRecorded ? (asRecorded === judgedSteps.length ? 'every check came out as recorded' : `${asRecorded} as recorded`) : '',
        waiting.length ? `${waiting.length} could not be judged (the warnings say why)` : '',
      ].filter(Boolean);
      notes.push(`A judge check of the runs reads the words of ${judgedSteps.length} text-only step${judgedSteps.length === 1 ? '' : 's'}: ${parts.join(', ')}.`);
    }
    if (waiting.length) warnings.push(`${waiting.length} text-only step${waiting.length === 1 ? '' : 's'} a judge check reads could not be judged: ${[...notJudged].slice(0, 3).join('; ')}`);
    if (incomplete.length) {
      const one = incomplete.length === 1;
      notes.push(`${one ? shortId(incomplete[0]!) : `${incomplete.length} runs`} did not complete${one ? '' : ` (${incomplete.map((id) => shortId(id)).join(', ')})`}, so ${one ? 'it fails its' : 'each fails its'} checks whatever a judge says: no judge check reads ${one ? 'its' : 'their'} text-only changes, which are counted.`);
    }
    if (allSteps.some((x) => x.rank === 5 && !x.judge?.length && !judgeOpen(x))) notes.push(judgedSteps.length ? 'Text-only changes no judge check reads are counted, not judged.' : 'Text-only changes are counted, not judged.');
    // A check on what the agent printed is judged only where the agent runs: by verify, on the runs a change flags.
    if (outputJudges.length) notes.push(`The judge check${outputJudges.length === 1 ? '' : 's'} ${outputJudges.map((n) => `"${n}"`).join(', ')} read${outputJudges.length === 1 ? 's' : ''} what the agent printed, which asking a model call again doesn't make: verify judges ${outputJudges.length === 1 ? 'it' : 'them'} end to end when it takes a run (--then-verify, migrate).`);
    if (controlAsked(s)) {
      // The control arm: what the change decides differently, told from what the model does on its own.
      notes.push(`Each step was asked ${s.samples} times under the change and ${s.samples} times as recorded: a change is ranked only when its decisions run more consequential than the recorded request's own, by an exact permutation test at ${CONTROL_RISK * 100}% a step.`);
      if (counts.noise) notes.push(`${counts.noise} step${counts.noise === 1 ? '' : 's'} decided otherwise no more often than ${counts.noise === 1 ? 'it' : 'they'} did as recorded: listed with both counts, not ranked, as the model's own variation.`);
      const why = (steps: DecisionStep[]) => [...new Set(steps.map((x) => x.control!.error).filter(Boolean))].slice(0, 2).join('; ') || 'too few answers';
      const open = allSteps.filter((x) => controlOpen(x));
      if (open.length) warnings.push(`${open.length} step${open.length === 1 ? '' : 's'} got fewer than ${CONTROL_MIN_SAMPLES} answers under the change or as recorded (${why(open)}): not ranked, since nothing told ${open.length === 1 ? 'its' : 'their'} change from the model's own variation; ask again to settle ${open.length === 1 ? 'it' : 'them'}`);
      const unasked = allSteps.filter((x) => x.control && !x.control.answered && x.samples.answered && !controlOpen(x) && x.sampled !== null);
      if (unasked.length) warnings.push(`${unasked.length} step${unasked.length === 1 ? '' : 's'} could not be asked as recorded any more (${why(unasked)}): ranked by the change's samples alone, not told from the model's own variation`);
    } else if (counts[1] || counts[2] || counts[3] || counts[4]) {
      notes.push(s.samples === 1 ? 'Each step was asked once, and a model varies from one answer to the next: --samples 3 asks each step as recorded as often too, and ranks a change only beyond what the model does on its own.' : `Each step was asked ${s.samples} times, too few to tell a change from the model's own variation: from --samples 3, each step is asked as recorded as often too, and a change ranked only beyond it.`);
    }
    if (s.fromCode) notes.push('Nothing ran to read the prompt: each run was replayed offline under the working tree, its model calls matched without their prompt and tools.');
    // What a judge reads goes to its model: the same rules masked it first (decisions-judge.ts). Said
    // only when a judge read something, now, before, or in the recording.
    if (rules.length) notes.push(`The project's redaction rules masked the values this report shows${judge.read ? ', and what each judge check read' : ''}, as they mask every export, pack and share link.`);
    for (const plan of planned) if (plan.skip) warnings.push(`#${plan.call.callNo} of ${shortId(plan.target.run.runId)} not asked: ${mask.text(plan.skip)}`);
    const failures = allSteps.filter((x) => !x.samples.answered && x.samples.asked && x.error);
    if (failures.length) warnings.push(`${failures.length} step${failures.length === 1 ? '' : 's'} got no answer: ${[...new Set(failures.map((x) => x.error))].slice(0, 3).join('; ')}`);
    // The new model refused requests as recorded: what it takes, by the provider's pages and its own words, as migrate would send them.
    if (!s.remedies && s.model && failures.length) {
      const takes = new Map<string, string>();
      for (const plan of planned) {
        if (!plan.answers.length || plan.answers.some((a) => a.decision)) continue;
        const fix = refusalRemedy(plan.answers.find((a) => a.answer.error)?.answer.error ?? '');
        const named = fix ? [{ field: fix.field, value: 'value' in fix ? fix.value : null, leftOut: 'renamedTo' in fix, renamedTo: 'renamedTo' in fix ? fix.renamedTo : null }] : [];
        for (const t of [...plan.takes, ...named]) takes.set(t.field, t.renamedTo ? `${t.renamedTo} in place of ${t.field}` : t.leftOut ? `${t.field} left out` : `${t.field}=${fieldText(t.value)}`);
      }
      if (takes.size) warnings.push(`${s.model} takes ${[...takes.values()].join(', ')} in place of what the recorded requests send: shadowlap migrate --to ${s.model} asks with ${takes.size === 1 ? 'that' : 'those'}, says why, and verifies the runs that change`);
    }

    // Models the runs use that retire, and the one the change switches to.
    const models = planned.flatMap((x) => [{ provider: x.provider, model: x.recordedModel }, ...(x.askedModel && x.askedModel !== x.recordedModel ? [{ provider: x.provider, model: x.askedModel }] : [])]);
    const retirements: RetirementNotice[] = retirementsOf(models, { now: at });

    const change: DecisionsChange = { model: s.model, fields: Object.fromEntries(Object.entries(s.fields).filter(([k]) => k !== 'model')), from, fromCode: s.fromCode ? fromCodeChange(captures, store, planned, codeVersion(cwd), mask) : null, text: changeText(s) };
    const report: DecisionsReport = {
      decisionsId: null,
      kind: 'decisions',
      at,
      change,
      command: input.command,
      samples: s.samples,
      runs,
      counts,
      flagged,
      cost: { before: mean('before'), after: mean('after'), spent: asked.spent, upstreamRequests: asked.upstreamRequests, unknownModels: [...asked.unknownModels] },
      tokens: { before: runs.reduce((t, r) => addTokens(t, r.tokens.before), NO_TOKENS), after: runs.reduce((t, r) => addTokens(t, r.tokens.after), NO_TOKENS) },
      retirements,
      notes,
      warnings,
      verify: null,
      judge: judgedSteps.length || judge.upstreamRequests || judge.spent ? { steps: judgedSteps.length, changed: otherwise.length, inconclusive: waiting.length, spent: judge.spent, upstreamRequests: judge.upstreamRequests, unknownModels: [...judge.unknownModels] } : null,
      remedies: remedies.list(),
      stopReason: asked.stopReason,
    };

    if (s.thenVerify && !asked.stopReason) {
      report.verify = await verifyFlagged({
        opts: input.opts,
        store,
        flagged: input.targets.filter((t) => flagged.includes(t.run.runId)),
        fields: verifyFields(change, report.remedies),
        from,
        settings: s,
        prices: config.prices,
        budget: s.budget === null ? null : Math.max(0, s.budget - asked.spent - judge.spent),
        log,
        // A Ctrl-C while the judge was asked starts no verify: what it would run is said, with the commands.
        blocked: interrupted ? 'it was interrupted before verify started' : codeChangeNeeded(report.remedies, s.model),
      });
      if (report.verify.verdict === 'not-run' && !report.verify.reasons.length) report.notes.push('No run has a write, stop or judged change, so none needs verify.');
    }
    if (input.kind !== 'migrate') report.decisionsId = keepDecisions(store, report, 'decisions');
    return report;
  } finally {
    for (const s of STOP_SIGNALS) process.off(s, onSignal);
    store.close();
  }
}

/** A session's id, `dc-…` or `mg-…`. */
export function newSessionId(kind: 'decisions' | 'migrate', at: number = Date.now()): string {
  return `${kind === 'migrate' ? 'mg' : 'dc'}-${ulid(at)}`;
}

/**
 * Keeps a session in the store, its runs as rows of their own (ranked by what most samples show, as
 * the session flags them), and its activity line; its id, or null when the store can't take it.
 */
export function keepDecisions(store: Store, report: DecisionsReport | (Record<string, unknown> & { runs: DecisionRun[]; flagged: string[]; change: { text: string }; at: number }), kind: 'decisions' | 'migrate', sessionId: string = newSessionId(kind, report.at), extra: Record<string, unknown> = {}, event = true): string | null {
  const actor = resolveAuthor({ cwd: process.cwd() });
  const { runs, ...rest } = report as { runs: DecisionRun[] } & Record<string, unknown>;
  const data = { ...rest, ...extra, [kind === 'migrate' ? 'migrateId' : 'decisionsId']: sessionId };
  try {
    store.putDecisionSession({
      sessionId,
      kind,
      at: report.at,
      change: report.change.text,
      actor,
      revision: codeVersion(process.cwd()),
      data,
      runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.majority ?? null, changed: r.decisions.filter((x) => x.rank !== null).length, data: r as unknown as Record<string, unknown> })),
    });
    if (event) {
      // What asking (and judging, and for migrate, verifying) cost.
      const r = report as Partial<DecisionsReport> & { costs?: { checking?: { decisions: number; verify: number; judge?: number } } };
      const spent = r.costs?.checking ? r.costs.checking.decisions + r.costs.checking.verify + (r.costs.checking.judge ?? 0) : (r.cost?.spent ?? 0) + (r.verify?.spent ?? 0) + (r.judge?.spent ?? 0);
      recordEvent(store, { kind: `${kind}.done`, actor, ref: sessionId, data: { change: report.change.text, runs: runs.length, flagged: report.flagged.length, spent } });
    }
    return sessionId;
  } catch (err) {
    (report as DecisionsReport).warnings?.push(`the result could not be kept in the store: ${(err as Error).message}`);
    return null;
  }
}

/** A change list in a line, for logs: `rank 1 at #29 (send_email is no longer called)`. */
export function changeLine(c: DecisionChange, callNo: number): string {
  return `rank ${c.rank} at #${callNo} (${c.detail})`;
}

/** The options a command was given that change how it asks or verifies, for the command that does it the same way again. */
export interface AskFlags {
  concurrency?: number;
  budget?: number | null;
  timeoutMs?: number | null;
  expect?: unknown;
  /** A fixed count, as given: `--attempts`, `--passes`. */
  attempts?: number | undefined;
  passes?: number | undefined;
  /** The gate verify decides by, when no count is given: flags only for figures other than verify's. */
  gate?: SprtGate | null;
  writes?: 'stub' | 'block';
  guard?: GuardMode;
  inconclusive?: 'fail' | 'warn';
}

/** The flags after the change, each only when it differs from the default. */
export function askArgs(f: AskFlags, verifies: boolean): string[] {
  return [
    ...(f.concurrency !== undefined && f.concurrency !== 4 ? ['--concurrency', String(f.concurrency)] : []),
    ...(f.budget !== null && f.budget !== undefined ? ['--budget', String(f.budget)] : []),
    ...(f.timeoutMs !== null && f.timeoutMs !== undefined ? ['--timeout', String(Math.round(f.timeoutMs / 1000))] : []),
    ...(verifies && f.expect !== null && f.expect !== undefined ? ['--expect', JSON.stringify(f.expect)] : []),
    ...(verifies ? (f.attempts !== undefined || f.passes !== undefined ? gateFlags(null, SPRT_DEFAULTS, { attempts: f.attempts ?? 5, passes: f.passes }) : f.gate ? gateFlags(f.gate, SPRT_DEFAULTS, { attempts: f.gate.max }) : []) : []),
    ...(verifies && f.writes === 'block' ? ['--writes', 'block'] : []),
    ...(verifies && f.guard !== undefined && f.guard !== 'warn' ? ['--guard', f.guard] : []),
    ...(f.inconclusive === 'warn' ? ['--inconclusive', 'warn'] : []),
  ];
}

/** The command that asks the same way again. */
export function decisionsCommand(targets: readonly string[], s: Pick<DecisionsSettings, 'model' | 'fields' | 'from' | 'fromCode' | 'samples' | 'scope' | 'thenVerify' | 'argv'>, flags: AskFlags = {}): string {
  const fields = Object.entries(s.fields).filter(([k]) => k !== 'model');
  return quoteArgv([
    'shadowlap',
    'decisions',
    ...targets,
    ...(s.fromCode ? ['--from-code'] : []),
    ...(s.model ? ['--model', s.model] : []),
    ...fields.flatMap(([k, v]) => ['--set', `${k}=${fieldText(v)}`]),
    ...(s.from ?? []).flatMap((m) => ['--from', m]),
    ...(s.samples !== DECISIONS_SAMPLES ? ['--samples', String(s.samples)] : []),
    ...(s.scope ? ['--scope', s.scope] : []),
    ...(s.thenVerify ? ['--then-verify'] : []),
    ...askArgs(flags, !!s.thenVerify),
    ...(s.argv ? ['--', ...s.argv] : []),
  ]);
}
