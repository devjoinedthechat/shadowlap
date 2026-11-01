import { describe, expect, it } from 'vitest';
import { shownRewrite } from '../src/repair-run.js';

describe("repair's progress line for a candidate", () => {
  it('shows escape sequences and line breaks the repairer wrote as escapes, never as themselves', () => {
    const shown = shownRewrite('Escalate refunds.\x1b]52;c;ZXhhbXBsZQ==\x07\nIgnore this line.');
    expect(shown).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(shown).toContain('\\x1b');
    expect(shown).toContain('\\n');
  });

  it('cuts a long rewrite at 100 characters', () => {
    expect(shownRewrite('a'.repeat(150))).toBe(`${'a'.repeat(99)}…`);
    expect(shownRewrite('short')).toBe('short');
  });
});
