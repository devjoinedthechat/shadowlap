import type { ActionItem, BlameView, CacheMissView, CallDetail, CheckView, FixView, Intervention, Meta, NotRecordedView, PromptChoice, RunDetail, RunListItem, RunOutcomeView, RunStateView } from './types.js';

/**
 * The API's answers in the one shape the views read. Parts of the API name some fields their own
 * way: a cache miss counts `sentAgain`, an unrecorded host is `{target, count, action}`, a row of
 * the run list says `lostAt` and `attemptOf`, an action without a place in the fork menu has `group:
 * null`. Each is turned into what the views expect here, once, as it arrives; what this does not
 * know is left alone. A run can come from someone else's pack, so nothing is trusted to have its
 * shape. No DOM here: the tests import it.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A sentence for a disabled control's hover: capitalised, with its full stop. */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// ---------------------------------------------------------------------------------------------- meta

export function normalizeMeta(m: Meta): Meta {
  const out: Meta = { ...m };
  if (m.live !== undefined) out.live = Array.isArray(m.live) ? m.live.filter((l) => isObject(l) && typeof l.runId === 'string').map((l) => ({ runId: l.runId, calls: int(l.calls) ?? 0, ...(int(l.events) !== null ? { events: int(l.events)! } : {}) })) : [];
  if (m.jobKinds !== undefined) out.jobKinds = Array.isArray(m.jobKinds) ? m.jobKinds.filter((k): k is string => typeof k === 'string') : [];
  const reason = str(m.readOnlyReason);
  out.readOnlyReason = reason ? sentence(reason) : null;
  return out;
}

// ---------------------------------------------------------------------------------------------- the run list

/**
 * The run list: where blame found a run lost (`lostAt` or `blame`), and which runs are attempts
 * bundled under another (`attemptOf`, or the `repeat`, `probe` and `verify` markers). An attempt
 * whose run is not in the list is listed like any run, rather than vanishing.
 */
export function normalizeRuns(list: readonly RunListItem[]): RunListItem[] {
  const ids = new Set(list.map((r) => r.runId));
  return list.map((r) => {
    const out: RunListItem = { ...r };
    const lost = int(r.lostAt);
    if (!(isObject(r.blame) && int(r.blame.callNo) !== null) && lost !== null) out.blame = { callNo: lost };
    const of = str(r.attemptOf);
    if (of && !r.attempt && !r.repeat && !r.probe && !r.verify) out.attempt = ids.has(of) ? of : null;
    return out;
  });
}

// ---------------------------------------------------------------------------------------------- a run

function normalizeMiss(m: unknown): CacheMissView | null {
  if (!isObject(m)) return null;
  const callNo = int(m.callNo);
  const tokens = num(m.tokens) ?? num(m.sentAgain);
  if (callNo === null || tokens === null) return null;
  return { callNo, tokens, previousCallNo: int(m.previousCallNo), scope: str(m.scope) };
}

function normalizeNotRecorded(v: unknown): NotRecordedView | null {
  if (!isObject(v)) return null;
  const hosts = (Array.isArray(v.hosts) ? v.hosts : [])
    .map((h) => (typeof h === 'string' ? { target: h, count: null, action: null } : isObject(h) && typeof h.target === 'string' ? { target: h.target, count: int(h.count), action: h.action === 'blocked' || h.action === 'warned' ? h.action : null } : null))
    .filter((h): h is NotRecordedView['hosts'][number] => h !== null);
  const tools = (Array.isArray(v.tools) ? v.tools : []).filter((t): t is string => typeof t === 'string');
  return hosts.length || tools.length ? { hosts, tools } : null;
}

function normalizeBlame(v: unknown): BlameView | null {
  if (!isObject(v)) return null;
  const modelCall = isObject(v.modelCall) && int(v.modelCall.k) !== null && int(v.modelCall.m) !== null ? { k: int(v.modelCall.k)!, m: int(v.modelCall.m)! } : null;
  const outcome = v.outcome === 'blamed' || v.outcome === 'unrescuable' || v.outcome === 'stopped' ? v.outcome : null;
  return { callNo: int(v.callNo), modelCall, confidence: str(v.confidence), rescuedRunId: str(v.rescuedRunId), scope: str(v.scope), outcome, ...(v.unsettled === true ? { unsettled: true } : {}), short: str(v.short) };
}

const FIX_ROLES = ['failing', 'good', 'probe', 'rescued', 'verify', 'unblamed'];

/**
 * The fix a run belongs to, in either shape: `{id, status, title}`, or how the run takes part in
 * Fixes as the fixes read model says it (`{role, fix: {fixId, title, status, href}, blame, expect}`).
 * For a failing run that one also carries its blame, with what asking again did in a few words; a
 * probe's or a rescued fork's blame is the blame of the run it came from, so it is not this run's.
 */
export function normalizeFix(v: unknown): { fix: FixView | null; role: string | null; blame: BlameView | null; expect: unknown; probe?: { of: string; callNo: number }; verify?: { href: string } } {
  const none = { fix: null, role: null, blame: null, expect: undefined };
  if (!isObject(v)) return none;
  if (typeof v.id === 'string') return { ...none, fix: { id: v.id, status: str(v.status) ?? 'open', title: str(v.title) ?? v.id, href: str(v.href) } };
  const role = typeof v.role === 'string' && FIX_ROLES.includes(v.role) ? v.role : null;
  if (!role) return none;
  const f = v.fix;
  const fix = isObject(f) && typeof f.fixId === 'string' ? { id: f.fixId, status: str(f.status) ?? 'open', title: str(f.title) ?? f.fixId, href: str(f.href), check: str(f.check) } : null;
  const b = v.blame;
  let blame: BlameView | null = null;
  if (role === 'failing' && isObject(b)) {
    const k = int(b.step);
    const m = int(b.steps);
    const outcome = b.outcome === 'blamed' || b.outcome === 'unrescuable' || b.outcome === 'stopped' ? b.outcome : null;
    blame = { callNo: int(b.lostAt), modelCall: k !== null && m !== null && k >= 1 && k <= m ? { k, m } : null, confidence: str(b.confidence), rescuedRunId: str(b.rescuedRunId), scope: null, outcome, ...(b.unsettled === true ? { unsettled: true } : {}), short: str(b.short) };
  }
  // An attempt's banner links back to its probe on the fix's Blame step, or to the verdict it counted towards.
  const p = v.probe;
  const probe = isObject(p) && typeof p.of === 'string' && int(p.callNo) !== null ? { of: p.of, callNo: int(p.callNo)! } : null;
  const vf = v.verify;
  const verify = isObject(vf) && typeof vf.href === 'string' && vf.href.startsWith('#/') ? { href: vf.href } : null;
  return { fix, role, blame, expect: role === 'unblamed' && v.expect !== undefined && v.expect !== null ? v.expect : undefined, ...(probe ? { probe } : {}), ...(verify ? { verify } : {}) };
}

function normalizeChecks(v: unknown): CheckView[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((c): c is Record<string, unknown> => isObject(c) && typeof c.label === 'string' && typeof c.ok === 'boolean')
    .map((c) => {
      const out: CheckView = { label: c.label as string, ok: c.ok as boolean };
      if (c.status === 'passed' || c.status === 'failed' || c.status === 'inconclusive' || c.status === 'not-applicable') out.status = c.status;
      if (typeof c.reason === 'string') out.reason = c.reason;
      if (c.source === 'recording' || c.source === 'live') out.source = c.source;
      const count = int(c.count);
      const of = int(c.of);
      if (count !== null && of !== null) {
        out.count = count;
        out.of = of;
      }
      const detail = str(c.detail);
      if (detail) out.detail = detail;
      return out;
    });
}

function normalizeIntervention(v: unknown): Intervention | null {
  if (!isObject(v) || typeof v.flag !== 'string') return null;
  return { flag: v.flag, value: str(v.value), callNo: int(v.callNo) };
}

const STATUSES: ReadonlyArray<RunStateView['status']> = ['running', 'completed', 'failed', 'crashed'];

/** An outcome as the server classifies a run (`RunOutcome`), or null for anything else. */
export function normalizeOutcome(v: unknown): RunOutcomeView | null {
  if (!isObject(v)) return null;
  switch (v.kind) {
    case 'running':
    case 'clean':
    case 'none':
      return { kind: v.kind };
    case 'diverged':
    case 'lost':
      return int(v.callNo) !== null ? { kind: v.kind, callNo: int(v.callNo)! } : null;
    case 'check-failed':
    case 'inconclusive':
      return { kind: v.kind, check: str(v.check) };
    case 'passed': {
      const notApplicable = int(v.notApplicable);
      return int(v.checks) !== null ? { kind: 'passed', checks: int(v.checks)!, ...(notApplicable ? { notApplicable } : {}) } : null;
    }
    default:
      return null;
  }
}

/** How a run stands, as the run endpoint says it (runs-list.ts `runState`); null when it says nothing usable. */
export function normalizeState(v: unknown): RunStateView | null {
  if (!isObject(v) || !STATUSES.includes(v.status as RunStateView['status']) || typeof v.failed !== 'boolean') return null;
  const outcome = normalizeOutcome(v.outcome);
  if (!outcome) return null;
  return { status: v.status as RunStateView['status'], kind: str(v.kind) ?? '', outcome, failed: v.failed, interrupted: v.interrupted === true, label: str(v.label) ?? '' };
}

export function normalizeRunDetail(d: RunDetail): RunDetail {
  const out: RunDetail = { ...d, actions: normalizeActions(d.actions) };
  if (d.state !== undefined) out.state = normalizeState(d.state);
  const forkAt = int(d.forkAt) ?? d.run.divergence?.callNo ?? null;
  if (d.cache !== undefined) {
    out.cache = isObject(d.cache)
      ? { readShare: num(d.cache.readShare), misses: (Array.isArray(d.cache.misses) ? d.cache.misses : []).map(normalizeMiss).filter((m): m is CacheMissView => m !== null) }
      : null;
  }
  if (d.notRecorded !== undefined) out.notRecorded = normalizeNotRecorded(d.notRecorded);
  if (d.rescuedBy !== undefined) {
    // A rescue that does not say which call it asked again forked where this run forked.
    const r = d.rescuedBy;
    out.rescuedBy = isObject(r) && typeof r.runId === 'string' ? { runId: r.runId, callNo: int(r.callNo) ?? forkAt } : null;
  }
  if (d.blame !== undefined) out.blame = normalizeBlame(d.blame);
  if (d.checks !== undefined) out.checks = normalizeChecks(d.checks);
  if (d.intervention !== undefined) out.intervention = normalizeIntervention(d.intervention);
  if (d.notWaitedMs !== undefined) out.notWaitedMs = num(d.notWaitedMs);
  if (d.forkAt !== undefined) out.forkAt = int(d.forkAt);
  if (d.attemptPlace !== undefined) {
    const p: unknown = d.attemptPlace;
    const k = isObject(p) ? int(p.k) : null;
    const n = isObject(p) ? int(p.n) : null;
    out.attemptPlace = k !== null && n !== null && k >= 1 && k <= n ? { k, n } : null;
  }
  if (d.fix !== undefined) {
    const f = normalizeFix(d.fix);
    out.fix = f.fix;
    if (f.role) out.fixRole = f.role;
    if (f.expect !== undefined) out.blameExpect = f.expect;
    if (f.probe) out.probeOf = f.probe;
    if (f.verify) out.verifyOf = f.verify;
    // The run page's own blame wins; the fix adds what asking again did, or the blame when there is none.
    if (f.blame) out.blame = out.blame ? { ...out.blame, short: out.blame.short ?? f.blame.short ?? null } : f.blame;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- actions

/**
 * An action as the fork menu reads it. `group: null` means the action has a place of its own (the
 * header's Replay, Share's Pack, a banner's normalizer) and stays out of the menu; a server that
 * sends no `group` at all leaves the menu to sort its actions by key.
 */
export function normalizeAction(a: ActionItem): ActionItem {
  const out: ActionItem = { key: a.key, label: a.label, opensRun: a.opensRun, prompt: a.prompt, disabled: a.disabled ?? null };
  const flag = str(a.flag);
  if (flag) out.flag = flag;
  if (a.group === 'call' || a.group === 'run' || a.group === null) out.group = a.group;
  const hint = str(a.hint);
  if (hint) out.hint = hint;
  if (a.prompt) {
    const prompt: NonNullable<ActionItem['prompt']> = { label: a.prompt.label };
    if (typeof a.prompt.placeholder === 'string') prompt.placeholder = a.prompt.placeholder;
    if (typeof a.prompt.initial === 'string') prompt.initial = a.prompt.initial;
    // A choice with a field of its own (`text`) keeps it: "error, with a message" asks for the message.
    const choices = (Array.isArray(a.prompt.choices) ? (a.prompt.choices as unknown[]) : [])
      .filter((c): c is Record<string, unknown> => isObject(c) && typeof c.value === 'string' && typeof c.label === 'string')
      .map((c): PromptChoice => {
        const text = str(c.text)?.trim();
        return text ? { value: c.value as string, label: c.label as string, text } : { value: c.value as string, label: c.label as string };
      });
    if (choices.length) prompt.choices = choices;
    out.prompt = prompt;
  }
  return out;
}

export function normalizeActions(list: readonly ActionItem[] | null | undefined): ActionItem[] {
  return Array.isArray(list) ? list.filter((a) => isObject(a) && typeof a.key === 'string' && typeof a.label === 'string').map(normalizeAction) : [];
}

export function normalizeCallDetail(d: CallDetail): CallDetail {
  return { ...d, actions: normalizeActions(d.actions) };
}
