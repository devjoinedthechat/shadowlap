import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ciProvider } from '@shadowlap/engine';

/** A run a CLI command makes in CI: its author is `ci`, and it says which CI, for the By column. */
describe('a run made in CI', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    delete process.env.SHADOWLAP_AUTHOR;
    process.env.GITHUB_ACTIONS = 'true';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('says which CI made it, beside its author', async () => {
    // Loaded here, after the environment is set: the author is worked out once per process.
    const { newRunMeta } = await import('../src/activity.js');
    const ci = ciProvider(process.env);
    expect(ci).toEqual(expect.any(String));
    expect(newRunMeta()).toEqual({ author: 'ci', ci });
  });
});
