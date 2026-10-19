import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  byConsequence,
  commandIsImported,
  compareDecisions,
  decisionOfResponse,
  decisionView,
  effectsOf,
  emptyCounts,
  estimateCost,
  hasRecordedCommand,
  JUDGED_IN_RECORDED_STATE,
  loadApiRequest,
  NO_TOKENS,
  placeFields,
  promptOf,
  promptParts,
  quoteArgv,
  recordEvent,
  refused,
  requestShape,
  resolveAuthor,
  RETIREMENT_SOURCES,
  retiredFields,
  retirementsOf,
  setRequestFields,
  switchModel,
  ulid,
  withoutEarlierThinking,
  withPrompt,
  type CallRecord,
  type DecisionChange,
  type DecisionCounts,
  type DecisionRank,
  type DecisionRemedy,
  type DecisionRun,
  type DecisionsChange,
  type DecisionsReport,
  type DecisionStep,
  type DecisionsVerify,
  type Effect,
  type FromCodeChange,
  type ModelDecision,
  type Normalizer,
  type Price,
  type RetirementNotice,
  type RunRecord,
  type Store,
  type TokenCount,
  type Usage,
  type VerifyRole,
} from '@shadowlap/engine';
import { judgeRecording } from './attempts.js';
import { specFor, type TestSpec } from './checks.js';
import { codeVersion, loadConfig, loadTests, upstreamOverrides, type ShadowlapConfig } from './config.js';
import { captureFromCode, type FromCodeCapture } from './decisions-capture.js';
import { ModelSender, providerById, type ModelAnswer } from './decisions-send.js';
import { recordVerifyFix, verifyCommand } from './fixes.js';
import { importGolden } from './golden-test.js';
import { expandRecordings, goldenName, rawExpectFor } from './goldens.js';
import { type GuardMode } from './run-agent.js';
import { openStore, requireRun, type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';
import { runVerify } from './verify.js';

/**
 * `shadowlap decisions`: what a change decides differently on recorded runs, without running the
 * agent. Each recorded model call is asked again: its request exactly as recorded, with only what
 * the change touches swapped in (the model, request fields, or the prompt and tools the working tree
 * sends now), sent through the sidecar's upstreams. Its answer's decision is compared with the
 * recorded one and ranked by consequence (engine decisions.ts). No tool runs, and a step doesn't
 * depend on the one before, so the steps go in parallel. `--then-verify` hands the runs with a write
 * or stop change to `shadowlap verify`, the end-to-end check, and only those.
 */

/** A run to ask again, and where it came from: a golden's pack, or the store. */
export interface DecisionTarget {
  run: RunRecord;
  /** The golden's name, as `shadowlap test` names it, or null for a run from the store. */
  golden: string | null;
  /** The golden's checks from the config, for verifying it. */
  spec: TestSpec | null;
  expect: Record<string, unknown> | null;
}

export class DecisionsError extends Error {}

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
      for (const run of runs) if (!out.has(run.runId)) out.set(run.runId, { run, golden: null, spec: null, expect: null });
      continue;
    }
    const path = /[\\/*?]/.test(spec) || existsSync(join(resolve(cwd, spec), 'run.json'));
    if (!path) {
      const run = requireRun(store, spec);
      if (!out.has(run.runId)) out.set(run.runId, { run, golden: null, spec: null, expect: null });
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
  fromCode: boolean;
  /** Times each step is asked. */
  samples: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** Start no request once this much (USD) is spent. */
  budget: number | null;
  /** Stop a request after this long (and with --then-verify, an attempt). */
  timeoutMs: number | null;
  /** Only model calls made in this scope. */
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
  /** --then-verify: verify the runs with a rank 1 or 2 change, with these. */
  thenVerify: { attempts: number; needed: number; writes: 'stub' | 'block'; expect: { spec: TestSpec; json: unknown } | null } | null;
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
  body: unknown;
  recorded: ModelDecision;
  recordedModel: string | null;
  askedModel: string | null;
  recordedUsage: Usage | null;
  thinkingStripped: number;
  effectOf: (tool: string) => Effect | null;
  opts: { normalizers: Normalizer[]; clock?: number[] };
  answers: Array<{ answer: ModelAnswer; decision: ModelDecision | null }>;
  /** Why it is not asked; null when it is. */
  skip: string | null;
  /** The change doesn't touch this request: the working tree sends it the same prompt. */
  untouched: boolean;
}

const tokensOf = (u: Usage | null | undefined): TokenCount | null => (u ? { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 } : null);
const addTokens = (a: TokenCount, b: TokenCount | null): TokenCount => (b ? { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite } : a);
const meanTokens = (list: TokenCount[]): TokenCount | null => {
  if (!list.length) return null;
  const sum = list.reduce(addTokens, NO_TOKENS);
  const n = list.length;
  return { input: Math.round(sum.input / n), output: Math.round(sum.output / n), cacheRead: Math.round(sum.cacheRead / n), cacheWrite: Math.round(sum.cacheWrite / n) };
};

/** The fields `migrate` changed, each once, with the steps that needed it. */
class Remedies {
  private readonly byKey = new Map<string, DecisionRemedy>();
  note(r: Omit<DecisionRemedy, 'steps'>): void {
    const key = `${r.field}\u0000${JSON.stringify(r.value)}\u0000${r.leftOut}`;
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
 * > 32000`, OpenAI's `supports at most 16384 completion tokens` and `Only the default (1) value is
 * supported`. Null when it says nothing a field can fix.
 */
export function refusalRemedy(error: string): { field: string; value: unknown } | null {
  const over = /\bmax_tokens:\s*\d+\s*>\s*(\d+)/.exec(error) ?? /at most (\d+) (?:completion|output) tokens/i.exec(error);
  if (over) return { field: 'max_tokens', value: Number(over[1]) };
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

/** The change in words, for reports and the store. */
export function changeText(s: Pick<DecisionsSettings, 'model' | 'fields' | 'fromCode'>): string {
  const parts: string[] = [];
  if (s.fromCode) parts.push('the prompt and tools in the working tree');
  if (s.model) parts.push(`the model ${s.model}`);
  const fields = Object.entries(s.fields).filter(([k]) => k !== 'model');
  if (fields.length) parts.push(fields.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'no change');
}

/** What the working tree sends against the recording, for the report's change. */
function fromCodeChange(captures: Map<string, FromCodeCapture>, store: Store, planned: Planned[], version: string | null): FromCodeChange {
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
    if (!instructions && a.instructions !== b.instructions) instructions = { before: a.instructions, after: b.instructions };
    for (const t of b.tools) if (!a.tools.includes(t)) tools.added.add(t);
    for (const t of a.tools) if (!b.tools.includes(t)) tools.removed.add(t);
    const defs = (pr: typeof before) => new Map((Array.isArray(pr.fields.tools) ? pr.fields.tools : []).map((t: unknown) => [JSON.stringify((t as { name?: unknown; function?: { name?: unknown } })?.name ?? (t as { function?: { name?: unknown } })?.function?.name ?? null), JSON.stringify(t)]));
    const da = defs(before);
    for (const [name, def] of defs(cap.prompt)) if (da.has(name) && da.get(name) !== def) tools.changed.add(JSON.parse(name) as string);
  }
  return { calls, instructions, tools: { added: [...tools.added], removed: [...tools.removed], changed: [...tools.changed] }, codeVersion: version };
}

/** Plans the request for each recorded model call of a run: the recorded one with only the change swapped in. */
function planRun(store: Store, target: DecisionTarget, s: DecisionsSettings, capture: FromCodeCapture | null, batchEffects: Map<string, Effect>, config: ShadowlapConfig, remedies: Remedies): Planned[] {
  const calls = store.getCalls(target.run.runId);
  const runEffects = effectsOf(calls);
  const mcp = config.mcp?.effects ?? {};
  const effectOf = (tool: string): Effect | null => runEffects.get(tool) ?? batchEffects.get(tool) ?? (mcp[tool] as Effect | undefined) ?? null;
  const normalizers = [...config.normalize, ...(target.run.meta?.redactions ?? [])];
  const opts = { normalizers, ...(config.clock === 'exact' ? {} : { clock: [target.run.startedAt, Date.now()] }) };
  const out: Planned[] = [];
  let step = 0;
  for (const call of calls) {
    if (call.kind !== 'api' || !call.requestRef) continue;
    step++;
    if (s.scope !== null && (call.meta.scope ?? null) !== s.scope) continue;
    const provider = (call.meta.provider ?? call.end?.meta.provider ?? null) as string | null;
    const space = call.name.indexOf(' ');
    const method = space > 0 ? call.name.slice(0, space) : 'POST';
    const path = space > 0 ? call.name.slice(space + 1) : call.name;
    const end = call.end;
    const contentType = end?.meta.headers?.['content-type'];
    const bytes = end?.responseRef ? store.getBlob(end.responseRef) : null;
    const recorded = decisionOfResponse(bytes, contentType, provider ?? undefined, opts, end?.meta.chunks ?? []);
    const plan: Planned = {
      target,
      call,
      step,
      provider: provider ?? '',
      method,
      path,
      query: undefined,
      headers: { ...((call.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {}) },
      body: null,
      recorded,
      recordedModel: (end?.meta.model ?? call.meta.model ?? null) as string | null,
      askedModel: null,
      recordedUsage: end?.meta.usage ?? null,
      thinkingStripped: 0,
      effectOf,
      opts,
      answers: [],
      skip: null,
      untouched: false,
    };
    out.push(plan);
    if (!end || end.outcome !== 'ok' || !bytes) {
      plan.skip = 'the recording has no answer to compare with (the call failed when it was recorded)';
      continue;
    }
    if (!providerById(provider)) {
      plan.skip = `it was recorded through ${provider ?? 'no known provider'}, which Shadowlap can't send to`;
      continue;
    }
    let body = loadApiRequest(store, call.requestRef);
    if (requestShape(provider, path, body) === 'other') {
      plan.skip = "it is not a conversation (an embeddings call, or a model's native body)";
      continue;
    }
    let promptChanged = false;
    if (s.fromCode) {
      const cap = capture?.prompts.get(call.callNo);
      if (!cap) {
        plan.skip = 'the offline replay of the working tree never sent it, so its new prompt is unknown';
        continue;
      }
      if (cap.changed) {
        body = withPrompt(body, cap.prompt);
        promptChanged = true;
      }
    }
    let target2 = path;
    let modelChanged = false;
    if (s.model) {
      const sw = switchModel(provider, target2, body, s.model);
      if (refused(sw)) {
        plan.skip = `--model: ${sw.refused}`;
        continue;
      }
      target2 = sw.path;
      body = sw.body;
      modelChanged = sw.changed;
    }
    const fields = Object.fromEntries(Object.entries(s.fields).filter(([k]) => k !== 'model'));
    let fieldsChanged = false;
    if (Object.keys(fields).length) {
      const set = setRequestFields(requestShape(provider, target2, body), body, fields);
      if (refused(set)) {
        plan.skip = `--set: ${set.refused}`;
        continue;
      }
      body = set.body;
      fieldsChanged = set.changed;
    }
    // migrate: what the provider's page says the new model refuses is changed to what it accepts, or left out.
    if (s.remedies) {
      const model = providerById(provider)!.extractModel(target2, body) ?? s.model;
      for (const f of model ? retiredFields(provider, model, body) : []) {
        const allowed = f.rule.allowed?.[f.field];
        const why = `${model} is among ${f.rule.appliesTo}, where ${f.rule.fields.join(', ')} ${f.rule.behavior.charAt(0).toLowerCase()}${f.rule.behavior.slice(1)} (${RETIREMENT_SOURCES[f.rule.platform].owner}); the requests send ${f.field}=${JSON.stringify(f.value)}. ${f.rule.instead}`;
        if (allowed !== undefined) {
          const set = setRequestFields(requestShape(provider, target2, body), body, { [f.field]: allowed });
          if (!refused(set)) body = set.body;
        } else body = withoutFields(provider, target2, body, [f.field]);
        remedies.note({ field: f.field, value: allowed ?? null, leftOut: allowed === undefined, why, source: f.rule.source });
        fieldsChanged = true;
      }
    }
    if (s.fromCode && !promptChanged && !modelChanged && !fieldsChanged) {
      plan.untouched = true;
      continue;
    }
    // Reasoning from earlier turns is tied to the prompt and the model it was made under.
    if (promptChanged || modelChanged) {
      const stripped = withoutEarlierThinking(body);
      body = stripped.body;
      plan.thinkingStripped = stripped.removed;
    }
    plan.path = target2;
    plan.body = body;
    plan.askedModel = providerById(provider)!.extractModel(target2, body);
    // Gemini streams as server-sent events when asked with alt=sse, as its SDKs ask; the query is no part of a call's name.
    if (/:streamGenerateContent$/.test(target2) && contentType?.includes('text/event-stream')) plan.query = 'alt=sse';
  }
  return out;
}

/** Asks every planned request, `samples` times each, `concurrency` at once, a run's steps in order. */
async function askAll(planned: Planned[], s: DecisionsSettings, sender: ModelSender, prices: Record<string, Price> | undefined, log: (line: string) => void, stop: () => string | null, remedies: Remedies): Promise<{ spent: number; upstreamRequests: number; unknownModels: Set<string>; stopReason: string | null }> {
  const queue: Array<{ plan: Planned; sample: number }> = [];
  // A run's steps share their prefix: asked in step order, the provider's prompt cache can serve it from the step before.
  for (let sample = 0; sample < s.samples; sample++) for (const plan of planned) if (!plan.skip && !plan.untouched) queue.push({ plan, sample });
  let spent = 0;
  let upstreamRequests = 0;
  const unknownModels = new Set<string>();
  let stopReason: string | null = null;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < queue.length) {
      stopReason ??= stop() ?? (s.budget !== null && spent >= s.budget ? `the budget of $${s.budget.toFixed(2)} is spent` : null);
      if (stopReason) return;
      const { plan } = queue[next++]!;
      const ask = () => sender.send({ provider: plan.provider, method: plan.method, path: plan.path, ...(plan.query ? { query: plan.query } : {}), headers: plan.headers, body: plan.body });
      let answer = await ask();
      upstreamRequests += answer.attempts;
      // migrate: a refusal that names what to change is asked once more with it changed.
      const fix = s.remedies && answer.error && (answer.status === 400 || answer.status === 422) ? refusalRemedy(answer.error) : null;
      if (fix) {
        const set = setRequestFields(requestShape(plan.provider, plan.path, plan.body), plan.body, { [fix.field]: fix.value });
        if (!refused(set) && set.changed) {
          remedies.note({ field: fix.field, value: fix.value, leftOut: false, why: `${plan.askedModel ?? 'the new model'} refused the recorded request: ${answer.error}`, source: null });
          plan.body = set.body;
          answer = await ask();
          upstreamRequests += answer.attempts;
        }
      }
      const cost = estimateCost(plan.askedModel ?? answer.model, answer.usage ?? undefined, prices);
      if (cost !== null) spent += cost;
      else if (answer.usage && (plan.askedModel ?? answer.model)) unknownModels.add((plan.askedModel ?? answer.model)!);
      const decision = answer.error ? null : decisionOfResponse(answer.bytes, answer.contentType, plan.provider, plan.opts);
      plan.answers.push({ answer, decision });
      done++;
      if (done % 10 === 0 || done === queue.length) log(p.dim(`  ${done} of ${queue.length} asked`));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(s.concurrency, queue.length)) }, worker));
  return { spent, upstreamRequests, unknownModels, stopReason };
}

/** A step as the report shows it, from its answers. */
function stepOf(plan: Planned, prices: Record<string, Price> | undefined, stopReason: string | null, samples: number): DecisionStep {
  const recordedView = decisionView(plan.recorded, plan.effectOf);
  const answered = plan.answers.filter((a) => a.decision);
  const compared = answered.map((a) => ({ a, c: compareDecisions(plan.recorded, a.decision!, plan.effectOf) }));
  const worst = [...compared].sort((x, y) => (x.c.rank ?? 9) - (y.c.rank ?? 9))[0];
  const usages = answered.map((a) => tokensOf(a.answer.usage)).filter((t): t is TokenCount => t !== null);
  const costs = answered.map((a) => estimateCost(plan.askedModel ?? a.answer.model, a.answer.usage ?? undefined, prices)).filter((c): c is number => c !== null);
  const failed = plan.answers.find((a) => a.answer.error)?.answer.error ?? null;
  const error = plan.skip ?? (plan.untouched ? null : answered.length ? null : failed ?? (stopReason ? `not asked: ${stopReason}` : null));
  return {
    callNo: plan.call.callNo,
    step: plan.step,
    scope: (plan.call.meta.scope ?? null) as string | null,
    rank: worst?.c.rank ?? null,
    changes: worst?.c.changes ?? [],
    recorded: recordedView,
    now: worst ? decisionView(worst.a.decision!, plan.effectOf) : null,
    samples: { asked: plan.untouched || plan.skip ? 0 : samples, answered: answered.length, changed: compared.filter((x) => x.c.rank !== null).length, ranks: compared.map((x) => x.c.rank ?? 0) },
    model: { recorded: plan.recordedModel, asked: plan.untouched || plan.skip ? null : plan.askedModel },
    tokens: { before: tokensOf(plan.recordedUsage), after: meanTokens(usages) },
    cost: { before: estimateCost(plan.recordedModel, plan.recordedUsage ?? undefined, prices), after: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null },
    thinkingStripped: plan.thinkingStripped,
    error,
  };
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
  return {
    runId: target.run.runId,
    golden: target.golden,
    steps: planned.length,
    asked,
    rank: ranks.length ? (Math.min(...ranks) as DecisionRank) : null,
    counts,
    cost: { before: asked ? costBefore : null, after: asked ? costAfter : null },
    tokens: { before, after },
    thinkingStripped: steps.reduce((n, s) => n + s.thinkingStripped, 0),
    refused: refusal,
    decisions: [...steps].sort(byConsequence),
    warnings,
  };
}

/** Verifies the runs with a write or stop change, as `shadowlap verify` would, each under its own checks. */
export async function verifyFlagged(input: { opts: GlobalOpts; store: Store; flagged: DecisionTarget[]; fields: Record<string, unknown>; settings: DecisionsSettings; prices: Record<string, Price> | undefined; budget: number | null; log: (line: string) => void }): Promise<DecisionsVerify> {
  const { flagged, settings: s, log } = input;
  const v = s.thenVerify!;
  const empty: DecisionsVerify = { verdict: 'not-run', verifyIds: [], runs: [], commands: [], spent: 0, upstreamRequests: 0, reasons: [] };
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
  const out: DecisionsVerify = { ...empty, verdict: 'accepted' };
  for (const g of groups.values()) {
    const runs = g.targets.map((t) => {
      const judged = judgeRecording(input.store, t.run, input.store.getCalls(t.run.runId), g.spec, input.prices);
      const role: VerifyRole = judged.passed === false ? 'target' : 'good';
      return { parent: t.run, argv: s.argv ?? t.run.command.argv, commandFromImport: !s.argv && commandIsImported(t.run), role };
    });
    const remaining = input.budget === null ? null : Math.max(0, input.budget - out.spent);
    log(`${p.yellow('⑂')} Verifying ${runs.length} run${runs.length === 1 ? '' : 's'} with a write or stop change: ${runs.map((r) => shortId(r.parent.runId)).join(', ')}`);
    const report = await runVerify({
      opts: input.opts,
      runs,
      settings: { attempts: v.attempts, needed: v.needed, concurrency: 1, fields: input.fields, failFast: false, spec: g.spec, expect: g.json ?? null, writes: v.writes, reads: 'live', liveTools: [], budget: remaining, timeoutMs: s.timeoutMs, guard: s.guard },
      log,
    });
    const role = (r: VerifyRole) => runs.filter((x) => x.role === r).map((x) => x.parent.runId);
    const line = verifyCommand({ fixes: role('target').map((id) => shortId(id)), keeps: role('good').map((id) => shortId(id)) }, { expect: g.json ?? null, attempts: v.attempts, passes: v.needed !== Math.ceil(0.8 * v.attempts) ? v.needed : undefined, fields: input.fields, liveTools: [], writes: v.writes, reads: 'live', budget: null, timeoutMs: s.timeoutMs, argv: s.argv });
    const kept = recordVerifyFix(input.opts, report, { expect: g.json ?? null, command: line });
    if (kept) out.verifyIds.push(kept.verdict.verifyId);
    out.commands.push(line);
    out.spent += report.spent;
    out.upstreamRequests += report.upstreamRequests;
    out.reasons.push(...report.reasons);
    for (const r of report.runs) out.runs.push({ runId: r.runId, role: r.role, outcome: outcomeWord(r), passes: r.passes, attempts: r.attempts.length });
    if (report.verdict === 'rejected') out.verdict = 'rejected';
    else if (report.verdict === 'incomplete' && out.verdict !== 'rejected') out.verdict = 'incomplete';
  }
  return out;
}

function outcomeWord(r: { role: VerifyRole; verdict: string; attempts: unknown[] }): string {
  if (!r.attempts.length || r.verdict === 'open') return 'unsettled';
  if (r.role === 'good') return r.verdict === 'pass' ? 'kept' : 'broken';
  return r.verdict === 'pass' ? 'fixed' : 'still-failing';
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
  const store = openStore(input.opts);
  const at = input.now ?? Date.now();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    // --from-code: what the working tree sends each run, read offline; nothing is sent.
    const captures = new Map<string, FromCodeCapture>();
    const refusedRuns = new Map<string, string>();
    if (s.fromCode) {
      for (const t of input.targets) {
        log(p.dim(`  reading the prompt the working tree sends ${t.golden ?? shortId(t.run.runId)}, offline`));
        const cap = await captureFromCode({ store, config, parent: t.run, argv: s.argv ?? t.run.command.argv, commandFromImport: !s.argv && commandIsImported(t.run), guard: 'block', timeoutMs: s.timeoutMs ?? 120_000, cwd });
        captures.set(t.run.runId, cap);
        if (cap.refused) refusedRuns.set(t.run.runId, cap.refused);
      }
    }
    // What each tool does: the run's own calls say first, then the other runs asked with it, then every
    // run in the store (a tool's effect is declared in code, the same in every run), then the config.
    const batchEffects = new Map<string, Effect>();
    for (const t of input.targets) effectsOf(store.getCalls(t.run.runId), batchEffects);
    const storeEffects = effectsOf(store.toolUsage().map((u) => ({ kind: 'tool' as const, name: u.name, effect: u.effect })));
    for (const [name, effect] of storeEffects) if (!batchEffects.has(name)) batchEffects.set(name, effect);
    const remedies = new Remedies();
    const planned = input.targets.flatMap((t) => (refusedRuns.has(t.run.runId) ? [] : planRun(store, t, s, captures.get(t.run.runId) ?? null, batchEffects, config, remedies)));

    // Refused before anything is spent: a provider this machine has no credentials or upstream for.
    const sender = new ModelSender({ upstreams: upstreamOverrides(input.env ?? process.env), env: input.env ?? process.env, timeoutMs: s.timeoutMs, ...(input.env?.SHADOWLAP_DECISIONS_NO_WAIT ? { wait: () => 0 } : {}) });
    const problems = new Set<string>();
    for (const plan of planned) {
      if (plan.skip || plan.untouched) continue;
      const why = sender.problem(plan.provider, plan.path);
      if (why) problems.add(why);
    }
    if (problems.size) throw new DecisionsError(`nothing was sent: ${[...problems].join('; ')}`);

    const asked = await askAll(planned, s, sender, config.prices, log, () => (interrupted ? 'interrupted' : null), remedies);
    const warnings: string[] = [];
    const runs: DecisionRun[] = [];
    for (const t of input.targets) {
      const mine = planned.filter((x) => x.target === t);
      const runWarnings = [...(captures.get(t.run.runId)?.notes ?? [])];
      const refusal = refusedRuns.get(t.run.runId) ?? null;
      runs.push(runOf(t, mine, mine.map((plan) => stepOf(plan, config.prices, asked.stopReason, s.samples)), runWarnings, refusal));
    }
    const counts = emptyCounts();
    for (const r of runs) for (const k of Object.keys(counts) as Array<keyof DecisionCounts>) counts[k] += r.counts[k];
    const flagged = runs.filter((r) => r.rank !== null && r.rank <= 2).map((r) => r.runId);
    // Per run, each side over the runs it has a price for: a model with no price leaves its side unknown.
    const mean = (side: 'before' | 'after') => {
      const priced = runs.filter((r) => r.asked && r.cost[side] !== null);
      return priced.length ? priced.reduce((n, r) => n + r.cost[side]!, 0) / priced.length : null;
    };
    const allSteps = runs.flatMap((r) => r.decisions);
    const notes = [JUDGED_IN_RECORDED_STATE];
    const stripped = allSteps.filter((x) => x.thinkingStripped > 0);
    if (stripped.length) notes.push(`Reasoning from earlier turns was left out of ${stripped.length} request${stripped.length === 1 ? '' : 's'}: providers tie it to the prompt and model it was made under, so it would be refused or read as the new model's own.`);
    if (planned.some((x) => !x.skip && !x.untouched && JSON.stringify(x.body).includes('"cache_control"'))) notes.push("Cache breakpoints stay where the agent placed them, and a run's steps are sent in order, so the prompt cache can serve the prefix they share.");
    if (counts[5]) notes.push('Text-only changes are counted, not judged.');
    if (s.samples === 1 && (counts[1] || counts[2] || counts[3] || counts[4])) notes.push('Each step was asked once, and a model varies from one answer to the next: --samples 3 says how often a decision changes.');
    if (s.fromCode) notes.push('Nothing ran to read the prompt: each run was replayed offline under the working tree, its model calls matched without their prompt and tools.');
    for (const plan of planned) if (plan.skip) warnings.push(`#${plan.call.callNo} of ${shortId(plan.target.run.runId)} not asked: ${plan.skip}`);
    const failures = allSteps.filter((x) => !x.samples.answered && x.samples.asked && x.error);
    if (failures.length) warnings.push(`${failures.length} step${failures.length === 1 ? '' : 's'} got no answer: ${[...new Set(failures.map((x) => x.error))].slice(0, 3).join('; ')}`);

    // Models the runs use that retire, and the one the change switches to.
    const models = planned.flatMap((x) => [{ provider: x.provider, model: x.recordedModel }, ...(x.askedModel && x.askedModel !== x.recordedModel ? [{ provider: x.provider, model: x.askedModel }] : [])]);
    const retirements: RetirementNotice[] = retirementsOf(models, { now: at });

    const change: DecisionsChange = { model: s.model, fields: Object.fromEntries(Object.entries(s.fields).filter(([k]) => k !== 'model')), fromCode: s.fromCode ? fromCodeChange(captures, store, planned, codeVersion(cwd)) : null, text: changeText(s) };
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
      remedies: remedies.list(),
      stopReason: asked.stopReason,
    };

    if (s.thenVerify && !asked.stopReason) {
      const verifyFields = { ...(s.model ? { model: s.model } : {}), ...change.fields, ...Object.fromEntries(report.remedies.filter((r) => !r.leftOut).map((r) => [r.field, r.value])) };
      report.verify = await verifyFlagged({ opts: input.opts, store, flagged: input.targets.filter((t) => flagged.includes(t.run.runId)), fields: verifyFields, settings: s, prices: config.prices, budget: s.budget === null ? null : Math.max(0, s.budget - asked.spent), log });
      if (report.verify.verdict === 'not-run') report.notes.push('No run decides a write or when to stop differently, so none needs verify.');
    }
    if (input.kind !== 'migrate') report.decisionsId = keepDecisions(store, report, 'decisions');
    return report;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    store.close();
  }
}

/** Keeps a session in the store, its runs as rows of their own, and its activity line; its id, or null when the store can't take it. */
export function newSessionId(kind: 'decisions' | 'migrate', at: number = Date.now()): string {
  return `${kind === 'migrate' ? 'mg' : 'dc'}-${ulid(at)}`;
}

export function keepDecisions(store: Store, report: DecisionsReport | (Record<string, unknown> & { runs: DecisionRun[]; flagged: string[]; change: { text: string }; at: number }), kind: 'decisions' | 'migrate', sessionId: string = newSessionId(kind, report.at), extra: Record<string, unknown> = {}): string | null {
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
      runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: r.decisions.filter((x) => x.rank !== null).length, data: r as unknown as Record<string, unknown> })),
    });
    // What asking (and, for migrate, verifying) cost.
    const r = report as Partial<DecisionsReport> & { costs?: { checking?: { decisions: number; verify: number } } };
    const spent = r.costs?.checking ? r.costs.checking.decisions + r.costs.checking.verify : (r.cost?.spent ?? 0) + (r.verify?.spent ?? 0);
    recordEvent(store, { kind: `${kind}.done`, actor, ref: sessionId, data: { change: report.change.text, runs: runs.length, flagged: report.flagged.length, spent } });
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

/** The command that asks the same way again. */
export function decisionsCommand(targets: readonly string[], s: Pick<DecisionsSettings, 'model' | 'fields' | 'fromCode' | 'samples' | 'scope' | 'thenVerify' | 'argv'>): string {
  const fields = Object.entries(s.fields).filter(([k]) => k !== 'model');
  return quoteArgv([
    'shadowlap',
    'decisions',
    ...targets,
    ...(s.fromCode ? ['--from-code'] : []),
    ...(s.model ? ['--model', s.model] : []),
    ...fields.flatMap(([k, v]) => ['--set', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`]),
    ...(s.samples !== 1 ? ['--samples', String(s.samples)] : []),
    ...(s.scope ? ['--scope', s.scope] : []),
    ...(s.thenVerify ? ['--then-verify'] : []),
    ...(s.argv ? ['--', ...s.argv] : []),
  ]);
}
