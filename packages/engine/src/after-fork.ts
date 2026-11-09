import { agentCallsOf } from './judge-scope.js';
import type { Palette } from './report.js';
import { dimLines } from './report.js';
import type { CallRecord } from './types.js';
import type { VerifiedRun } from './verify.js';
import { shortRunId as short } from './words.js';

/**
 * Where the tool calls an attempt made after its fork were answered from. Up to the fork every call
 * is served from the recording; after it, a model call runs live, which is the point of an attempt,
 * but a tool call is answered from the recording, live, by a stub, or blocked, by the replay's
 * policies (session.ts `afterFork`, `unmatched`). A verdict is only as good as those answers: a
 * stubbed write's is no tool's, a blocked call's is an error the agent sees, and a person's recorded
 * answers keep coming in the order they were given, whatever the agent now asked.
 */
export interface AfterFork {
  /** Answered as recorded: a pure tool, a read under `--reads replay`, a write the recording made, each with the same arguments. */
  recorded: number;
  /** A person's recorded answers, served in the order they were given (`user_input`). */
  inOrder: number;
  /** Run live: what the tool answers today. */
  live: number;
  /** A write answered by its stub. */
  stubbed: number;
  /** Blocked or fenced: the agent got an error. */
  blocked: number;
}

const NONE: AfterFork = { recorded: 0, inOrder: 0, live: 0, stubbed: 0, blocked: 0 };

/**
 * The agent's tool calls from `forkedAt` on (the attempt's own call numbers), by where each was
 * answered from; null for an attempt that replayed clean. A judge check's calls are none of the agent's.
 */
export function afterForkOf(calls: readonly CallRecord[], forkedAt: number | null): AfterFork | null {
  if (forkedAt === null) return null;
  const n = { ...NONE };
  for (const c of agentCallsOf(calls)) {
    if (c.kind !== 'tool' || c.callNo < forkedAt) continue;
    if (c.origin === 'replayed') n[c.meta.input === true ? 'inOrder' : 'recorded']++;
    else if (c.origin === 'live' || c.origin === 'stubbed' || c.origin === 'blocked') n[c.origin]++;
  }
  return n;
}

/** Tool calls an arm made after its forks, summed over its attempts that counted them. */
interface Arm {
  attempts: number;
  calls: AfterFork;
}

const total = (n: AfterFork) => n.recorded + n.inOrder + n.live + n.stubbed + n.blocked;

function armOf(attempts: ReadonlyArray<{ afterFork?: AfterFork | undefined }>): Arm {
  const calls = { ...NONE };
  let counted = 0;
  for (const a of attempts) {
    if (!a.afterFork) continue;
    counted++;
    for (const k of Object.keys(calls) as Array<keyof AfterFork>) calls[k] += a.afterFork[k];
  }
  return { attempts: counted, calls };
}

/** `the change's 9 attempts made 41 tool calls: 35 answered as recorded, 4 stubbed`, naming only what some call got. */
function described(whose: string, arm: Arm): string {
  const n = arm.calls;
  const parts = [
    n.recorded ? `${n.recorded} answered as recorded` : '',
    n.inOrder ? `${n.inOrder} given a person's recorded answers in order` : '',
    n.live ? `${n.live} ran live` : '',
    n.stubbed ? `${n.stubbed} stubbed` : '',
    n.blocked ? `${n.blocked} blocked` : '',
  ].filter(Boolean);
  const all = total(n);
  return `${whose} ${arm.attempts} attempt${arm.attempts === 1 ? '' : 's'} made ${all} tool call${all === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/**
 * What answered the attempts after their forks, in one sentence: the change's, and its good runs'
 * baselines' apart, as the report's line says it (`afterForkLines`) and a fix's Verify step shows it.
 * Null when the change's attempts made no tool call after a fork, or none counted them (each replayed
 * clean, or a report made before attempts did).
 */
export function afterForkSentence(runs: readonly Pick<VerifiedRun, 'attempts' | 'baselineRuns'>[]): string | null {
  const change = armOf(runs.flatMap((r) => r.attempts));
  if (!total(change.calls)) return null;
  const base = armOf(runs.flatMap((r) => r.baselineRuns ?? []));
  const baseline = base.attempts ? `; ${described("the baselines'", base)}` : '';
  return `after the fork, ${described("the change's", change)}${baseline}`;
}

/** The report's line on what answered the attempts after their forks (`afterForkSentence`); none when the sentence is. */
export function afterForkLines(runs: readonly Pick<VerifiedRun, 'attempts' | 'baselineRuns'>[], p: Palette, columns?: number | null): string[] {
  const sentence = afterForkSentence(runs);
  return sentence ? dimLines(p, '  ', sentence, columns) : [];
}

/** Of an arm's tool calls after the fork, the share no tool answered: stubbed or blocked. */
const unanswered = (n: AfterFork) => (n.stubbed + n.blocked) / total(n);

/** How much more of the change's arm went unanswered than its baseline's before the arms count as apart: 10 points. */
const APART = 0.1;

/**
 * What the evidence lacks after the forks, for decideVerify's warnings:
 *
 * - a good run whose change arm got stubbed or blocked answers for a larger share of its tool calls
 *   than its baseline arm did, by 10 points or more: the arms ran against different answers, so the
 *   pairing that makes them comparable holds less where the verdict turns on those calls;
 * - attempts of the change served a person's recorded answers after the fork: where the change alters
 *   the conversation, they may no longer fit it.
 */
export function afterForkWarnings(runs: readonly Pick<VerifiedRun, 'runId' | 'role' | 'attempts' | 'baselineRuns'>[]): string[] {
  const warnings: string[] = [];
  for (const r of runs) {
    const change = armOf(r.attempts).calls;
    const base = armOf(r.baselineRuns ?? []).calls;
    if (r.role !== 'good' || !total(change) || !total(base) || unanswered(change) - unanswered(base) < APART) continue;
    const share = (n: AfterFork) => `${n.stubbed + n.blocked} of ${total(n)}`;
    warnings.push(`good run ${short(r.runId)}: the change's attempts got stubbed or blocked answers for ${share(change)} tool calls after the fork, its baseline's for ${share(base)}, so the two arms didn't run against the same answers`);
  }
  const inOrder = runs.flatMap((r) => r.attempts).filter((a) => a.afterFork?.inOrder).length;
  if (inOrder) warnings.push(`${inOrder} attempt${inOrder === 1 ? '' : 's'} of the change got a person's recorded answers after the fork, in the order they were given, whatever the agent then asked: where the change alters the conversation, they may not fit it`);
  return warnings;
}
