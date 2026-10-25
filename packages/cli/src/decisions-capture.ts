import { applyNormalizers, BUILTIN_STRIPPED_KEYS, isReservedScope, loadApiRequest, maskClock, multipartView, promptOf, samePrompt, stripKeysDeep, structuralDiff, withoutPrompt, type CallRecord, type Normalizer, type RequestPrompt, type RunRecord, type Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { AGENT_NODE_TOO_OLD, refusedPreload } from './agent-node.js';
import { spawnAgent } from './agent-registry.js';
import { AgentStop, exitStatus, GROUPS, trackAgent } from './agent-signals.js';
import { codeVersion, type ShadowlapConfig } from './config.js';
import { killTree } from './kill-tree.js';
import { placeholderKeys } from './placeholder-keys.js';
import { agentEnv, outputDrained, providerIds, type GuardMode } from './run-agent.js';
import { declaredUnrecorded, unrecordedOf, unrecordedRefusal } from './unrecorded.js';

/**
 * `shadowlap decisions --from-code`: the prompt and tools the working tree sends now, read without
 * sending anything. The run is replayed offline under the code as it is, with its model calls matched
 * without their system prompt and tool definitions, as `--prompt-from` matches them: each one is
 * served from the recording while the agent sends it with the new prompt, so every model call's new
 * prompt is captured, its tools are served as recorded and nothing runs. The last model call is the
 * one `--prompt-from` forces live, and offline it reaches no provider either.
 *
 * The capture refuses, saying why, when the first model request differs in more than its prompt
 * and tools (the code changed something else that every request carries), or when the replay leaves
 * the recording before it: those are no prompt change, and verify is what tests them.
 */

export interface CapturedPrompt {
  /** The recorded model call it stands for. */
  callNo: number;
  prompt: RequestPrompt;
  /** The working tree sends another prompt or other tools than the recording did. */
  changed: boolean;
}

export interface FromCodeCapture {
  /** By the recorded call they stand for. */
  prompts: Map<number, CapturedPrompt>;
  /** Why the run can't be previewed this way; null when it can. */
  refused: string | null;
  notes: string[];
  codeVersion: string | null;
}

export interface CaptureInput {
  store: Store;
  config: Pick<ShadowlapConfig, 'normalize' | 'prices' | 'clock' | 'http'>;
  parent: RunRecord;
  argv: string[];
  commandFromImport: boolean;
  guard: GuardMode;
  /** Stop the replay after this long. */
  timeoutMs: number | null;
  cwd: string;
}

const GROUP = GROUPS;

/** The agent's model calls with a request and an answer, in call order: Shadowlap's own (its judge's, made after the agent exits) are none of them. */
const modelCalls = (calls: readonly CallRecord[]) => calls.filter((c) => c.kind === 'api' && c.requestRef && c.end && !isReservedScope(c.meta.scope));

/** What the replay's divergence report says, in a line. */
function diverged(run: RunRecord | null): string | null {
  const d = run?.divergence;
  if (!d || d.type === 'ended_early') return null;
  const first = d.diff?.slice(0, 3).map((e) => `${e.path} ${e.op}`).join(', ');
  return `#${d.callNo} (${d.kind} ${d.name})${d.reason ? `: ${d.reason}` : first ? `: ${first}` : ''}`;
}

/** Replays a run offline under the working tree's code and captures each model call's new prompt. Nothing is sent, and the replay is not kept. */
export async function captureFromCode(input: CaptureInput): Promise<FromCodeCapture> {
  const { store, parent } = input;
  const recorded = modelCalls(store.getCalls(parent.runId));
  const none = (refused: string): FromCodeCapture => ({ prompts: new Map(), refused, notes: [], codeVersion: codeVersion(input.cwd) });
  if (!recorded.length) return none('the recording has no model call to ask again');
  if (parent.meta?.covers?.length && !parent.meta.covers.some((c) => c === 'tool' || c.startsWith('tool:'))) {
    return none('the recording holds no tool calls (it was imported from captured traffic), so replaying it would run its tools for real: replay it once with your agent and preview that run');
  }
  // A tool the model called that the recording never recorded would run for real in the replay: one that writes is refused.
  const unrecorded = unrecordedRefusal(parent, unrecordedOf(store, parent.runId, declaredUnrecorded(process.cwd())), new Set(), null);
  if (unrecorded) return none(unrecorded);
  const last = recorded.at(-1)!;
  const upstreams = Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
  const sidecar = await Sidecar.start({ store, normalizers: input.config.normalize, upstreams, ...(input.config.prices ? { prices: input.config.prices } : {}), ...(input.config.clock ? { clock: input.config.clock } : {}), ...(input.config.http ? { http: input.config.http } : {}) });
  let runId: string | null = null;
  // A stop signal reaches the agent once, through its group, and the capture ends there: decisions
  // asks nothing more once it has heard one, and a second signal ends it (the exit hook kills the group).
  let signalled = false;
  const stop = new AgentStop({ group: GROUP, onSignal: () => void (signalled = true) }).start();
  try {
    const run = sidecar.startRun({
      mode: 'replay',
      parentRunId: parent.runId,
      command: { argv: input.argv, cwd: input.cwd },
      codeVersion: codeVersion(input.cwd),
      // Writes are never run, reads come from the recording even after the fork, and the last model call is forced.
      replay: { writes: 'block', reads: 'replay', liveTools: new Set(), promptFrom: last.callNo, ...(parent.meta?.covers?.length ? { kinds: new Set(parent.meta.covers) } : {}) },
      offline: true,
      ...(input.commandFromImport ? { commandFromImport: true } : {}),
    });
    runId = run.runId;
    const child = spawnAgent(input.argv[0]!, input.argv.slice(1), { cwd: input.cwd, env: { ...agentEnv(sidecar, run.runId, input.guard, upstreams), ...placeholderKeys(process.env, { calls: recorded, keyEnv: parent.meta?.keyEnv }, 'offline') }, stdio: ['ignore', 'pipe', 'pipe'], detached: GROUP }, { url: sidecar.url, runId: run.runId });
    trackAgent(child, GROUP);
    stop.add(child);
    let output = '';
    child.stdout!.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
    child.stderr!.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
    // Once a model call goes live (the forced last one, or one that left the recording), every
    // prompt there is to read has been sent: the agent is stopped there, before it does more.
    const live = () => store.query(`SELECT 1 AS x FROM call_events WHERE run_id = ? AND phase = 'start' AND kind = 'api' AND origin = 'live' LIMIT 1`, run.runId).length > 0;
    const exited = new Promise<number>((resolve) => {
      child.on('error', () => resolve(127));
      child.on('exit', (c, signal) => resolve(exitStatus(c, signal)));
    });
    const started = Date.now();
    let stopped = false;
    for (;;) {
      const done = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 40))]);
      if (done) break;
      if (live() || (input.timeoutMs !== null && Date.now() - started > input.timeoutMs)) {
        stopped = true;
        killTree(child, 'SIGTERM', { group: GROUP });
        setTimeout(() => killTree(child, 'SIGKILL', { group: GROUP }), 2_000).unref();
        await exited;
        break;
      }
    }
    if (GROUP) killTree(child, 'SIGKILL', { group: true });
    stopped ||= signalled;
    sidecar.endRun(run.runId, stopped ? 'crashed' : 'completed');
    // An agent on a Node before 18.18 never started: its Node refused the preload and exited 9, as it
    // would for every run, so none can be read here.
    if (!stopped && (await exited) === 9 && store.countCalls(run.runId) === 0) {
      await outputDrained(child);
      if (refusedPreload(output)) throw new Error(AGENT_NODE_TOO_OLD);
    }
    const replay = store.getRun(run.runId);
    const sent = store.getCalls(run.runId).filter((c) => c.kind === 'api' && c.requestRef);
    if (!sent.length) {
      const why = diverged(replay);
      return none(why ? `the replay left the recording before its first model request, at ${why}: that is a change to more than the prompt, so verify it instead` : `the replay made no model request (${output.trim().split('\n').slice(-2).join(' ') || 'the agent exited without one'})`);
    }

    // Each model call the replay sent, with the recorded one it stands for: the one it was served from,
    // else the next one in its scope.
    const taken = new Set<number>();
    const pairs: Array<{ now: CallRecord; was: CallRecord }> = [];
    for (const c of sent) {
      let was = c.end?.meta.replayedFrom !== undefined ? recorded.find((r) => r.callNo === c.end!.meta.replayedFrom) : undefined;
      was ??= recorded.find((r) => !taken.has(r.callNo) && (r.meta.scope ?? null) === (c.meta.scope ?? null) && !sent.some((s) => s.end?.meta.replayedFrom === r.callNo));
      if (!was || taken.has(was.callNo)) continue;
      taken.add(was.callNo);
      pairs.push({ now: c, was });
    }
    const rules: Normalizer[] = [...input.config.normalize, ...(parent.meta?.redactions ?? [])];
    const clock = input.config.clock === 'exact' ? undefined : [parent.startedAt, replay?.startedAt ?? Date.now()];
    // A request as matching reads it without its prompt, as the sidecar fingerprints it under --prompt-from.
    const masked = (call: CallRecord, body: unknown) => {
      const view = stripKeysDeep(withoutPrompt(multipartView(body)), BUILTIN_STRIPPED_KEYS);
      return applyNormalizers(clock ? maskClock(view, clock) : view, rules, 'api', call.name);
    };
    const prompts = new Map<number, CapturedPrompt>();
    const notes: string[] = [];
    for (const [i, { now, was }] of pairs.entries()) {
      const body = loadApiRequest(store, now.requestRef!);
      const before = loadApiRequest(store, was.requestRef!);
      // Served from the recording, it matched without its prompt; live, it may differ in more.
      if (now.origin === 'live') {
        const beyond = structuralDiff(masked(was, before), masked(now, body));
        if (beyond.length) {
          const shown = beyond.slice(0, 3).map((e) => `${e.path} ${e.op}`).join(', ');
          if (i === 0) return none(`the first model request (#${was.callNo}) differs in more than its system prompt and tools (${shown}${beyond.length > 3 ? `, ${beyond.length - 3} more` : ''}): --from-code previews a prompt change, and this is another change, so verify it instead`);
          notes.push(`From model call #${was.callNo} on, the working tree sends more than a new prompt (${shown}); the steps from there are asked with the prompt it sends them, the rest as recorded.`);
          prompts.set(was.callNo, { callNo: was.callNo, prompt: promptOf(body), changed: !samePrompt(promptOf(body), promptOf(before)) });
          break;
        }
      }
      prompts.set(was.callNo, { callNo: was.callNo, prompt: promptOf(body), changed: !samePrompt(promptOf(body), promptOf(before)) });
    }
    const missed = recorded.filter((r) => !prompts.has(r.callNo));
    if (missed.length) {
      const why = diverged(replay);
      notes.push(`The offline replay reached ${prompts.size} of the run's ${recorded.length} model calls${why ? ` (it left the recording at ${why})` : ''}; the other ${missed.length} are asked with the prompt the working tree sent the last call before them in their scope.`);
      for (const r of missed) {
        const earlier = [...prompts.values()].filter((p) => p.callNo < r.callNo && (recorded.find((x) => x.callNo === p.callNo)?.meta.scope ?? null) === (r.meta.scope ?? null)).at(-1);
        if (!earlier) continue;
        const before = promptOf(loadApiRequest(store, r.requestRef!));
        prompts.set(r.callNo, { callNo: r.callNo, prompt: earlier.prompt, changed: !samePrompt(earlier.prompt, before) });
      }
    }
    return { prompts, refused: null, notes, codeVersion: codeVersion(input.cwd) };
  } finally {
    stop.stop();
    // The replay was a way to read the prompt, not a run anyone made: it is not kept.
    if (runId) {
      try {
        store.deleteRun(runId);
      } catch {
        // left for gc
      }
    }
    await sidecar.close();
  }
}
