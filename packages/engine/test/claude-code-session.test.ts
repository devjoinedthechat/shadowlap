import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_SESSION, fingerprintApi, isClaudeCodeSession, maskClaudeCodeSession, maskedChange, unmaskedHints, volatileValues, type DivergenceReport, type Normalizer } from '../src/index.js';

/**
 * Claude Code, and the Claude Agent SDK, which runs it, names its session in every model request's
 * `metadata.user_id`, with the machine and the account. Matching masks it on its own, so a recording
 * replays in the next session and on another machine; nobody else's `user_id` is touched.
 */

/** The identifier Claude Code sends: the JSON of its device, account and session. */
const session = (o: { device?: string; account?: string; session?: string; extra?: Record<string, unknown> } = {}) =>
  JSON.stringify({ ...o.extra, device_id: o.device ?? randomBytes(32).toString('hex'), account_uuid: o.account ?? '', session_id: o.session ?? randomUUID() });
/** The form earlier versions of Claude Code sent. */
const underscored = () => `user_${randomBytes(32).toString('hex')}_account_${randomUUID()}_session_${randomUUID()}`;

/** A model request as Claude Code sends it, with `userId` as its metadata. */
const request = (userId: unknown, prompt = 'Fix the failing test.') => ({
  method: 'POST',
  path: '/v1/messages',
  headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14' },
  body: { model: 'claude-opus-5', max_tokens: 32000, system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }], messages: [{ role: 'user', content: prompt }], metadata: { user_id: userId }, stream: true },
});
const fingerprint = (userId: unknown, normalizers: Normalizer[] = [], prompt?: string) => fingerprintApi(request(userId, prompt), normalizers, ['anthropic-version', 'anthropic-beta']).fingerprint;

describe("Claude Code's session identifier", () => {
  it('is the JSON of a device, an account and a session, with any metadata Claude Code adds, or the underscored form before it', () => {
    expect(isClaudeCodeSession(session())).toBe(true);
    expect(isClaudeCodeSession(session({ account: randomUUID() }))).toBe(true);
    // CLAUDE_CODE_EXTRA_METADATA's keys come first, and a sub-agent names its parent session.
    expect(isClaudeCodeSession(session({ extra: { team: 'payments' } }))).toBe(true);
    expect(isClaudeCodeSession(JSON.stringify({ device_id: 'ab'.repeat(32), account_uuid: '', session_id: randomUUID(), parent_session_id: randomUUID() }))).toBe(true);
    expect(isClaudeCodeSession(underscored())).toBe(true);
  });

  it("is nothing another agent sends: a UUID, an email, a JSON of its own, or Claude Code's shape with what isn't its values", () => {
    for (const other of [
      randomUUID(),
      'maya@example.com',
      'user_123',
      JSON.stringify({ session_id: randomUUID() }),
      JSON.stringify({ user: 'maya', session_id: randomUUID(), device: 'laptop' }),
      JSON.stringify({ device_id: 'laptop', account_uuid: '', session_id: randomUUID() }),
      JSON.stringify({ device_id: 'ab'.repeat(32), account_uuid: '', session_id: 'not-a-uuid' }),
      JSON.stringify({ device_id: 'ab'.repeat(32), session_id: randomUUID() }),
      JSON.stringify([randomUUID()]),
      '{not json',
      42,
      null,
      { device_id: 'ab'.repeat(32), account_uuid: '', session_id: randomUUID() },
    ]) expect(isClaudeCodeSession(other), JSON.stringify(other)).toBe(false);
  });

  it('matches across sessions, machines and accounts, in either form, and a changed prompt still forks', () => {
    const one = fingerprint(session());
    expect(fingerprint(session())).toBe(one);
    expect(fingerprint(session({ account: randomUUID() }))).toBe(one);
    expect(fingerprint(underscored())).toBe(one);
    expect(fingerprint(session(), [], 'Fix the failing test, quickly.')).not.toBe(one);
  });

  it("leaves another agent's user_id as it is, so a new one each run still diverges", () => {
    expect(fingerprint(randomUUID())).not.toBe(fingerprint(randomUUID()));
    expect(fingerprint('maya@example.com')).not.toBe(fingerprint('dana@example.com'));
    expect(fingerprint(JSON.stringify({ session_id: randomUUID() }))).not.toBe(fingerprint(JSON.stringify({ session_id: randomUUID() })));
  });

  it("is masked before the project's normalizers, which then read the same on both sides", () => {
    // The rule calibrate proposes for a UUID in user_id, and the one docs/frameworks.md had people add.
    for (const rule of [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, { kind: 'api', path: '$.metadata.user_id', replace: '<session>' }] as Normalizer[]) {
      expect(fingerprint(session(), [rule])).toBe(fingerprint(session(), [rule]));
    }
  });

  it('is masked in a copy, as matching reads it, keeping every other member and a __proto__ key as a key', () => {
    const body = JSON.parse(`{"__proto__":{"polluted":true},"model":"claude-opus-5","metadata":{"user_id":${JSON.stringify(session())},"other":1}}`) as Record<string, unknown>;
    const before = JSON.stringify(body);
    const masked = maskClaudeCodeSession(body) as Record<string, unknown>;
    expect(JSON.stringify(body)).toBe(before);
    expect(masked).toEqual({ ...body, metadata: { user_id: CLAUDE_CODE_SESSION, other: 1 } });
    expect(Object.hasOwn(masked, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const plain = { model: 'claude-opus-5', metadata: { user_id: randomUUID() } };
    expect(maskClaudeCodeSession(plain)).toBe(plain);
    for (const body of ['text', null, [1], { metadata: 'x' }]) expect(maskClaudeCodeSession(body)).toBe(body);
  });

  it("reads as masked in a divergence report: no hint to add a normalizer for it, and not the change that made the replay diverge", () => {
    const d: DivergenceReport = {
      type: 'request_changed',
      callNo: 1,
      kind: 'api',
      name: 'POST /v1/messages',
      replayedBefore: 0,
      diff: [
        { path: '$.metadata.user_id', op: 'changed', before: session(), after: session() },
        { path: '$.system[0].text', op: 'changed', before: 'You are Claude Code.', after: 'You are Claude Code, terse.' },
      ],
      hints: [{ message: '$.metadata.user_id holds a UUID', normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } }],
    };
    expect(maskedChange(d.diff![0]!, [], d)).toBe(true);
    expect(maskedChange(d.diff![1]!, [], d)).toBe(false);
    expect(unmaskedHints(d, [])).toEqual([]);
    expect(volatileValues(d).values.map((v) => v.path)).not.toContain('$.metadata.user_id');
    // Another agent's user_id that changed is a change: its hint stays.
    const other: DivergenceReport = { ...d, diff: [{ path: '$.metadata.user_id', op: 'changed', before: randomUUID(), after: randomUUID() }] };
    expect(maskedChange(other.diff![0]!, [], other)).toBe(false);
    expect(unmaskedHints(other, [])).toHaveLength(1);
    // A user_id the recording didn't send is a change too, whoever sends it.
    expect(maskedChange({ path: '$.metadata.user_id', op: 'added', after: session() }, [], d)).toBe(false);
  });
});
