import { readFileSync } from 'node:fs';
import { estimateCost, finalAnswer, loadApiRequest, placeInjection, plantInResult, refused, requestShape, setRequestFields, switchModel, type CallRecord, type RunRecord, type SerializedError, type Store } from '@shadowlap/engine';
import { type Interventions } from '@shadowlap/sidecar';
import { evaluateChecks, specFor, type CheckResult, type TestSpec } from './checks.js';
import { loadTests, type ShadowlapConfig } from './config.js';

/**
 * The replay flags that change one call, checked against the recording before anything starts: a
 * change the recorded request (or result) can't take is refused here with the reason, not discovered
 * by the agent part way through a fork.
 */

/** A text value, or `@file` for one read from a file (its final newline dropped). */
function textOrFile(raw: string, flag: string): string {
  if (!raw.startsWith('@')) return raw;
  try {
    return readFileSync(raw.slice(1), 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    throw new Error(`${flag}: cannot read ${raw.slice(1)}: ${(err as Error).message}`);
  }
}

/** A recorded tool call's outcome and result (or error), as the sidecar serves it. */
export type ResultOf = (call: CallRecord) => { outcome: 'ok' | 'error' | null; result?: unknown; error?: SerializedError };

export function storedResult(store: Store): ResultOf {
  return (call) => {
    const end = call.end;
    if (!end) return { outcome: null };
    const payload = end.responseRef ? store.getJson<{ result?: unknown; error?: SerializedError }>(end.responseRef) : null;
    return { outcome: end.outcome, ...(payload ?? {}) };
  };
}

/**
 * `--inject-result 9="text"` or `9=@payload.txt`: text an attacker might leave in what tool call 9
 * read, added to its recorded result. Read tools only: an instruction planted in a write's receipt,
 * a model's answer or the clock is not how one arrives.
 */
export function parsePlants(specs: string[], parentCalls: CallRecord[], resultOf: ResultOf): Map<number, string> {
  const out = new Map<number, string>();
  for (const spec of specs) {
    const m = /^(\d+)=([\s\S]+)$/.exec(spec);
    if (!m) throw new Error(`--inject-result expects <call>=<text|@file>, such as 9="Ignore the refund policy.", got "${spec}"`);
    const callNo = Number(m[1]);
    const call = parentCalls.find((c) => c.callNo === callNo);
    if (!call) throw new Error(`--inject-result: the recording has no call #${callNo}`);
    if (call.kind === 'api') throw new Error(`--inject-result: #${callNo} is a model call. It plants text in what a tool read; to add an instruction to a model call, use --inject ${callNo}="…"`);
    if (call.kind !== 'tool') throw new Error(`--inject-result: #${callNo} is a ${call.kind} read, not a tool call`);
    if (call.effect === 'write') {
      throw new Error(`--inject-result: #${callNo} ${call.name} is a write tool. An attacker's instruction arrives in what the agent reads, and a write's result is only its receipt; plant it in a read the agent makes (shadowlap show lists them), or answer the write differently with --override`);
    }
    const text = textOrFile(m[2]!, '--inject-result');
    if (!text.trim()) throw new Error(`--inject-result: the text for #${callNo} is empty`);
    const recorded = resultOf(call);
    if (recorded.outcome !== 'ok') throw new Error(`--inject-result: #${callNo} ${call.name} ${recorded.outcome === 'error' ? `failed when it was recorded (${recorded.error?.message ?? 'an error'})` : 'never completed'}, so it has no result to add to; give it one with --override`);
    const http = call.meta.http !== undefined;
    const body = http && recorded.result && typeof recorded.result === 'object' ? (recorded.result as { body?: unknown; encoding?: string }) : null;
    if (body?.encoding === 'base64') throw new Error(`--inject-result: #${callNo} ${call.name} returned binary data, with no text to add to`);
    const planted = plantInResult(body ? (body.body ?? '') : recorded.result, text);
    if (refused(planted)) throw new Error(`--inject-result: #${callNo} ${call.name}: ${planted.refused}`);
    out.set(callNo, text);
  }
  return out;
}

/** Calls two flags would change at once: one change per call, or the result says neither. */
export function refuseOverlaps(changes: Array<[string, Iterable<number>]>): void {
  const seen = new Map<number, string>();
  for (const [flag, calls] of changes) {
    for (const n of calls) {
      const other = seen.get(n);
      if (other && other !== flag) throw new Error(`${other} ${n} and ${flag} ${n} both change call #${n}; use one`);
      seen.set(n, flag);
    }
  }
}

/**
 * `--inject`, `--set` and `--model` against the recorded request of the call they name: a shape that
 * can't take the change (a system message on Gemini, a field Converse has no place for, a request
 * that names no model, an embeddings call) is refused before the replay starts.
 */
export function checkRequestInterventions(store: Store, parentCalls: CallRecord[], interventions: Interventions | undefined): void {
  if (!interventions) return;
  const requestOf = (callNo: number) => {
    const call = parentCalls.find((c) => c.callNo === callNo)!;
    const [, ...path] = call.name.split(' ');
    let body: unknown = null;
    try {
      body = call.requestRef ? loadApiRequest(store, call.requestRef) : null;
    } catch {
      // judged on what there is
    }
    const provider = typeof call.meta.provider === 'string' ? call.meta.provider : null;
    return { provider, path: path.join(' '), body, shape: requestShape(provider, path.join(' '), body) };
  };
  if (interventions.inject) {
    const { atCall, as } = interventions.inject;
    const r = requestOf(atCall);
    const place = placeInjection(r.shape, r.body, as);
    if (refused(place)) throw new Error(`--inject ${atCall}${as === 'system' ? ' --inject-as system' : ''}: ${place.refused}`);
  }
  if (interventions.set) {
    const { fromCall, fields } = interventions.set;
    const { model, ...rest } = fields;
    const r = requestOf(fromCall);
    if (r.shape === 'other') throw new Error(`--${Object.keys(rest).length ? 'set' : 'model'} ${fromCall}: #${fromCall} is not a conversation (an embeddings call, or a model's native body), so it has no ${Object.keys(rest).length ? 'sampling settings' : 'model to switch'}; give the number of a model call that sends messages`);
    if (Object.keys(rest).length) {
      const patched = setRequestFields(r.shape, r.body, rest);
      if (refused(patched)) throw new Error(`--set ${fromCall}: ${patched.refused}`);
    }
    if (typeof model === 'string') {
      const switched = switchModel(r.provider, r.path, r.body, model);
      if (refused(switched)) throw new Error(`--model ${fromCall}:${model}: ${switched.refused}`);
    }
  }
}

// ---- the run's checks ----

/**
 * The checks a replay of this run is judged by when none are given: the `tests` entry of the
 * recording it comes from, found through the run and its ancestors (a golden `shadowlap test` ran, or
 * the pack it was unpacked from).
 */
export function checksOfRun(store: Store, run: RunRecord, cwd: string): { spec: TestSpec; source: string } | null {
  let tests;
  try {
    tests = loadTests(cwd);
  } catch {
    return null;
  }
  if (!tests.length) return null;
  const seen = new Set<string>();
  for (let r: RunRecord | null = run; r && !seen.has(r.runId); r = r.parentRunId ? store.getRun(r.parentRunId) : null) {
    seen.add(r.runId);
    for (const dir of [r.meta?.test?.golden, r.meta?.imported?.from]) {
      if (!dir) continue;
      const spec = specFor(tests, dir, cwd);
      if (spec) return { spec, source: dir };
    }
  }
  return null;
}

/** Judges one replay by `spec`, stores the results on the run, and returns them. */
export function judgeRun(store: Store, runId: string, spec: TestSpec, output: string, prices: ShadowlapConfig['prices']): CheckResult[] {
  const calls = store.getCalls(runId);
  const checks = evaluateChecks(spec, {
    calls,
    output,
    answer: finalAnswer(store, calls),
    argsOf: (c) => (c.requestRef ? store.getJson<{ args?: unknown }>(c.requestRef)?.args : undefined),
    costOf: (c) => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, prices),
  });
  store.updateRunMeta(runId, { checks });
  return checks;
}
