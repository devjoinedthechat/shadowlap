import { describe, expect, it } from 'vitest';
import { hiddenCharacter, hiddenCharacterWords } from '../src/index.js';

/** A check the team store can't keep as it is: `shadowlap fix check` and `blame --expect` refuse it, naming the character and where it sits. */

describe('a hidden character in a check', () => {
  it('finds one in a value or a key, with where it sits, and lets a value run over lines', () => {
    expect(hiddenCharacter({ tools: { send_email: { args: { to: 'a​@example.com' } } } })).toEqual({ codePoint: 'U+200B', path: 'tools.send_email.args.to', position: 2, inKey: false });
    expect(hiddenCharacter({ calls: [{ tool: 'x', args: { 'the body': 'ok\u0007' } }] })).toEqual({ codePoint: 'U+0007', path: 'calls[0].args["the body"]', position: 3, inKey: false });
    expect(hiddenCharacter({ tools: { ['issue‮refund']: 0 } })).toEqual({ codePoint: 'U+202E', path: 'tools', position: 6, inKey: true });
    // A tab or a line break is text, in a value; in a key it is refused, as a pull refuses it.
    expect(hiddenCharacter({ output: { includes: 'line one\nline two\tend' } })).toBeNull();
    expect(hiddenCharacter({ 'a\tb': 1 })).toMatchObject({ codePoint: 'U+0009', path: '', inKey: true });
    expect(hiddenCharacter(null)).toBeNull();
  });

  it('says which character and where, and that nothing changed', () => {
    expect(hiddenCharacterWords({ codePoint: 'U+200B', path: 'tools.send_email.args.to', position: 2, inKey: false })).toBe('The check holds a hidden character, U+200B, at position 2 of tools.send_email.args.to: remove it. Nothing changed.');
    expect(hiddenCharacterWords({ codePoint: 'U+0009', path: '', position: 2, inKey: true }, '--expect')).toBe('--expect holds a hidden character, U+0009, at position 2 of a key at its top: remove it. Nothing changed.');
  });
});
