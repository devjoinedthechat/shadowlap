import { applyInjection, formatToolFailure, placeInjection, refused, requestShape, setRequestFields, switchModel, type CallRecord, type InjectAs, type InjectionPlace, type ReplayOptions, type RequestShape, type RunIntervention } from '@shadowlap/engine';

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
  };
}

/** What `apply` did to one request. */
export type Rewrite =
  | { path: string; body: unknown; changed: boolean; forced?: { by: string; counterpart: number } }
  | { refused: string };

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fieldValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * One run's interventions, resolved against its parent. A model call is found by its place among the
 * recording's model calls (the 15th, say), counted the same way on both sides: every model call,
 * whatever it sends (an embeddings call too), and a retry as the call it retries. Each intervention
 * applies to the provider its target call went to, so a model id or a sampling setting meant for one
 * provider never reaches another.
 */
export class RequestInterventions {
  private readonly inject?: { apiIndex: number; callNo: number; provider: string | null; text: string; as: InjectAs; place?: InjectionPlace; shape?: RequestShape; reached: boolean };
  private readonly set?: { apiIndex: number; callNo: number; provider: string | null; fields: Record<string, unknown>; model?: string; reached: boolean };
  /** Problems with requests after the first, said once each. */
  readonly warnings: string[] = [];
  private modelCalls = 0;

  constructor(parentCalls: CallRecord[], interventions: Interventions, onError: (message: string) => never) {
    const api = parentCalls.filter((c) => c.kind === 'api');
    const find = (callNo: number, flag: string) => {
      const i = api.findIndex((c) => c.callNo === callNo);
      if (i < 0) onError(`${flag}: call #${callNo} is not a model call of the recording`);
      const provider = api[i]!.meta.provider;
      return { apiIndex: i, provider: typeof provider === 'string' ? provider : null };
    };
    if (interventions.inject) {
      const { atCall, text, as } = interventions.inject;
      this.inject = { ...find(atCall, '--inject'), callNo: atCall, text, as, reached: false };
    }
    if (interventions.set) {
      const { fromCall, fields } = interventions.set;
      const { model, ...rest } = fields;
      if (model !== undefined && typeof model !== 'string') onError(`--model: the model is a name, got ${JSON.stringify(model)}`);
      this.set = { ...find(fromCall, '--set'), callNo: fromCall, fields: rest, ...(typeof model === 'string' ? { model } : {}), reached: false };
    }
  }

  get active(): boolean {
    return !!this.inject || !!this.set;
  }

  /** The flags as one line, for a divergence report. */
  private setFlags(): string {
    const s = this.set!;
    return [...Object.entries(s.fields).map(([k, v]) => `--set ${s.callNo}:${k}=${short(fieldValue(v))}`), ...(s.model !== undefined ? [`--model ${s.callNo}:${s.model}`] : [])].join(' ');
  }

  /**
   * One model request, as the run's interventions have it: `apiIndex` is its place among the run's
   * model calls (a retry keeps the place of the call it retries). Refuses the target call when its
   * request can't take the change, with the reason; a later request that can't is left as it is,
   * with a warning.
   */
  apply(apiIndex: number, provider: string, path: string, body: unknown): Rewrite {
    this.modelCalls = Math.max(this.modelCalls, apiIndex + 1);
    let nextPath = path;
    let nextBody = body;
    let changed = false;
    const forced: string[] = [];
    const shape = requestShape(provider, path, body);
    const inj = this.inject;
    if (inj && apiIndex >= inj.apiIndex && (inj.provider === null || inj.provider === provider)) {
      if (apiIndex === inj.apiIndex) {
        const place = placeInjection(shape, body, inj.as);
        if (refused(place)) return { refused: `--inject ${inj.callNo}${inj.as === 'system' ? ' --inject-as system' : ''}: ${place.refused}` };
        inj.place = place;
        inj.shape = shape;
        inj.reached = true;
      }
      if (inj.place && inj.shape === shape) {
        const injected = applyInjection(shape, nextBody, inj.text, inj.as, inj.place);
        if (injected) {
          nextBody = injected;
          changed = true;
          if (apiIndex === inj.apiIndex) forced.push(`--inject ${inj.callNo}${inj.as === 'system' ? ' --inject-as system: an instruction added as a system message' : ': an instruction added to the user turn'}`);
        }
      }
    }
    const set = this.set;
    if (set && apiIndex >= set.apiIndex && (set.provider === null || set.provider === provider)) {
      const target = apiIndex === set.apiIndex;
      if (target) set.reached = true;
      if (shape === 'other') {
        // Sampling settings and models belong to generation: an embeddings call keeps its own. Only the
        // target's is worth a word, since the CLI refuses that before a replay starts.
        if (target) this.warnOnce(`${this.setFlags()} left model call ${apiIndex + 1} as it was: it is not a conversation (an embeddings call, or a model's native body)`);
      } else {
        if (Object.keys(set.fields).length) {
          const patched = setRequestFields(shape, nextBody, set.fields);
          if (refused(patched)) {
            if (target) return { refused: `--set ${set.callNo}: ${patched.refused}` };
            this.warnOnce(`--set ${set.callNo} left model call ${apiIndex + 1} as it was: ${patched.refused}`);
          } else {
            nextBody = patched.body;
            changed = true;
          }
        }
        if (set.model !== undefined) {
          const switched = switchModel(provider, nextPath, nextBody, set.model);
          if (refused(switched)) {
            if (target) return { refused: `--model ${set.callNo}:${set.model}: ${switched.refused}` };
            this.warnOnce(`--model ${set.callNo}:${set.model} left model call ${apiIndex + 1} as it was: ${switched.refused}`);
          } else {
            nextPath = switched.path;
            nextBody = switched.body;
            changed = true;
          }
        }
        if (target) forced.push(this.setFlags());
      }
    }
    const counterpart = inj && apiIndex === inj.apiIndex ? inj.callNo : (set?.callNo ?? 0);
    return { path: nextPath, body: nextBody, changed, ...(forced.length ? { forced: { by: forced.join('; '), counterpart } } : {}) };
  }

  private warnOnce(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** Interventions whose call the run never reached, as sentences for the summary. */
  unapplied(): string[] {
    const out: string[] = [];
    const why = (apiIndex: number, provider: string | null) =>
      this.modelCalls <= apiIndex ? `the replay made ${this.modelCalls} model call${this.modelCalls === 1 ? '' : 's'}, and it is model call ${apiIndex + 1} of the recording` : `the replay sent its model call ${apiIndex + 1} to another provider than the recording's ${provider ?? ''}`.trimEnd();
    if (this.inject && !this.inject.reached) out.push(`--inject ${this.inject.callNo} changed nothing: ${why(this.inject.apiIndex, this.inject.provider)}`);
    if (this.set && !this.set.reached) out.push(`${this.setFlags()} changed nothing: ${why(this.set.apiIndex, this.set.provider)}`);
    return out;
  }
}

const ARG_LIMIT = 8_192;

/**
 * A replay's interventions as the flags that make them, for the run's record: what made this fork
 * (a banner can name it), and how to make it again (`--repeat` from the fork menu). `args` is left
 * out when a value is too large to keep on the run.
 */
export function describeInterventions(replay: Partial<ReplayOptions> | undefined, interventions: Interventions | undefined): RunIntervention[] {
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
  for (const [callNo, value] of replay?.overrides ?? []) add('override', callNo, ['--override', `${callNo}=${JSON.stringify(value)}`], `--override ${callNo}=…`);
  for (const [callNo, text] of replay?.plants ?? []) add('plant', callNo, ['--inject-result', `${callNo}=${text}`], `--inject-result ${callNo}=${short(text)}`);
  if (replay?.divergeAt !== undefined) add('diverge', replay.divergeAt, ['--diverge-at', String(replay.divergeAt)]);
  if (replay?.promptFrom !== undefined) add('prompt-from', replay.promptFrom, ['--prompt-from', String(replay.promptFrom)]);
  for (const name of replay?.liveTools ?? []) add('live-tool', null, ['--live-tool', name]);
  if (replay?.writes && replay.writes !== 'block') add('writes', null, ['--writes', replay.writes]);
  if (replay?.reads && replay.reads !== 'live') add('reads', null, ['--reads', replay.reads]);
  return out;
}
