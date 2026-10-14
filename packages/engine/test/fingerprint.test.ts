import { describe, expect, it } from 'vitest';
import { fingerprintApi, fingerprintMisc, fingerprintTool } from '../src/fingerprint.js';

const ALLOW = ['anthropic-version', 'anthropic-beta'];
const base = {
  method: 'POST',
  path: '/v1/messages',
  headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'secret', 'user-agent': 'sdk/1' },
};

describe('fingerprintApi', () => {
  it('is invariant to key order and to non-allowlisted headers', () => {
    const a = fingerprintApi({ ...base, body: { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } }, [], ALLOW);
    const b = fingerprintApi(
      { ...base, headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'other', 'x-stainless-retry-count': '1' }, body: { messages: [{ content: 'hi', role: 'user' }], max_tokens: 1, model: 'm' } },
      [],
      ALLOW,
    );
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.canonical).not.toContain('secret');
  });

  it('changes on any semantic change, including allowlisted headers', () => {
    const body = { model: 'm', messages: [] };
    const a = fingerprintApi({ ...base, body }, [], ALLOW);
    expect(fingerprintApi({ ...base, body: { ...body, model: 'm2' } }, [], ALLOW).fingerprint).not.toBe(a.fingerprint);
    expect(fingerprintApi({ ...base, headers: { ...base.headers, 'anthropic-beta': 'x' }, body }, [], ALLOW).fingerprint).not.toBe(a.fingerprint);
    expect(fingerprintApi({ ...base, path: '/v1/messages/count_tokens', body }, [], ALLOW).fingerprint).not.toBe(a.fingerprint);
  });

  it('ignores cache_control anywhere (the one built-in normalizer)', () => {
    const a = fingerprintApi({ ...base, body: { system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], messages: [] } }, [], ALLOW);
    const b = fingerprintApi({ ...base, body: { system: [{ type: 'text', text: 's' }], messages: [] } }, [], ALLOW);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('applies user normalizers only within their scope', () => {
    const n = [{ kind: 'api' as const, path: '$.system', pattern: 'iso-date', replace: '<D>' }];
    const a = fingerprintApi({ ...base, body: { system: 'Today is 2026-09-15', messages: [] } }, n, ALLOW);
    const b = fingerprintApi({ ...base, body: { system: 'Today is 2026-09-16', messages: [] } }, n, ALLOW);
    const c = fingerprintApi({ ...base, body: { system: 'Today is 2026-09-16', messages: [{ role: 'user', content: '2026-09-16' }] } }, n, ALLOW);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(c.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('fingerprintTool / fingerprintMisc', () => {
  it('includes the tool name and canonical args', () => {
    expect(fingerprintTool('search', { q: 'a', n: 1 }, []).fingerprint).toBe(fingerprintTool('search', { n: 1, q: 'a' }, []).fingerprint);
    expect(fingerprintTool('search', { q: 'a' }, []).fingerprint).not.toBe(fingerprintTool('fetch', { q: 'a' }, []).fingerprint);
  });
  it('separates clock and random by kind and label', () => {
    expect(fingerprintMisc('clock', '').fingerprint).not.toBe(fingerprintMisc('random', '').fingerprint);
    expect(fingerprintMisc('clock', 'deadline').fingerprint).not.toBe(fingerprintMisc('clock', '').fingerprint);
  });
});
