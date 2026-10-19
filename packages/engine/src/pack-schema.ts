import type { CallEndRow, CallRecord, RunRecord } from './types.js';

/**
 * Validation for packs, which are untrusted input: someone else's recording, a file attached to an
 * issue, a golden from a pull request. Every field is checked for type, range and shape before
 * anything reaches the store, so a pack cannot plant an id that later becomes a path, a string that
 * rewrites the terminal, or a record the replay engine was never meant to read.
 */

export class PackError extends Error {}

export const PACK_LIMITS = {
  /** Largest single blob. */
  blobBytes: 256 * 1024 * 1024,
  /** All blobs together. */
  totalBytes: 4 * 1024 * 1024 * 1024,
  manifestBytes: 16 * 1024 * 1024,
  callsBytes: 1024 * 1024 * 1024,
  runs: 10_000,
  calls: 1_000_000,
  argv: 256,
  stringBytes: 16 * 1024,
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** C0 and C1 control characters: never legitimate in ids or names, and dangerous in a terminal. */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * The same but tabs and line breaks, which a command line may hold (`python -c '…'`, `node -e`
 * with a script) and its folder too: every terminal shows them escaped (safeLine).
 */
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const KINDS = new Set(['api', 'tool', 'clock', 'random']);
const ORIGINS = new Set(['live', 'replayed', 'blocked', 'stubbed', 'overridden']);
const EFFECTS = new Set(['pure', 'read', 'write']);
const MODES = new Set(['record', 'replay']);
const STATUSES = new Set(['running', 'completed', 'failed', 'crashed']);
const OUTCOMES = new Set(['ok', 'error']);
const DIVERGENCES = new Set(['request_changed', 'new_call', 'forced', 'beyond_recording', 'ended_early']);
const BLAME_OUTCOMES = new Set(['blamed', 'unrescuable', 'stopped']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How far ahead of this machine's clock a recorded time may be: another machine's clock may run fast. */
const FUTURE_ALLOWANCE_MS = 24 * 60 * 60 * 1000;

function fail(where: string, what: string): never {
  throw new PackError(`${where}: ${what}`);
}

function text(v: unknown, where: string, max = PACK_LIMITS.stringBytes, control = CONTROL): string {
  if (typeof v !== 'string') fail(where, 'must be a string');
  if (v.length > max) fail(where, `is longer than ${max} characters`);
  if (control.test(v)) fail(where, 'contains control characters');
  return v;
}

function int(v: unknown, where: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) fail(where, `must be an integer ≥ ${min}`);
  return v;
}

/** A time recorded somewhere: never further ahead of this machine's clock than another's could be. */
function time(v: unknown, where: string): number {
  const at = int(v, where);
  if (at > Date.now() + FUTURE_ALLOWANCE_MS) fail(where, 'is more than a day in the future');
  return at;
}

function oneOf(v: unknown, set: Set<string>, where: string): string {
  if (typeof v !== 'string' || !set.has(v)) fail(where, `must be one of ${[...set].join(', ')}`);
  return v;
}

function ref(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !HEX64.test(v)) fail(where, 'must be a SHA-256 blob hash');
  return v;
}

function meta(v: unknown, where: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (!isObject(v)) fail(where, 'must be an object');
  return v;
}

export function validateRun(v: unknown, where: string): RunRecord {
  if (!isObject(v)) fail(where, 'must be an object');
  if (typeof v.runId !== 'string' || !ULID.test(v.runId)) fail(`${where}.runId`, 'must be a run id (26 characters, Crockford base32)');
  if (v.parentRunId !== null && v.parentRunId !== undefined && (typeof v.parentRunId !== 'string' || !ULID.test(v.parentRunId))) fail(`${where}.parentRunId`, 'must be a run id or null');
  oneOf(v.mode, MODES, `${where}.mode`);
  oneOf(v.status, STATUSES, `${where}.status`);
  if (!isObject(v.command)) fail(`${where}.command`, 'must be an object');
  const argv = v.command.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > PACK_LIMITS.argv) fail(`${where}.command.argv`, `must be 1 to ${PACK_LIMITS.argv} strings`);
  argv.forEach((a, i) => text(a, `${where}.command.argv[${i}]`, 8192, CONTROL_BUT_LINES));
  text(v.command.cwd, `${where}.command.cwd`, 4096, CONTROL_BUT_LINES);
  if (v.codeVersion !== null && v.codeVersion !== undefined) text(v.codeVersion, `${where}.codeVersion`, 128);
  time(v.startedAt, `${where}.startedAt`);
  if (v.endedAt !== null && v.endedAt !== undefined) time(v.endedAt, `${where}.endedAt`);
  if (v.divergence !== null && v.divergence !== undefined) {
    const d = v.divergence;
    if (!isObject(d)) fail(`${where}.divergence`, 'must be an object or null');
    oneOf(d.type, DIVERGENCES, `${where}.divergence.type`);
    int(d.callNo, `${where}.divergence.callNo`, 1);
    oneOf(d.kind, KINDS, `${where}.divergence.kind`);
    text(d.name, `${where}.divergence.name`, 512);
    int(d.replayedBefore, `${where}.divergence.replayedBefore`);
    if (d.diff !== undefined && (!Array.isArray(d.diff) || d.diff.length > 10_000)) fail(`${where}.divergence.diff`, 'must be an array of at most 10000 entries');
    for (const [i, e] of ((d.diff as unknown[] | undefined) ?? []).entries()) {
      if (!isObject(e)) fail(`${where}.divergence.diff[${i}]`, 'must be an object');
      text(e.path, `${where}.divergence.diff[${i}].path`, 4096);
      oneOf(e.op, new Set(['changed', 'added', 'removed']), `${where}.divergence.diff[${i}].op`);
    }
    if (d.hints !== undefined && !Array.isArray(d.hints)) fail(`${where}.divergence.hints`, 'must be an array');
    for (const [i, h] of ((d.hints as unknown[] | undefined) ?? []).entries()) {
      if (!isObject(h)) fail(`${where}.divergence.hints[${i}]`, 'must be an object');
      text(h.message, `${where}.divergence.hints[${i}].message`, 2048);
    }
    if (d.reason !== undefined) text(d.reason, `${where}.divergence.reason`, 2048);
    if (d.recorded !== undefined) int(d.recorded, `${where}.divergence.recorded`);
  }
  const m = meta(v.meta, `${where}.meta`);
  // Labels and notes are shown in terminals and dashboards and used to select runs: checked like any text.
  if (m.labels !== undefined) {
    if (!Array.isArray(m.labels) || m.labels.length > 50) fail(`${where}.meta.labels`, 'must be an array of at most 50 labels');
    for (const [i, l] of m.labels.entries()) {
      text(l, `${where}.meta.labels[${i}]`, 40);
      if (!/^[\p{L}\p{N}][\p{L}\p{N} _.:/-]*$/u.test(l as string)) fail(`${where}.meta.labels[${i}]`, 'must be letters, digits, spaces and _ . : / -');
    }
  }
  if (m.notes !== undefined) {
    if (!Array.isArray(m.notes) || m.notes.length > 1000) fail(`${where}.meta.notes`, 'must be an array of at most 1000 notes');
    for (const [i, n] of m.notes.entries()) {
      if (!isObject(n)) fail(`${where}.meta.notes[${i}]`, 'must be an object');
      if (n.callNo !== null) int(n.callNo, `${where}.meta.notes[${i}].callNo`);
      if (typeof n.text !== 'string' || n.text.length > 10_000) fail(`${where}.meta.notes[${i}].text`, 'must be a string of at most 10000 characters');
      int(n.at, `${where}.meta.notes[${i}].at`);
    }
  }
  if (m.redactions !== undefined) {
    if (!Array.isArray(m.redactions) || m.redactions.length > 1000) fail(`${where}.meta.redactions`, 'must be an array of at most 1000 rules');
    for (const [i, rule] of m.redactions.entries()) {
      if (!isObject(rule)) fail(`${where}.meta.redactions[${i}]`, 'must be an object');
      for (const k of ['kind', 'name', 'path', 'pattern'] as const) if (rule[k] !== undefined) text(rule[k], `${where}.meta.redactions[${i}].${k}`, 2048);
      if (typeof rule.replace !== 'string' || rule.replace.length > 2048) fail(`${where}.meta.redactions[${i}].replace`, 'must be a string');
    }
  }
  if (m.blame !== undefined) validateBlame(m.blame, `${where}.meta.blame`);
  return v as unknown as RunRecord;
}

/**
 * What the run's last blame found (BlameRecord), as `shadowlap blame` writes it: the run page,
 * Fixes, `show`, and the copies made from the run read every field of it.
 */
function validateBlame(b: unknown, where: string): void {
  if (!isObject(b)) fail(where, 'must be an object');
  int(b.at, `${where}.at`);
  oneOf(b.outcome, BLAME_OUTCOMES, `${where}.outcome`);
  if (b.callNo !== null) int(b.callNo, `${where}.callNo`, 1);
  oneOf(b.confidence, CONFIDENCES, `${where}.confidence`);
  if (b.rescuedRunId !== null && (typeof b.rescuedRunId !== 'string' || !ULID.test(b.rescuedRunId))) fail(`${where}.rescuedRunId`, 'must be a run id or null');
  if (!isObject(b.fields)) fail(`${where}.fields`, 'must be an object');
  if (b.scope !== undefined && (typeof b.scope !== 'string' || b.scope.length > 512)) fail(`${where}.scope`, 'must be a string of at most 512 characters');
  // What the attempts were judged by, in words (`output includes "…"`): text a person wrote, as a note is.
  if (!Array.isArray(b.oracle) || b.oracle.length > 1000) fail(`${where}.oracle`, 'must be an array of at most 1000 checks');
  for (const [i, o] of b.oracle.entries()) if (typeof o !== 'string' || o.length > 10_000) fail(`${where}.oracle[${i}]`, 'must be a string of at most 10000 characters');
  if (!Array.isArray(b.probes) || b.probes.length > 10_000) fail(`${where}.probes`, 'must be an array of at most 10000 probes');
  for (const [i, p] of b.probes.entries()) {
    if (!isObject(p)) fail(`${where}.probes[${i}]`, 'must be an object');
    int(p.callNo, `${where}.probes[${i}].callNo`, 1);
    int(p.passes, `${where}.probes[${i}].passes`);
    int(p.attempts, `${where}.probes[${i}].attempts`);
    if (typeof p.rescued !== 'boolean') fail(`${where}.probes[${i}].rescued`, 'must be true or false');
  }
  if (typeof b.spent !== 'number' || !Number.isFinite(b.spent) || b.spent < 0) fail(`${where}.spent`, 'must be a number ≥ 0');
}

function validateEnd(v: unknown, where: string, runId: string, callNo: number): CallEndRow {
  if (!isObject(v)) fail(where, 'must be an object');
  if (v.runId !== runId) fail(`${where}.runId`, 'must match the call');
  if (v.callNo !== callNo) fail(`${where}.callNo`, 'must match the call');
  int(v.attempt, `${where}.attempt`);
  ref(v.responseRef, `${where}.responseRef`);
  oneOf(v.outcome, OUTCOMES, `${where}.outcome`);
  meta(v.meta, `${where}.meta`);
  time(v.at, `${where}.at`);
  return v as unknown as CallEndRow;
}

export function validateCall(v: unknown, where: string): CallRecord {
  if (!isObject(v)) fail(where, 'must be an object');
  if (typeof v.runId !== 'string' || !ULID.test(v.runId)) fail(`${where}.runId`, 'must be a run id');
  const callNo = int(v.callNo, `${where}.callNo`, 1);
  oneOf(v.kind, KINDS, `${where}.kind`);
  text(v.name, `${where}.name`, 512);
  if (typeof v.fingerprint !== 'string' || !HEX64.test(v.fingerprint)) fail(`${where}.fingerprint`, 'must be a SHA-256 hex digest');
  int(v.occurrence, `${where}.occurrence`, 1);
  oneOf(v.origin, ORIGINS, `${where}.origin`);
  if (v.effect !== null && v.effect !== undefined) oneOf(v.effect, EFFECTS, `${where}.effect`);
  ref(v.requestRef, `${where}.requestRef`);
  meta(v.meta, `${where}.meta`);
  time(v.at, `${where}.at`);
  if (v.end !== null && v.end !== undefined) validateEnd(v.end, `${where}.end`, v.runId, callNo);
  if (!Array.isArray(v.attempts)) fail(`${where}.attempts`, 'must be an array');
  v.attempts.forEach((a, i) => validateEnd(a, `${where}.attempts[${i}]`, v.runId as string, callNo));
  return v as unknown as CallRecord;
}

/** Every blob a call points at directly. */
export function callRefs(call: CallRecord): string[] {
  const refs: string[] = [];
  if (call.requestRef) refs.push(call.requestRef);
  if (call.end?.responseRef) refs.push(call.end.responseRef);
  for (const a of call.attempts) if (a.responseRef) refs.push(a.responseRef);
  return refs;
}
