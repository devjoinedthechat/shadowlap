import * as engine from '@shadowlap/engine';
import { describe, expect, it } from 'vitest';
import * as chaosConfig from '../src/chaos-config.js';
import * as checks from '../src/checks.js';

// The CLI's modules import checks from checks.ts and a golden's presets from chaos-config.ts, and the
// dashboard takes the same from the engine. Both CLI files only re-export the engine's, so a check is
// read, labelled and judged one way wherever it is.

describe('the CLI’s checks', () => {
  it('are the engine’s own, with no copy of the grammar, the parser or the evaluator in the CLI', () => {
    const exported: Array<[string, unknown]> = [...Object.entries(checks), ...Object.entries(chaosConfig)];
    expect(exported.length).toBeGreaterThan(40);
    for (const [name, value] of exported) expect(value, name).toBe((engine as Record<string, unknown>)[name]);
  });

  it('read a preset’s expect with the engine’s parser when none is given, as the CLI passes it', () => {
    const raw = { expect: { tools: { issue_refund: '<= 1' } } };
    expect(chaosConfig.parseChaosFields(raw, 'tests["g"].chaos')).toEqual(chaosConfig.parseChaosFields(raw, 'tests["g"].chaos', checks.parseExpect));
  });
});
