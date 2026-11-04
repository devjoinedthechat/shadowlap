import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseExpect } from '@shadowlap/engine';

// The pages later slices replace say how to do it in the CLI today: the commands they show must be
// ones the CLI takes as they are written.

const page = (name: string) => readFileSync(new URL(`../ui/pages/${name}.tsx`, import.meta.url), 'utf8');

describe('the Fixes page’s command', () => {
  it('gives blame an expect object the CLI takes, not a sentence', () => {
    const value = /--expect '([^']+)'/.exec(page('Fixes'))?.[1];
    expect(value).toBeDefined();
    expect(() => parseExpect(JSON.parse(value!), '--expect')).not.toThrow();
    expect(parseExpect(JSON.parse(value!), '--expect').tools.map((t) => t.name)).toEqual(['send_email']);
  });
});
