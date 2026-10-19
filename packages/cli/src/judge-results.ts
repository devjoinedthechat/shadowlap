import { aboutUsd, type JudgeOutcome } from '@shadowlap/engine';
import type { CheckResult } from './checks.js';
import type { JudgeCheck } from './judge-check.js';

/**
 * Judge checks as check results: passed when the judge's verdict is the one the check passes on,
 * failed when it is the other, and inconclusive, never passed, when there is no verdict, with why
 * (no recorded verdict, and no way to ask the judge live). Each keeps the judge's reason, where its
 * verdict came from and what it cost, so every report shows them beside the check.
 */

/** A judge check's verdict, as `evaluateChecks` takes it (`judgeVerdicts`), by the check's name. */
export interface JudgeVerdictEntry {
  verdict: 'yes' | 'no';
  reason: string;
  source: 'recording' | 'live';
}

/** A verdict with what the judge run knows of it besides: what it cost, what the judge read, its call. */
export interface JudgedEntry extends JudgeVerdictEntry {
  cost?: number | null;
  redactions?: number;
  normalized?: boolean;
  cut?: number;
  callNo?: number;
}

export interface JudgeInputs {
  judgeVerdicts?: ReadonlyMap<string, JudgeVerdictEntry | JudgedEntry>;
  /** Why a judge check has no verdict, by its name: no recorded verdict, and no way to ask live. */
  notJudged?: ReadonlyMap<string, string>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a judge check expects, as its result's label: `explains-escalation: the judge answers yes to "Does the reply say why?"`. */
export function judgeLabel(j: Pick<JudgeCheck, 'name' | 'question' | 'pass'>): string {
  return `${j.name}: the judge answers ${j.pass} to "${clip(j.question, 100)}"`;
}

export function judgeResults(judges: readonly JudgeCheck[], inputs: JudgeInputs = {}): CheckResult[] {
  return judges.map((j) => {
    const v = inputs.judgeVerdicts?.get(j.name);
    const extra = (v ?? {}) as Partial<JudgedEntry>;
    const judge: JudgeOutcome = {
      name: j.name,
      model: j.model,
      of: j.of,
      verdict: v?.verdict ?? null,
      source: v?.source ?? null,
      cost: v ? (extra.cost !== undefined ? extra.cost : v.source === 'recording' ? 0 : null) : null,
      redactions: extra.redactions ?? 0,
      normalized: extra.normalized ?? false,
      cut: extra.cut ?? 0,
      ...(extra.callNo !== undefined ? { callNo: extra.callNo } : {}),
    };
    const label = judgeLabel(j);
    if (!v) {
      const why = inputs.notJudged?.get(j.name) ?? 'no recorded verdict';
      return { ok: false, status: 'inconclusive', label, detail: `not judged: ${why}`, judge };
    }
    const ok = v.verdict === j.pass;
    const reason = v.reason || 'no reason given';
    return { ok, status: ok ? 'passed' : 'failed', label, detail: `the judge answered ${v.verdict}: ${reason}`, reason, judge };
  });
}

/** Where a judge check's verdict came from and what it cost: `judged from the recording, free`, `judged live, ≈$0.0004`. */
export function judgeSource(j: JudgeOutcome): string | null {
  if (!j.source) return null;
  const read = [
    j.redactions ? `read with ${j.redactions} redaction rule${j.redactions === 1 ? '' : 's'} applied` : null,
    j.normalized ? 'values that change every run masked' : null,
    j.cut ? `${j.cut.toLocaleString('en-US')} characters left out` : null,
  ].filter(Boolean);
  const how = j.source === 'recording' ? 'judged from the recording, free' : `judged live, ${j.cost === null ? `no price for ${j.model}` : aboutUsd(j.cost)}`;
  return [how, ...read].join(' · ');
}

/** A check result as one line, a judge check's with its verdict, reason and where it came from. */
export function checkLine(c: CheckResult): string {
  // Never a pass, and never a failure of the agent's: the words say which.
  if (c.status === 'inconclusive') return `? ${c.label}: inconclusive, ${c.detail}`;
  const mark = c.ok ? '✓' : '✗';
  if (!c.judge) return c.ok ? `${mark} ${c.label}` : `${mark} ${c.label}: ${c.detail}`;
  const source = judgeSource(c.judge);
  return `${mark} ${c.label}: ${c.detail}${source ? ` (${source})` : ''}`;
}
