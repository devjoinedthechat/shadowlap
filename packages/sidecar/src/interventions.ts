import { applyInjection, formatToolFailure, literalValue, modelInRequest, placeInjection, refused, requestShape, sameModel, setRequestFields, switchModel, type CallRecord, type InjectAs, type InjectionPlace, type OverrideSources, type ReplayOptions, type RequestShape, type RunIntervention } from '@shadowlap/engine';

/**
 * Request-level interventions for a replay. Both are append-only with respect to the conversation
 * prefix thinking blocks are bound to: an injected instruction is added at call `atCall` and kept at
 * that same place in every later request of the same conversation; parameter patches and a model
 * switch touch fields outside `system` / `tools` / the turns, which are not bound.
 */
export interface Interventions {
  inject?: {
    /** The parent run's call number of the model call to inject at. */
    atCall: number;
    text: string;
    /** `user` (the default): part of the user turn the request ends with. `system`: a system message after the conversation, where the provider has one. */
    as: InjectAs;
  };
  set?: {
    /** The parent run's call number of the first model call to patch. */
    fromCall: number;
    /** Request fields to set, e.g. `{ model: "claude-opus-5", max_tokens: 2048 }`; dotted keys are paths. `model` switches the model, in the path where the provider names it there. */
    fields: Record<string, unknown>;
    /**
     * Only at model calls whose request names one of these models (`verify --from`), as `sameModel`
     * reads a name: the agent's calls, not a simulated user's or a sub-agent's on another model.
     */
    models?: string[];
  };
}

/**
 * What `apply` did to one request. `target` is set at the call a flag named: the flag, as the
 * divergence report should name it, and the recorded call it stands in for.
 */
export type Rewrite =
  | { path: string; body: unknown; changed: boolean; target?: { by: string; counterpart: number } }
  | { refused: string };

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A `--set` value as the flag takes it: JSON, or a bare string when it can't be read as anything else. */
function fieldValue(v: unknown): string {
  if (typeof v !== 'string') return JSON.stringify(v);
  try {
    JSON.parse(v);
    return JSON.stringify(v); // "123" and "true" would come back as a number and a boolean
  } catch {
    return v;
  }
}

/**
 * A model call's place in a run: the n-th model call (counting from 0) of its scope. A recording made
 * without scopes has one scope, `''`, so there the place is the call's place among the run's model calls.
 */
export interface CallPlace {
  scope: string;
  index: number;
}

/** `model call 3`, or `model call 3 of scope researcher`. */
const callLabel = (at: CallPlace) => `model call ${at.index + 1}${at.scope ? ` of scope ${at.scope}` : ''}`;

/**
 * One run's interventions, resolved against its parent. A model call is found by its place among the
 * recording's model calls (the 15th, say), counted the same way on both sides: every model call,
 * whatever it sends (an embeddings call too), and a retry as the call it retries. A recording made
 * with scopes is counted per scope, the way the session matches its calls, because sub-agents running
 * at once can send their requests in another order than they were recorded in: the 15th call is then
 * the 4th of its scope. Each intervention applies to the provider its target call went to, so a model
 * id or a sampling setting meant for one provider never reaches another.
 */
export class RequestInterventions {
  private readonly inject?: { at: CallPlace; callNo: number; provider: string | null; text: string; as: InjectAs; place?: InjectionPlace; shape?: RequestShape; reached: boolean };
  private readonly set?: { at: CallPlace; callNo: number; provider: string | null; fields: Record<string, unknown>; model?: string; models?: string[]; reached: boolean };
  /** Problems with requests after the first, said once each. */
  readonly warnings: string[] = [];
  /** Whether the recording used scopes; if it didn't, scopes are ignored, as the session ignores them. */
  private readonly scoped: boolean;
  /** Model calls the replay has made so far, retries not counted, per scope. */
  private readonly counts = new Map<string, number>();

  constructor(parentCalls: CallRecord[], interventions: Interventions, onError: (message: string) => never) {
    this.scoped = parentCalls.some((c) => typeof c.meta.scope === 'string');
    const api = parentCalls.filter((c) => c.kind === 'api');
    const find = (callNo: number, flag: string) => {
      const call = api.find((c) => c.callNo === callNo);
      if (!call) onError(`${flag}: call #${callNo} is not a model call of the recording`);
      const scope = this.scopeOf(call!.meta.scope);
      const index = api.filter((c) => c.callNo < callNo && this.scopeOf(c.meta.scope) === scope).length;
      const provider = call!.meta.provider;
      return { at: { scope, index }, provider: typeof provider === 'string' ? provider : null };
    };
    if (interventions.inject) {
      const { atCall, text, as } = interventions.inject;
      this.inject = { ...find(atCall, '--inject'), callNo: atCall, text, as, reached: false };
    }
    if (interventions.set) {
      const { fromCall, fields, models } = interventions.set;
      const { model, ...rest } = fields;
      if (model !== undefined && typeof model !== 'string') onError(`--model: the model is a name, got ${JSON.stringify(model)}`);
      this.set = { ...find(fromCall, '--set'), callNo: fromCall, fields: rest, ...(typeof model === 'string' ? { model } : {}), ...(models?.length ? { models } : {}), reached: false };
    }
  }

  get active(): boolean {
    return !!this.inject || !!this.set;
  }

  private scopeOf(scope: unknown): string {
    return this.scoped && typeof scope === 'string' ? scope : '';
  }

  /** The place of a new model call made in `scope` (not a retry: a retry keeps the place of the call it retries). */
  next(scope: string | undefined): CallPlace {
    const key = this.scopeOf(scope);
    const index = this.counts.get(key) ?? 0;
    this.counts.set(key, index + 1);
    return { scope: key, index };
  }

  /** The flags as one line, for a divergence report. */
  private setFlags(): string {
    const s = this.set!;
    return [...Object.entries(s.fields).map(([k, v]) => `--set ${s.callNo}:${k}=${short(fieldValue(v))}`), ...(s.model !== undefined ? [`--model ${s.callNo}:${s.model}`] : [])].join(' ');
  }

  /**
   * One model request at `place`, as the run's interventions have it. Refuses the target call when its
   * request can't take the change, with the reason; a later request that can't is left as it is, with
   * a warning. "From the call on" means later calls of the target's scope, and once the target has been
   * reached, calls of every other scope too.
   */
  apply(place: CallPlace, provider: string, path: string, body: unknown): Rewrite {
    const isTarget = (at: CallPlace) => place.scope === at.scope && place.index === at.index;
    const fromOn = (t: { at: CallPlace; reached: boolean }) => (place.scope === t.at.scope ? place.index >= t.at.index : t.reached);
    let nextPath = path;
    let nextBody = body;
    // A setting the request already had is no change: the caller forces such a call live instead.
    let changed = false;
    const forced: string[] = [];
    const shape = requestShape(provider, path, body);
    const inj = this.inject;
    if (inj && fromOn(inj) && (inj.provider === null || inj.provider === provider)) {
      if (isTarget(inj.at)) {
        // Reached, even when refused: the refusal says why, and `unapplied` must not say it again.
        inj.reached = true;
        const placed = placeInjection(shape, body, inj.as, modelInRequest(provider, path, body)?.model ?? null);
        if (refused(placed)) return { refused: `--inject ${inj.callNo}${inj.as === 'system' ? ' --inject-as system' : ''}: ${placed.refused}` };
        inj.place = placed;
        inj.shape = shape;
      }
      if (inj.place && inj.shape === shape) {
        const injected = applyInjection(shape, nextBody, inj.text, inj.as, inj.place);
        if (injected) {
          nextBody = injected;
          changed = true;
          if (isTarget(inj.at)) forced.push(`--inject ${inj.callNo}${inj.as === 'system' ? ' --inject-as system: an instruction added as a system message' : ': an instruction added to the user turn'}`);
        }
      }
    }
    const set = this.set;
    // With models named, only the calls made with one of them change: another model's calls are someone else's.
    const named = !set?.models || set.models.some((m) => sameModel(modelInRequest(provider, path, body)?.model, m));
    if (set && fromOn(set) && (set.provider === null || set.provider === provider) && named) {
      const target = isTarget(set.at);
      if (target) set.reached = true;
      if (shape === 'other') {
        // Sampling settings and models belong to generation: an embeddings call keeps its own. Only the
        // target's is worth a word, since the CLI refuses that before a replay starts.
        if (target) this.warnOnce(`${this.setFlags()} left ${callLabel(place)} as it was: it is not a conversation (an embeddings call, or a model's native body)`);
      } else {
        if (Object.keys(set.fields).length) {
          const patched = setRequestFields(shape, nextBody, set.fields);
          if (refused(patched)) {
            if (target) return { refused: `--set ${set.callNo}: ${patched.refused}` };
            this.warnOnce(`--set ${set.callNo} left ${callLabel(place)} as it was: ${patched.refused}`);
          } else {
            nextBody = patched.body;
            changed ||= patched.changed;
          }
        }
        if (set.model !== undefined) {
          const switched = switchModel(provider, nextPath, nextBody, set.model);
          if (refused(switched)) {
            if (target) return { refused: `--model ${set.callNo}:${set.model}: ${switched.refused}` };
            this.warnOnce(`--model ${set.callNo}:${set.model} left ${callLabel(place)} as it was: ${switched.refused}`);
          } else {
            nextPath = switched.path;
            nextBody = switched.body;
            changed ||= switched.changed;
          }
        }
        if (target) forced.push(this.setFlags());
      }
    }
    const counterpart = inj && isTarget(inj.at) ? inj.callNo : (set?.callNo ?? 0);
    return { path: nextPath, body: nextBody, changed, ...(forced.length ? { target: { by: forced.join('; '), counterpart } } : {}) };
  }

  private warnOnce(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** Interventions whose call the run never reached, as sentences for the summary. */
  unapplied(): string[] {
    const out: string[] = [];
    const why = (t: { at: CallPlace; provider: string | null }) => {
      const made = this.counts.get(t.at.scope) ?? 0;
      const of = t.at.scope ? ` of scope ${t.at.scope}` : '';
      return made <= t.at.index
        ? `the replay made ${made} model call${made === 1 ? '' : 's'}${of}, and it is ${callLabel(t.at)} of the recording`
        : `the replay sent its ${callLabel(t.at)} to another provider than the recording's ${t.provider ?? ''}`.trimEnd();
    };
    if (this.inject && !this.inject.reached) out.push(`--inject ${this.inject.callNo} changed nothing: ${why(this.inject)}`);
    if (this.set && !this.set.reached) out.push(`${this.setFlags()} changed nothing: ${why(this.set)}`);
    return out;
  }
}

const ARG_LIMIT = 8_192;

/**
 * A replay's interventions as the flags that make them, for the run's record: what made this fork
 * (a banner can name it), and how to make it again (`--repeat` from the fork menu). `args` is left
 * out when a value is too large to keep on the run. `command` is the replay's command when it is not
 * its parent's (`-- <command>`): named for display only, since the run records its command anyway.
 * An override read from a file is shown by the file's name as it was typed (`sources`), one given
 * inline by its call; `args` keep the result itself either way.
 */
export function describeInterventions(replay: Partial<ReplayOptions> | undefined, interventions: Interventions | undefined, command?: string[], sources?: OverrideSources): RunIntervention[] {
  const out: RunIntervention[] = [];
  const add = (kind: RunIntervention['kind'], at: number | null, args: string[], flag?: string) => {
    const display = flag ?? args.map((a) => (a.startsWith('--') ? a : short(a, 60))).join(' ');
    out.push({ kind, at, flag: display, ...(args.every((a) => a.length <= ARG_LIMIT) ? { args } : {}) });
  };
  if (interventions?.inject) {
    const { atCall, text, as } = interventions.inject;
    add('inject', atCall, ['--inject', `${atCall}=${text}`, '--inject-as', as], `--inject ${atCall}=${short(text)}${as === 'system' ? ' --inject-as system' : ''}`);
  }
  if (interventions?.set) {
    const { fromCall, fields } = interventions.set;
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'model') add('model', fromCall, ['--model', `${fromCall}:${String(value)}`]);
      else add('set', fromCall, ['--set', `${fromCall}:${key}=${fieldValue(value)}`]);
    }
  }
  for (const [callNo, status] of replay?.failAt ?? []) add('fail', callNo, ['--fail-at', `${callNo}=${status}`]);
  for (const [callNo, failure] of replay?.toolFailures ?? []) add('fail', callNo, ['--fail-at', `${callNo}=${formatToolFailure(failure)}`]);
  for (const [callNo, value] of replay?.overrides ?? []) {
    const file = sources?.[callNo];
    add('override', callNo, ['--override', `${callNo}=${JSON.stringify(value)}`], `--override ${callNo}=${typeof file === 'string' && file.startsWith('@') ? short(file, 60) : '…'}`);
  }
  // Text that starts with `@` is kept as text, never read back as a file name.
  for (const [callNo, text] of replay?.plants ?? []) add('plant', callNo, ['--inject-result', `${callNo}=${literalValue(text)}`], `--inject-result ${callNo}=${short(text)}`);
  if (replay?.divergeAt !== undefined) add('diverge', replay.divergeAt, ['--diverge-at', String(replay.divergeAt)]);
  if (replay?.promptFrom !== undefined) add('prompt-from', replay.promptFrom, ['--prompt-from', String(replay.promptFrom)]);
  for (const name of replay?.liveTools ?? []) add('live-tool', null, ['--live-tool', name]);
  if (replay?.writes && replay.writes !== 'block') add('writes', null, ['--writes', replay.writes]);
  if (replay?.reads && replay.reads !== 'live') add('reads', null, ['--reads', replay.reads]);
  // Last, where a command line has it: everything after `--` is the agent's.
  if (command?.length) out.push({ kind: 'command', at: null, flag: short(`-- ${command.join(' ')}`, 80) });
  return out;
}
