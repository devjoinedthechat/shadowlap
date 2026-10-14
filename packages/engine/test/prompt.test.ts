import { describe, expect, it } from 'vitest';
import { fingerprintApi, normalizersHash } from '../src/fingerprint.js';
import { withoutPrompt } from '../src/prompt.js';

describe('withoutPrompt', () => {
  it('drops system instructions and tool definitions in every provider shape, and nothing else', () => {
    expect(withoutPrompt({ model: 'm', system: 'S', tools: [{ name: 't' }], messages: [{ role: 'user', content: 'hi' }] })).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(withoutPrompt({ model: 'm', tools: [], messages: [{ role: 'system', content: 'S' }, { role: 'developer', content: 'D' }, { role: 'user', content: 'hi' }] })).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(withoutPrompt({ model: 'm', instructions: 'S', input: [{ role: 'developer', content: 'D' }, { role: 'user', content: 'hi' }] })).toEqual({ model: 'm', input: [{ role: 'user', content: 'hi' }] });
    expect(withoutPrompt({ systemInstruction: { parts: [{ text: 'S' }] }, tools: [{ functionDeclarations: [] }], contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })).toEqual({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(withoutPrompt({ system: [{ text: 'S' }], toolConfig: { tools: [] }, messages: [{ role: 'user', content: [{ text: 'hi' }] }] })).toEqual({ messages: [{ role: 'user', content: [{ text: 'hi' }] }] });
    expect(withoutPrompt('raw')).toBe('raw');
  });

  it('makes requests that differ only in their prompt match, and marks the fingerprints it produced', () => {
    const req = (system: string, content = 'hi') => ({ method: 'POST', path: '/v1/messages', headers: {}, body: { model: 'm', system, messages: [{ role: 'user', content }] } });
    expect(fingerprintApi(req('old'), [], [], undefined, { withoutPrompt: true }).fingerprint).toBe(fingerprintApi(req('new'), [], [], undefined, { withoutPrompt: true }).fingerprint);
    expect(fingerprintApi(req('old'), [], [], undefined, { withoutPrompt: true }).fingerprint).not.toBe(fingerprintApi(req('old', 'bye'), [], [], undefined, { withoutPrompt: true }).fingerprint);
    expect(normalizersHash([], 'auto', true)).not.toBe(normalizersHash([], 'auto'));
  });
});
